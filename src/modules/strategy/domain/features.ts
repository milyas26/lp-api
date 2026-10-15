import type { Candle } from "../../market/domain/candle";
import type { Pool } from "../../screening/domain/pool";
import { SOL_MINT } from "../../../shared/solana/constants";

/** Everything the playbook needs to know about one token/pool, SOL-denominated. */
export interface Features {
  pool: string;
  name: string;
  tokenMint: string;
  tokenSymbol: string;
  solIsX: boolean;
  binStep: number;
  baseFeePct: number;
  dynamicFeePct: number;
  quoteOnlyFees: boolean;
  tvlUsd: number;
  mcapUsd: number;
  ageHours: number;
  holders: number;

  priceSol: number;
  athSol: number;
  athAgeHours: number;
  drawdownFromAthPct: number;
  change1hPct: number;
  change6hPct: number;
  change24hPct: number;
  low24hSol: number;
  range24hPct: number;
  /** Median (high-low)/low of recent 15m candles, %. Modul 5: ±20%/5m is the sweet spot. */
  swing15mPct: number;
  /** Price has stopped making new lows and is trading in a band. */
  stabilized: boolean;

  volume1hUsd: number;
  volume24hUsd: number;
  /** volume 1h vs average hourly over 24h. <1 = cooling off. */
  volumeTrend: number;
  feeTvl1hPct: number;
  feeTvl4hPct: number;
  feeTvl24hPct: number;
  meteoraShare?: number;
}

function pctChange(from: number, to: number): number {
  return from > 0 ? ((to - from) / from) * 100 : 0;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Price of the non-SOL token in SOL from the pool's current price (Y per X). */
export function tokenPriceSol(pool: Pool): number {
  const solIsX = pool.token_x.address === SOL_MINT;
  return solIsX ? 1 / pool.current_price : pool.current_price;
}

/**
 * @param candles 15m candles, oldest → newest, price in SOL per token.
 */
export function computeFeatures(pool: Pool, candles: Candle[], earliestPairAt?: number): Features {
  const solIsX = pool.token_x.address === SOL_MINT;
  const token = solIsX ? pool.token_y : pool.token_x;
  const now = Date.now();
  const price = candles.length ? candles[candles.length - 1].c : tokenPriceSol(pool);

  const createdAt = Math.min(pool.created_at || now, earliestPairAt || now);
  const ageHours = (now - createdAt) / 3_600_000;

  let athSol = price;
  let athT = now / 1000;
  for (const k of candles) {
    if (k.h > athSol) {
      athSol = k.h;
      athT = k.t;
    }
  }

  const at = (hoursAgo: number): number => {
    const cutoff = now / 1000 - hoursAgo * 3600;
    const k = candles.find((c) => c.t >= cutoff);
    return k ? k.o : candles[0]?.o ?? price;
  };

  const last24 = candles.filter((c) => c.t >= now / 1000 - 86_400);
  const low24 = last24.length ? Math.min(...last24.map((c) => c.l)) : price;
  const high24 = last24.length ? Math.max(...last24.map((c) => c.h)) : price;

  const recent = candles.slice(-16);
  const swing = median(recent.map((c) => ((c.h - c.l) / c.l) * 100));

  // Stabilized = last 2h holds above the previous 2h low and the band is not a waterfall.
  const lastHalf = candles.slice(-8);
  const prevHalf = candles.slice(-16, -8);
  const lastLow = lastHalf.length ? Math.min(...lastHalf.map((c) => c.l)) : price;
  const prevLow = prevHalf.length ? Math.min(...prevHalf.map((c) => c.l)) : lastLow;
  const lastHigh = lastHalf.length ? Math.max(...lastHalf.map((c) => c.h)) : price;
  const stabilized = lastLow >= prevLow * 0.97 && pctChange(lastLow, lastHigh) < 35;

  const vol24 = pool.volume?.["24h"] ?? 0;
  const vol1 = pool.volume?.["1h"] ?? 0;

  return {
    pool: pool.address,
    name: pool.name,
    tokenMint: token.address,
    tokenSymbol: token.symbol,
    solIsX,
    binStep: pool.pool_config.bin_step,
    baseFeePct: pool.pool_config.base_fee_pct,
    dynamicFeePct: pool.dynamic_fee_pct,
    quoteOnlyFees: pool.pool_config.collect_fee_mode === 1,
    tvlUsd: pool.tvl,
    mcapUsd: token.market_cap ?? 0,
    ageHours,
    holders: token.holders ?? 0,

    priceSol: price,
    athSol,
    athAgeHours: (now / 1000 - athT) / 3600,
    drawdownFromAthPct: athSol > 0 ? (1 - price / athSol) * 100 : 0,
    change1hPct: pctChange(at(1), price),
    change6hPct: pctChange(at(6), price),
    change24hPct: pctChange(at(24), price),
    low24hSol: low24,
    range24hPct: pctChange(low24, high24),
    swing15mPct: swing,
    stabilized,

    volume1hUsd: vol1,
    volume24hUsd: vol24,
    volumeTrend: vol24 > 0 ? vol1 / (vol24 / 24) : 0,
    feeTvl1hPct: pool.fee_tvl_ratio?.["1h"] ?? 0,
    feeTvl4hPct: pool.fee_tvl_ratio?.["4h"] ?? 0,
    feeTvl24hPct: pool.fee_tvl_ratio?.["24h"] ?? 0,
  };
}
