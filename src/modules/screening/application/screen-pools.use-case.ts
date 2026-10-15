import type { AgentConfig } from "../../../shared/config";
import { log } from "../../../shared/logger";
import type { Tracer } from "../../activity/application/tracer";
import type { BotSession } from "../../bot/application/bot-session";
import type { Pool } from "../domain/pool";
import { rankPools, tokenMintOf, type Candidate } from "../domain/ranker";
import { fetchPools } from "../infrastructure/meteora-data.client";
import type { CandidateSkips } from "./candidate-skips";

export interface ScreenResult {
  /** Every pool fetched this cycle (the AI may look up bin-step siblings among them). */
  universe: Pool[];
  /** Passed the first filter and not held / cooling down, best first. */
  ranked: Candidate[];
}

/** Modul 5: pull the Meteora pool list and keep what passes the first filter. */
export class ScreenPools {
  constructor(
    private readonly cfg: AgentConfig,
    private readonly session: BotSession,
    private readonly skips: CandidateSkips,
    private readonly tracer: Tracer,
  ) {}

  async execute(): Promise<ScreenResult> {
    const c = this.cfg;
    const step = this.tracer.step("screen", "Screening pool Meteora");
    const universe = await this.fetchUniverse();
    const held = new Set(this.session.positions.map((p) => p.tokenMint));
    const now = Date.now();
    const firstPass = rankPools(universe, c);
    const ranked = firstPass.filter((cand) => {
      if (held.has(tokenMintOf(cand.pool))) return false;
      const closed = this.session.state.closedPoolAt[cand.pool.address];
      if (closed && now - closed < c.opening.cooldownMs) return false;
      return !this.skips.coolingDown(cand.pool.address, now);
    });
    const cooled = firstPass.length - ranked.length;
    log.info(`screened ${universe.length} pools, ${ranked.length} pass first filter`);
    if (ranked.length === 0) {
      step.skip(
        `${universe.length} pool dicek, tidak ada yang lolos filter awal` +
          (cooled > 0 ? ` (${cooled} lolos tapi sedang cooldown atau sudah dipegang).` : "."),
      );
    } else {
      step.done(
        `${universe.length} pool dicek, ${ranked.length} lolos filter awal` +
          (cooled > 0 ? `, ${cooled} dilewati karena cooldown atau sudah dipegang.` : "."),
      );
    }
    return { universe, ranked };
  }

  /** Two sorts (fee/TVL 24h, volume 1h) so both steady earners and hot pools show up. */
  private async fetchUniverse(): Promise<Pool[]> {
    const s = this.cfg.screening;
    const lists = await Promise.allSettled([
      fetchPools({ pageSize: s.pageSize, minTvlUsd: s.minTvlUsd, sortBy: "fee_tvl_ratio_24h:desc" }),
      fetchPools({ pageSize: s.pageSize, minTvlUsd: s.minTvlUsd, sortBy: "volume_1h:desc" }),
    ]);
    const byAddr = new Map<string, Pool>();
    for (const l of lists) {
      if (l.status === "fulfilled") for (const p of l.value) byAddr.set(p.address, p);
      else log.warn("pool list fetch failed", l.reason);
    }
    return [...byAddr.values()];
  }
}
