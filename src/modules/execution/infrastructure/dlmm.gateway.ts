import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import DLMM, { StrategyType, type LbPosition } from "@meteora-ag/dlmm";
import BN from "bn.js";
import { LAMPORTS, SOL_MINT } from "../../../shared/solana/constants";
import type { ShapeName } from "../../strategy/domain/shape";
import { solSideRange, type BinRange } from "../../strategy/domain/range-math";
import { sendLegacy, type TxOptions } from "./tx";

/** Single-tx position init handles at most this many bins; wider uses an extended position. */
const SINGLE_TX_BINS = 69;

export function shapeToEnum(name: ShapeName): StrategyType {
  switch (name) {
    case "Curve":
      return StrategyType.Curve;
    case "BidAsk":
      return StrategyType.BidAsk;
    default:
      return StrategyType.Spot;
  }
}

export async function loadPool(connection: Connection, poolAddress: string): Promise<DLMM> {
  return DLMM.create(connection, new PublicKey(poolAddress));
}

export function solIsX(dlmm: DLMM): boolean {
  return dlmm.tokenX.publicKey.toBase58() === SOL_MINT;
}

export interface OpenResult {
  positionPubkey: string;
  range: BinRange;
  activeBinId: number;
  sigs: string[];
}

/** Open a one-sided SOL position below price with the given shape and bin count. */
export async function openSolSide(
  connection: Connection,
  dlmm: DLMM,
  user: Keypair,
  opts: { sol: number; bins: number; shape: ShapeName; slippagePct: number },
  tx: TxOptions,
): Promise<OpenResult> {
  const active = await dlmm.getActiveBin();
  const isX = solIsX(dlmm);
  const range = solSideRange(active.binId, opts.bins, isX);

  const lamports = new BN(Math.floor(opts.sol * LAMPORTS));
  const totalXAmount = isX ? lamports : new BN(0);
  const totalYAmount = isX ? new BN(0) : lamports;
  const strategy = {
    minBinId: range.minBinId,
    maxBinId: range.maxBinId,
    strategyType: shapeToEnum(opts.shape),
    ...(isX ? { singleSidedX: true } : {}),
  };

  const positionKp = Keypair.generate();
  const sigs: string[] = [];

  if (opts.bins <= SINGLE_TX_BINS) {
    const t = await dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKp.publicKey,
      user: user.publicKey,
      totalXAmount,
      totalYAmount,
      strategy,
      slippage: opts.slippagePct,
    });
    sigs.push(await sendLegacy(connection, t, [user, positionKp], tx));
  } else {
    const create = await dlmm.createExtendedEmptyPosition(
      range.minBinId,
      range.maxBinId,
      positionKp.publicKey,
      user.publicKey,
    );
    sigs.push(await sendLegacy(connection, create, [user, positionKp], tx));
    const adds = await dlmm.addLiquidityByStrategyChunkable({
      positionPubKey: positionKp.publicKey,
      user: user.publicKey,
      totalXAmount,
      totalYAmount,
      strategy,
      slippage: opts.slippagePct,
    });
    for (const a of adds) sigs.push(await sendLegacy(connection, a, [user], tx));
  }

  return { positionPubkey: positionKp.publicKey.toBase58(), range, activeBinId: active.binId, sigs };
}

export interface OpenQuote {
  range: BinRange;
  /** Refundable position rent, SOL. */
  positionCostSol: number;
  /** Non-refundable bin array (+bitmap) rent, SOL. */
  binArrayCostSol: number;
  txCount: number;
}

export async function quoteOpen(dlmm: DLMM, bins: number, shape: ShapeName): Promise<OpenQuote> {
  const active = await dlmm.getActiveBin();
  const range = solSideRange(active.binId, bins, solIsX(dlmm));
  const q = await dlmm.quoteCreatePosition({
    strategy: { minBinId: range.minBinId, maxBinId: range.maxBinId, strategyType: shapeToEnum(shape) },
  });
  return {
    range,
    positionCostSol: q.positionCost + q.positionReallocCost,
    binArrayCostSol: q.binArrayCost + q.bitmapExtensionCost,
    txCount: q.transactionCount,
  };
}

/** Withdraw 100%, claim fees and close the position account (rent comes back). */
export async function closeFully(
  connection: Connection,
  dlmm: DLMM,
  user: Keypair,
  position: LbPosition,
  tx: TxOptions,
): Promise<string[]> {
  const sigs: string[] = [];
  const hasLiquidity = position.positionData.positionBinData.some((b) => b.positionLiquidity !== "0");
  if (hasLiquidity) {
    const txs = await dlmm.removeLiquidity({
      user: user.publicKey,
      position: position.publicKey,
      fromBinId: position.positionData.lowerBinId,
      toBinId: position.positionData.upperBinId,
      bps: new BN(10_000),
      shouldClaimAndClose: true,
    });
    for (const t of txs) sigs.push(await sendLegacy(connection, t, [user], tx));
  } else {
    const t = await dlmm.closePositionIfEmpty({ owner: user.publicKey, position });
    sigs.push(await sendLegacy(connection, t, [user], tx));
  }
  return sigs;
}

export async function claimFees(
  connection: Connection,
  dlmm: DLMM,
  user: Keypair,
  position: LbPosition,
  tx: TxOptions,
): Promise<string[]> {
  const txs = await dlmm.claimSwapFee({ owner: user.publicKey, position });
  const sigs: string[] = [];
  for (const t of txs) sigs.push(await sendLegacy(connection, t, [user], tx));
  return sigs;
}

export interface Valuation {
  /** Liquidity value in SOL (excluding unclaimed fees). */
  liquiditySol: number;
  /** Unclaimed fees in SOL. */
  feesSol: number;
  /** Fees in SOL (quote) vs in token, both valued in SOL. */
  feesInTokenSol: number;
  priceSolPerToken: number;
  activeBinId: number;
}

/** Value a live position in SOL at the pool's active-bin price. */
export async function valuePosition(dlmm: DLMM, position: LbPosition): Promise<Valuation> {
  const active = await dlmm.getActiveBin();
  const isX = solIsX(dlmm);
  // pricePerToken = UI price of X in Y.
  const pxY = Number(active.pricePerToken);
  const dx = 10 ** dlmm.tokenX.mint.decimals;
  const dy = 10 ** dlmm.tokenY.mint.decimals;
  const p = position.positionData;
  const x = Number(p.totalXAmount) / dx;
  const y = Number(p.totalYAmount) / dy;
  const fx = Number(p.feeX.toString()) / dx;
  const fy = Number(p.feeY.toString()) / dy;

  if (isX) {
    // SOL = X, token = Y. Token in SOL = 1 / pxY.
    const tokenInSol = pxY > 0 ? 1 / pxY : 0;
    return {
      liquiditySol: x + y * tokenInSol,
      feesSol: fx + fy * tokenInSol,
      feesInTokenSol: fy * tokenInSol,
      priceSolPerToken: tokenInSol,
      activeBinId: active.binId,
    };
  }
  return {
    liquiditySol: y + x * pxY,
    feesSol: fy + fx * pxY,
    feesInTokenSol: fx * pxY,
    priceSolPerToken: pxY,
    activeBinId: active.binId,
  };
}
