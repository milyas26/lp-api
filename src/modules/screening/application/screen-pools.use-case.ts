import type { AgentConfig } from "../../../shared/config";
import { log } from "../../../shared/logger";
import type { Tracer } from "../../activity/application/tracer";
import type { BotSession } from "../../bot/application/bot-session";
import type { Pool } from "../domain/pool";
import { rankPools, tokenMintOf, type Candidate } from "../domain/ranker";
import { fetchHotTokens } from "../infrastructure/gmgn-hot.client";
import { fetchPools, fetchPoolsOfTokens } from "../infrastructure/meteora-data.client";
import type { CandidateSkips } from "./candidate-skips";

export interface ScreenResult {
  /** Every pool fetched this cycle (the AI may look up bin-step siblings among them). */
  universe: Pool[];
  /** Passed the first filter and not held / cooling down, best first. */
  ranked: Candidate[];
}

interface Universe {
  pools: Pool[];
  /** Token mint → GMGN hot-search rank, when the universe came from GMGN. */
  hotRank?: Map<string, number>;
  source: string;
}

/** DLMM pools looked up per hot token (different bin steps). */
const POOLS_PER_HOT_TOKEN = 4;

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
    const { pools: universe, hotRank, source } = await this.fetchUniverse();
    const held = new Set(this.session.positions.map((p) => p.tokenMint));
    const now = Date.now();
    const firstPass = rankPools(universe, c, hotRank);
    const ranked = firstPass.filter((cand) => {
      if (held.has(tokenMintOf(cand.pool))) return false;
      const closed = this.session.state.closedPoolAt[cand.pool.address];
      if (closed && now - closed < c.opening.cooldownMs) return false;
      return !this.skips.coolingDown(cand.pool.address, now);
    });
    const cooled = firstPass.length - ranked.length;
    log.info(`screened ${universe.length} pools (${source}), ${ranked.length} pass first filter`);
    if (ranked.length === 0) {
      step.skip(
        `${source}: ${universe.length} pool dicek, tidak ada yang lolos filter awal` +
          (cooled > 0 ? ` (${cooled} lolos tapi sedang cooldown atau sudah dipegang).` : "."),
      );
    } else {
      step.done(
        `${source}: ${universe.length} pool dicek, ${ranked.length} lolos filter awal` +
          (cooled > 0 ? `, ${cooled} dilewati karena cooldown atau sudah dipegang.` : "."),
      );
    }
    return { universe, ranked };
  }

  private async fetchUniverse(): Promise<Universe> {
    if (this.cfg.screening.useGmgn) {
      try {
        return await this.fromGmgn();
      } catch (e) {
        log.warn("GMGN hot searches failed, falling back to Meteora lists", e);
        const meteora = await this.fromMeteora();
        return { ...meteora, source: `GMGN gagal (${errText(e)}), pakai Meteora` };
      }
    }
    return this.fromMeteora();
  }

  /**
   * Tokens trending on GMGN right now, then their Meteora DLMM SOL pools
   * (busiest few per token, so the AI can still compare bin steps).
   */
  private async fromGmgn(): Promise<Universe> {
    const s = this.cfg.screening;
    const hot = (
      await fetchHotTokens({
        python: s.pythonBin,
        interval: s.gmgnInterval,
        minMcapUsd: s.minMcapUsd,
        maxMcapUsd: s.maxMcapUsd,
        minAgeHours: s.minAgeHours,
        maxAgeHours: s.maxAgeHours,
      })
    ).slice(0, s.gmgnMaxTokens);
    const hotRank = new Map(hot.map((t) => [t.mint, t.rank]));

    const found = await fetchPoolsOfTokens(hot.map((t) => t.mint), { minTvlUsd: s.minTvlUsd });
    const perToken = new Map<string, number>();
    const pools = found.filter((p) => {
      const mint = tokenMintOf(p);
      const n = perToken.get(mint) ?? 0;
      perToken.set(mint, n + 1);
      return hotRank.has(mint) && n < POOLS_PER_HOT_TOKEN;
    });
    const withPool = new Set(pools.map((p) => tokenMintOf(p))).size;
    return { pools, hotRank, source: `GMGN ${s.gmgnInterval}: ${hot.length} token ramai, ${withPool} punya pool DLMM` };
  }

  /** Two sorts (fee/TVL 24h, volume 1h) so both steady earners and hot pools show up. */
  private async fromMeteora(): Promise<Universe> {
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
    return { pools: [...byAddr.values()], source: "Meteora" };
  }
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0].slice(0, 120);
}
