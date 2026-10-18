import type { BotSession } from "../../bot/application/bot-session";
import { fetchCandles } from "../../market/infrastructure/gecko.client";
import { fetchPool } from "../../screening/infrastructure/meteora-data.client";
import { paperValue, rangeConcentration, type PaperState } from "../../strategy/domain/paper-sim";
import type { ShapeName } from "../../strategy/domain/shape";

/** One candle of the pool's price, mapped into the position's bin space. */
export interface ChartPoint {
  t: number;
  /** Token price in SOL (the pool's quote token). */
  priceSol: number;
  /** 0 = top of range, 1 = bottom; <0 above range, >1 below it. */
  depth: number;
}

export interface ChartSimRow {
  dropPct: number;
  valueSol: number;
  pnlPct: number;
  filledPct: number;
}

/** Per-position price-vs-bin history plus the Modul 4 IL simulation. */
export interface PositionChartView {
  positionPubkey: string;
  poolAddress: string;
  poolName: string;
  shape: ShapeName;
  binStep: number;
  bins: number;
  rangePct: number;
  minBinId: number;
  maxBinId: number;
  entryPriceSol: number;
  /** Depth of the entry bin relative to the range top (a hair above 0). */
  entryDepth: number;
  priceTopSol: number;
  priceBotSol: number;
  depositSol: number;
  feeTvl24hPct: number | null;
  feePerDaySol: number;
  candles: ChartPoint[];
  rows: ChartSimRow[];
  at: number;
}

const round = (x: number, d = 4) => Number(x.toFixed(d));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Price history of a position's pool, folded into its bin space, plus the IL
 * table from the same paper model the bot uses for DRY_RUN (`paper-sim`).
 * The drop rows are anchored at the entry price, exactly like `research.simulate`.
 */
export class PositionChart {
  constructor(private readonly session: BotSession) {}

  async execute(pubkey: string): Promise<PositionChartView | null> {
    const p = this.session.positions.find((x) => x.positionPubkey === pubkey);
    if (!p) return null;

    const binStep = p.binStep ?? 50;
    const bins = Math.max(1, p.maxBinId - p.minBinId + 1);
    const step = 1 + binStep / 10_000;
    // Top of range sits one bin above the entry bin; same for SOL-quoted and
    // SOL-base pools, so a single formula covers both.
    const priceTop = p.paper?.priceTop ?? p.entryPriceSol / step;
    const priceBot = priceTop * Math.pow(step, -bins);
    const entryPrice = p.paper ? p.paper.priceTop * step : p.entryPriceSol;

    const state: PaperState = {
      depositSol: p.depositSol,
      priceTop,
      binStep,
      bins,
      shape: p.shape,
      feesSol: 0,
      lastTickAt: 0,
    };

    const depthOf = (price: number) => (price > 0 ? Math.log(priceTop / price) / Math.log(step) / bins : 0);

    const candles = await fetchCandles(p.poolAddress, "minute", 15, 480).catch(() => []);
    const points: ChartPoint[] = candles
      .filter((c) => c.c > 0)
      .map((c) => ({ t: c.t, priceSol: c.c, depth: depthOf(c.c) }));

    // Modul 4: value as price falls, before fees, from the entry price down.
    const drops = [...new Set([5, 10, 20, 35, 50, Math.round(p.rangePct), Math.min(95, Math.round(p.rangePct) + 15)])]
      .filter((d) => d > 0 && d < 100)
      .sort((a, b) => a - b);
    const rows: ChartSimRow[] = drops.map((d) => {
      const v = paperValue(state, entryPrice * (1 - d / 100));
      return {
        dropPct: d,
        valueSol: round(v.liquiditySol, 4),
        pnlPct: Number(((v.liquiditySol / p.depositSol - 1) * 100).toFixed(1)),
        filledPct: Math.round(clamp(v.depth, 0, 1) * 100),
      };
    });

    const feeTvl24hPct = await fetchPool(p.poolAddress)
      .then((pool) => pool.fee_tvl_ratio?.["24h"] ?? null)
      .catch(() => null);
    const ageHours = Math.max(0.25, (Date.now() - p.openedAt) / 3_600_000);
    const realizedPerDay = (p.claimedSol + (p.lastFeesSol ?? 0)) / ageHours * 24;
    const feePerDaySol =
      feeTvl24hPct !== null
        ? round(p.depositSol * (feeTvl24hPct / 100) * rangeConcentration(bins, binStep))
        : round(realizedPerDay);

    return {
      positionPubkey: p.positionPubkey,
      poolAddress: p.poolAddress,
      poolName: p.poolName,
      shape: p.shape,
      binStep,
      bins,
      rangePct: round(p.rangePct, 1),
      minBinId: p.minBinId,
      maxBinId: p.maxBinId,
      entryPriceSol: entryPrice,
      entryDepth: round(depthOf(entryPrice)),
      priceTopSol: priceTop,
      priceBotSol: priceBot,
      depositSol: p.depositSol,
      feeTvl24hPct: feeTvl24hPct === null ? null : round(feeTvl24hPct, 1),
      feePerDaySol,
      candles: points,
      rows,
      at: Date.now(),
    };
  }
}
