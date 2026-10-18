import type { Connection } from "@solana/web3.js";
import { SOL_MINT } from "../../../shared/solana/constants";
import type { AgentConfig } from "../../../shared/config";
import type { ShapeName } from "../../strategy/domain/shape";
import type { Pool } from "../../screening/domain/pool";
import { tokenMintOf } from "../../screening/domain/ranker";
import { fetchPool } from "../../screening/infrastructure/meteora-data.client";
import { loadPool, quoteOpen } from "../../execution/infrastructure/dlmm.gateway";
import { fetchCandles } from "../../market/infrastructure/gecko.client";
import { pvpRivalShare, tokenMarket, tokenPairs, type TokenMarket } from "../../market/infrastructure/dexscreener.client";
import { rugReport, type RugReport } from "../../market/infrastructure/rugcheck.client";
import { computeFeatures, type Features } from "../../strategy/domain/features";
import { buildPlan, classifyPhase, type Phase, type Plan } from "../../strategy/domain/playbook";
import { binsForPct, fitRange, pctForBins } from "../../strategy/domain/range-math";
import { paperValue, rangeConcentration } from "../../strategy/domain/paper-sim";

/** Pools kept per token when comparing bin steps. */
const MAX_POOLS_PER_TOKEN = 6;
const SINGLE_TX_BINS = 69;

export interface Analysis {
  features: Features;
  phase: Phase;
  /** What the rule engine would do, as a starting point for the AI. */
  draft: Plan | null;
}

export interface Risk {
  rug: RugReport | null;
  pvp: number;
}

export interface BinStepRow {
  address: string;
  name: string;
  binStep: number;
  baseFeePct: number;
  tvlUsd: number;
  volume1hUsd: number;
  volume24hUsd: number;
  feeTvl1hPct: number;
  feeTvl24hPct: number;
  bins: number;
  rangePct: number;
  fits: boolean;
  /** Range narrowed to fit the bin cap (rangePct is the narrowed one). */
  shrunk: boolean;
  tx: "single" | "extended";
  /** Non-refundable bin array rent, live mode only. */
  rentSol?: number;
}

export interface SimRow {
  dropPct: number;
  valueSol: number;
  pnlPct: number;
  filledPct: number;
}


const round = (x: number, d = 2) => Number(x.toFixed(d));

/**
 * Data lookups the AI decision loop can call, cached for one cycle so the
 * model can revisit a token without hammering the free APIs.
 */
export class Research {
  private readonly pools = new Map<string, Pool>();
  private readonly analyses = new Map<string, Promise<Analysis | string>>();
  private readonly markets = new Map<string, Promise<TokenMarket | undefined>>();
  private readonly risks = new Map<string, Promise<Risk>>();
  private readonly siblings = new Map<string, Promise<Pool[]>>();

  constructor(
    private readonly cfg: AgentConfig,
    private readonly connection: Connection,
    universe: Pool[],
  ) {
    for (const p of universe) this.pools.set(p.address, p);
  }

  pool(address: string): Pool | undefined {
    return this.pools.get(address);
  }

  /** Analysis already fetched this cycle (no network). */
  async cachedAnalysis(address: string): Promise<Analysis | undefined> {
    const a = await this.analyses.get(address);
    return typeof a === "object" ? a : undefined;
  }

  hasRisk(mint: string): boolean {
    return this.risks.has(mint);
  }

  private market(mint: string): Promise<TokenMarket | undefined> {
    let m = this.markets.get(mint);
    if (!m) {
      m = tokenMarket(mint).catch(() => undefined);
      this.markets.set(mint, m);
    }
    return m;
  }

  /** Chart features + lifecycle phase. Returns an error string when the chart is unusable. */
  analyze(address: string): Promise<Analysis | string> {
    let a = this.analyses.get(address);
    if (!a) {
      a = this.doAnalyze(address);
      this.analyses.set(address, a);
    }
    return a;
  }

  private async doAnalyze(address: string): Promise<Analysis | string> {
    const pool = this.pools.get(address);
    if (!pool) return "pool tidak dikenal, pakai alamat dari daftar kandidat atau compare_bin_steps";
    const mint = tokenMintOf(pool);
    const [candles, mkt] = await Promise.all([
      fetchCandles(pool.address, "minute", 15, 480).catch(() => []),
      this.market(mint),
    ]);
    if (candles.length < 16) return "chart belum jalan atau candle kurang dari 4 jam (jangan LP buta)";
    const features = computeFeatures(pool, candles, mkt?.earliestPairAt);
    if (mkt) {
      features.meteoraShare = features.volume24hUsd / Math.max(1, features.volume24hUsd + mkt.otherVolume24h);
    }
    const phase = classifyPhase(features, this.cfg);
    const risk = this.risks.has(mint) ? await this.risks.get(mint)! : null;
    const draft = buildPlan(features, phase, this.cfg, risk?.rug?.warnings.length ?? 0);
    return { features, phase, draft };
  }

  risk(address: string): Promise<Risk> | string {
    const pool = this.pools.get(address);
    if (!pool) return "pool tidak dikenal";
    const mint = tokenMintOf(pool);
    let r = this.risks.get(mint);
    if (!r) {
      r = (async () => {
        const symbol = (pool.token_x.address === mint ? pool.token_x : pool.token_y).symbol;
        const mkt = await this.market(mint);
        const vol = (pool.volume?.["24h"] ?? 0) + (mkt?.otherVolume24h ?? 0);
        const [rug, pvp] = await Promise.all([
          rugReport(mint).catch(() => null),
          pvpRivalShare(mint, symbol, vol).catch(() => 0),
        ]);
        return { rug, pvp };
      })();
      this.risks.set(mint, r);
    }
    return r;
  }

  /** Every SOL pool of the token: screened ones plus Meteora DLMM pairs DexScreener knows about. */
  private poolsOfToken(mint: string): Promise<Pool[]> {
    let s = this.siblings.get(mint);
    if (!s) {
      s = (async () => {
        const found = new Map<string, Pool>();
        for (const p of this.pools.values()) if (tokenMintOf(p) === mint) found.set(p.address, p);
        const pairs = await tokenPairs(mint).catch(() => []);
        const extra = pairs
          .filter((p) => p.dexId.startsWith("meteora") && !found.has(p.pairAddress))
          .filter((p) => p.quoteToken.address === SOL_MINT || p.baseToken.address === SOL_MINT)
          .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))
          .slice(0, MAX_POOLS_PER_TOKEN);
        // DexScreener lumps DAMM and DLMM under "meteora"; the DLMM API 404s on the others.
        const fetched = await Promise.all(extra.map((p) => fetchPool(p.pairAddress).catch(() => null)));
        for (const p of fetched) {
          if (!p?.pool_config || p.is_blacklisted) continue;
          if (tokenMintOf(p) !== mint) continue;
          found.set(p.address, p);
          this.pools.set(p.address, p);
        }
        return [...found.values()]
          .sort((a, b) => (b.volume?.["24h"] ?? 0) - (a.volume?.["24h"] ?? 0))
          .slice(0, MAX_POOLS_PER_TOKEN);
      })();
      this.siblings.set(mint, s);
    }
    return s;
  }

  async binSteps(address: string, rangePct: number, shape: ShapeName): Promise<BinStepRow[] | string> {
    const pool = this.pools.get(address);
    if (!pool) return "pool tidak dikenal";
    const maxBins = this.cfg.opening.maxBinsPerPosition;
    const list = await this.poolsOfToken(tokenMintOf(pool));
    const rows: BinStepRow[] = [];
    for (const p of list) {
      const binStep = p.pool_config.bin_step;
      const fit = fitRange(rangePct, binStep, maxBins);
      const bins = fit.bins;
      const row: BinStepRow = {
        address: p.address,
        name: p.name,
        binStep,
        baseFeePct: p.pool_config.base_fee_pct,
        tvlUsd: Math.round(p.tvl),
        volume1hUsd: Math.round(p.volume?.["1h"] ?? 0),
        volume24hUsd: Math.round(p.volume?.["24h"] ?? 0),
        feeTvl1hPct: round(p.fee_tvl_ratio?.["1h"] ?? 0, 3),
        feeTvl24hPct: round(p.fee_tvl_ratio?.["24h"] ?? 0),
        bins,
        rangePct: round(pctForBins(bins, binStep), 1),
        fits: fit.ok,
        shrunk: fit.shrunk,
        tx: bins > SINGLE_TX_BINS ? "extended" : "single",
      };
      if (!this.cfg.dryRun && row.fits) {
        try {
          const q = await quoteOpen(await loadPool(this.connection, p.address), bins, shape);
          row.rentSol = round(q.binArrayCostSol, 4);
        } catch {
          // Quote is advisory; open() re-checks rent before sending.
        }
      }
      rows.push(row);
    }
    return rows;
  }

  /**
   * Paper model of a one-sided SOL position (Modul 4 IL table): value if price
   * drops by X%, before fees. Uses the same simulator as DRY_RUN.
   */
  simulate(a: Analysis, rangePct: number, shape: ShapeName, sizeSol: number) {
    const f = a.features;
    const bins = binsForPct(rangePct, f.binStep);
    const actual = pctForBins(bins, f.binStep);
    const state = {
      depositSol: sizeSol,
      priceTop: f.priceSol / (1 + f.binStep / 10_000),
      binStep: f.binStep,
      bins,
      shape,
      feesSol: 0,
      lastTickAt: 0,
    };
    const drops = [...new Set([5, 10, 20, 35, 50, Math.round(actual), Math.min(95, Math.round(actual) + 15)])]
      .filter((d) => d < 100)
      .sort((x, y) => x - y);
    const rows: SimRow[] = drops.map((d) => {
      const v = paperValue(state, f.priceSol * (1 - d / 100));
      return {
        dropPct: d,
        valueSol: round(v.liquiditySol, 4),
        pnlPct: round((v.liquiditySol / sizeSol - 1) * 100, 1),
        filledPct: round(Math.min(1, Math.max(0, v.depth)) * 100, 0),
      };
    });
    // Our share of fees ≈ deposit × pool fee/TVL rate × range concentration, only while in range.
    const feePerDaySol = sizeSol * (f.feeTvl24hPct / 100) * rangeConcentration(bins, f.binStep);
    return { bins, rangePct: round(actual, 1), rows, feePerDaySol: round(feePerDaySol, 4) };
  }
}
