import { SOL_MINT } from "../../../shared/solana/constants";
import { log } from "../../../shared/logger";
import type { ExecutionService } from "../../execution/application/execution.service";
import { fetchPool } from "../../screening/infrastructure/meteora-data.client";

export interface OnchainPositionView {
  positionPubkey: string;
  poolAddress: string;
  poolName: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  binStep: number | null;
  lowerBinId: number;
  upperBinId: number;
  bins: number;
  activeBinId: number;
  /** SOL per token. */
  priceSolPerToken: number;
  liquiditySol: number;
  feesSol: number;
  valueSol: number;
}

/**
 * Read-only view of the wallet's real DLMM positions, including ones opened by
 * hand that the bot does not track. A short cache keeps the dashboard poll cheap.
 */
export class OnchainPositions {
  private cache: { at: number; rows: OnchainPositionView[] } | null = null;

  constructor(
    private readonly execution: ExecutionService,
    private readonly ttlMs = 15_000,
  ) {}

  async execute(): Promise<OnchainPositionView[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.rows;

    const onchain = await this.execution.onchainPositions();
    const rows = await Promise.all(
      [...onchain.entries()].map(async ([pubkey, hit]) => {
        try {
          const dlmm = await this.execution.loadPool(hit.dlmmPool);
          const v = await this.execution.value(dlmm, hit.position);
          const pool = await fetchPool(hit.dlmmPool).catch(() => null);
          const d = hit.position.positionData;
          const solIsX = dlmm.tokenX.publicKey.toBase58() === SOL_MINT;
          return {
            positionPubkey: pubkey,
            poolAddress: hit.dlmmPool,
            poolName: pool?.name ?? hit.dlmmPool.slice(0, 8),
            tokenXSymbol: pool?.token_x.symbol ?? (solIsX ? "SOL" : "?"),
            tokenYSymbol: pool?.token_y.symbol ?? (solIsX ? "?" : "SOL"),
            binStep: pool?.pool_config.bin_step ?? null,
            lowerBinId: d.lowerBinId,
            upperBinId: d.upperBinId,
            bins: d.upperBinId - d.lowerBinId + 1,
            activeBinId: v.activeBinId,
            priceSolPerToken: v.priceSolPerToken,
            liquiditySol: v.liquiditySol,
            feesSol: v.feesSol,
            valueSol: v.liquiditySol + v.feesSol,
          } satisfies OnchainPositionView;
        } catch (e) {
          log.warn(`onchain position ${pubkey} unreadable: ${(e as Error).message}`);
          return null;
        }
      }),
    );
    const list = rows.filter((r): r is OnchainPositionView => r !== null);
    this.cache = { at: now, rows: list };
    return list;
  }
}
