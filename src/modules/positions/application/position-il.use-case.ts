import type { AgentConfig } from "../../../shared/config";
import { log } from "../../../shared/logger";
import type DLMM from "@meteora-ag/dlmm";
import type { BotSession } from "../../bot/application/bot-session";
import type { ExecutionService } from "../../execution/application/execution.service";
import { fetchPool } from "../../screening/infrastructure/meteora-data.client";
import { tokenPriceSol } from "../../strategy/domain/features";
import { paperValue } from "../../strategy/domain/paper-sim";
import type { TrackedPosition } from "../domain/position";

export interface PositionIlView {
  positionPubkey: string;
  depositSol: number;
  /** Liquidity value now, fees excluded. */
  liquiditySol: number;
  feesSol: number;
  /** liquiditySol − depositSol: what the LP shape costs versus holding SOL. */
  ilSol: number;
  ilPct: number;
  at: number;
}

/**
 * Live impermanent loss for the bot's open positions, valued against holding
 * SOL (the one side the bot deposits). Polled by the dashboard, so the value
 * is recomputed on a short cache with no side effects on paper state.
 *
 * Every open position always yields a row: a live read that fails falls back
 * to the last snapshot, so the dashboard never silently drops a position.
 */
export class PositionIl {
  private cache: { at: number; rows: PositionIlView[] } | null = null;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly session: BotSession,
    private readonly execution: ExecutionService,
    private readonly ttlMs = 15_000,
  ) {}

  async execute(): Promise<{ positions: PositionIlView[]; at: number }> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.ttlMs) return { positions: this.cache.rows, at: this.cache.at };

    const pools = new Map<string, DLMM>();
    const rows: PositionIlView[] = [];
    for (const p of this.session.positions) rows.push(await this.value(p, pools, now));
    this.cache = { at: now, rows };
    return { positions: rows, at: now };
  }

  private async value(p: TrackedPosition, pools: Map<string, DLMM>, at: number): Promise<PositionIlView> {
    let liquiditySol: number;
    let feesSol: number;

    if (p.paper) {
      feesSol = p.paper.feesSol;
      try {
        const price = tokenPriceSol(await fetchPool(p.poolAddress));
        liquiditySol = paperValue(p.paper, price).liquiditySol;
      } catch (e) {
        log.warn(`IL paper read ${p.positionPubkey} failed: ${(e as Error).message}`);
        liquiditySol = (p.lastValueSol ?? p.depositSol) - feesSol;
      }
    } else {
      try {
        let dlmm = pools.get(p.poolAddress);
        if (!dlmm) {
          dlmm = await this.execution.loadPool(p.poolAddress);
          pools.set(p.poolAddress, dlmm);
        }
        const position = await this.execution.getPosition(dlmm, p.positionPubkey);
        const v = await this.execution.value(dlmm, position);
        liquiditySol = v.liquiditySol;
        feesSol = v.feesSol;
      } catch (e) {
        log.warn(`IL live read ${p.positionPubkey} failed: ${(e as Error).message}; using last snapshot`);
        feesSol = p.lastFeesSol ?? 0;
        liquiditySol = (p.lastValueSol ?? p.depositSol) - feesSol;
      }
    }

    const ilSol = liquiditySol - p.depositSol;
    return {
      positionPubkey: p.positionPubkey,
      depositSol: p.depositSol,
      liquiditySol,
      feesSol,
      ilSol,
      ilPct: p.depositSol > 0 ? (ilSol / p.depositSol) * 100 : 0,
      at,
    };
  }
}
