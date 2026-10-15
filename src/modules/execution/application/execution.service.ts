import DLMM, { type LbPosition } from "@meteora-ag/dlmm";
import { PublicKey, type Connection, type Keypair } from "@solana/web3.js";
import type { AgentConfig } from "../../../shared/config";
import { log } from "../../../shared/logger";
import type { ShapeName } from "../../strategy/domain/shape";
import {
  claimFees,
  closeFully,
  loadPool,
  openSolSide,
  quoteOpen,
  valuePosition,
  type OpenQuote,
  type OpenResult,
  type Valuation,
} from "../infrastructure/dlmm.gateway";
import { swapAllToSol } from "../infrastructure/jupiter.client";
import type { TxOptions } from "../infrastructure/tx";

export type { OpenQuote, OpenResult, Valuation };

/** Everything that touches the chain: Meteora DLMM positions and Jupiter swaps. */
export class ExecutionService {
  constructor(
    private readonly cfg: AgentConfig,
    private readonly connection: Connection,
    private readonly user: Keypair,
  ) {}

  /** Read per call: both values can change from the dashboard. */
  private get tx(): TxOptions {
    return { priorityMicroLamports: this.cfg.execution.priorityMicroLamports, maxRetries: this.cfg.execution.maxRetries };
  }

  loadPool(address: string): Promise<DLMM> {
    return loadPool(this.connection, address);
  }

  /** Position pubkey → its pool and on-chain data, for every DLMM position the wallet holds. */
  async onchainPositions(): Promise<Map<string, { dlmmPool: string; position: LbPosition }>> {
    const out = new Map<string, { dlmmPool: string; position: LbPosition }>();
    const all = await DLMM.getAllLbPairPositionsByUser(this.connection, this.user.publicKey);
    for (const [poolAddr, info] of all) {
      for (const pos of info.lbPairPositionsData) out.set(pos.publicKey.toBase58(), { dlmmPool: poolAddr, position: pos });
    }
    return out;
  }

  value(dlmm: DLMM, position: LbPosition): Promise<Valuation> {
    return valuePosition(dlmm, position);
  }

  /** One position by pubkey from its pool: a single account read, more reliable than enumerating all. */
  getPosition(dlmm: DLMM, positionPubkey: string): Promise<LbPosition> {
    return dlmm.getPosition(new PublicKey(positionPubkey));
  }

  claim(dlmm: DLMM, position: LbPosition): Promise<string[]> {
    return claimFees(this.connection, dlmm, this.user, position, this.tx);
  }

  closeFully(dlmm: DLMM, position: LbPosition): Promise<string[]> {
    return closeFully(this.connection, dlmm, this.user, position, this.tx);
  }

  quoteOpen(dlmm: DLMM, bins: number, shape: ShapeName): Promise<OpenQuote> {
    return quoteOpen(dlmm, bins, shape);
  }

  openSolSide(dlmm: DLMM, opts: { sol: number; bins: number; shape: ShapeName }): Promise<OpenResult> {
    return openSolSide(this.connection, dlmm, this.user, { ...opts, slippagePct: this.cfg.execution.slippagePct }, this.tx);
  }

  /** Sell the whole token balance to SOL, widening slippage 2x and 4x on failure. */
  async zapOut(mint: string): Promise<boolean> {
    const ex = this.cfg.execution;
    const priority = Math.ceil((ex.priorityMicroLamports * 400_000) / 1e6);
    for (const slip of [ex.swapSlippageBps, ex.swapSlippageBps * 2, ex.swapSlippageBps * 4]) {
      try {
        const sig = await swapAllToSol(this.connection, this.user, mint, slip, Math.max(priority, 100_000));
        if (sig) log.info(`zap-out ${mint} to SOL sig=${sig}`);
        return true;
      } catch (e) {
        log.warn(`zap-out ${mint} at ${slip}bps failed: ${(e as Error).message}`);
      }
    }
    log.error(`zap-out ${mint} failed after retries, tokens left in wallet`);
    return false;
  }
}
