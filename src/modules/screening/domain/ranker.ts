import { SOL_MINT } from "../../../shared/solana/constants";
import type { AgentConfig } from "../../../shared/config";
import type { Pool } from "./pool";

export function tokenMintOf(pool: Pool): string {
  return pool.token_x.address === SOL_MINT ? pool.token_y.address : pool.token_x.address;
}

export interface Candidate {
  pool: Pool;
  score: number;
  reasons: string[];
  /** Every pool of the same token that passed the screen (different bin steps / fees), best first. */
  alternatives: Pool[];
}

const STABLES = new Set(["USDC", "USDT", "PYUSD", "USDS", "USD1", "JUPSOL", "MSOL", "JITOSOL", "BSOL"]);

/**
 * First-pass screen on Meteora Data API numbers only (Modul 5.1 / 5.6):
 * TOKEN-SOL pools, real volume, high fee/TVL, TVL and mcap inside the band,
 * age ≥ 1 day, bin step wide enough for memecoin ranges.
 * One best pool per token; the other passing pools are kept as alternatives
 * so the decision step can choose a different bin step.
 */
export function rankPools(pools: Pool[], cfg: AgentConfig, hotRank?: Map<string, number>): Candidate[] {
  const s = cfg.screening;
  const now = Date.now();
  const bestPerToken = new Map<string, Candidate>();
  const passing = new Map<string, { pool: Pool; score: number }[]>();

  for (const pool of pools) {
    if (pool.is_blacklisted) continue;
    const solIsX = pool.token_x.address === SOL_MINT;
    const solIsY = pool.token_y.address === SOL_MINT;
    if (solIsX === solIsY) continue;
    const token = solIsX ? pool.token_y : pool.token_x;
    if (STABLES.has(token.symbol?.toUpperCase())) continue;
    if (s.blockedMints.includes(token.address)) continue;
    if (token.freeze_authority_disabled === false) continue;

    if (pool.tvl < s.minTvlUsd || pool.tvl > s.maxTvlUsd) continue;
    const mcap = token.market_cap ?? 0;
    if (mcap < s.minMcapUsd) continue;
    if (s.maxMcapUsd > 0 && mcap > s.maxMcapUsd) continue;
    if (pool.pool_config.bin_step < s.minBinStep) continue;
    const ageH = (now - (pool.created_at || now)) / 3_600_000;
    // Pool age is a lower bound on token age; the deep check refines it with DexScreener.
    if (ageH < Math.min(s.minAgeHours, 6)) continue;
    if (s.maxAgeHours > 0 && ageH > s.maxAgeHours) continue;

    const vol1h = pool.volume?.["1h"] ?? 0;
    const feeTvl24 = pool.fee_tvl_ratio?.["24h"] ?? 0;
    const feeTvl4 = pool.fee_tvl_ratio?.["4h"] ?? 0;
    if (vol1h < s.minVolume1hUsd) continue;
    if (feeTvl24 < s.minFeeTvl24hPct) continue;

    const reasons: string[] = [];
    let score =
      Math.log1p(feeTvl24) + Math.log1p(feeTvl4 * 6) + 0.5 * Math.log1p(vol1h / Math.max(pool.tvl, 1));
    reasons.push(`fee/tvl24h=${feeTvl24.toFixed(1)}%`, `fee/tvl4h=${feeTvl4.toFixed(2)}%`);
    if (pool.pool_config.collect_fee_mode === 1 && !solIsX) {
      score += 0.3;
      reasons.push("quote-only fee");
    }
    if (pool.pool_config.base_fee_pct >= 2) {
      score += 0.2;
      reasons.push(`base fee ${pool.pool_config.base_fee_pct}%`);
    }
    const hot = hotRank?.get(token.address);
    if (hot !== undefined) {
      score += 0.6 / Math.sqrt(hot);
      reasons.push(`GMGN hot #${hot}`);
    }

    const list = passing.get(token.address) ?? [];
    list.push({ pool, score });
    passing.set(token.address, list);
    const prev = bestPerToken.get(token.address);
    if (!prev || score > prev.score) bestPerToken.set(token.address, { pool, score, reasons, alternatives: [] });
  }

  for (const [mint, cand] of bestPerToken) {
    cand.alternatives = (passing.get(mint) ?? []).sort((a, b) => b.score - a.score).map((x) => x.pool);
  }
  return [...bestPerToken.values()].sort((a, b) => b.score - a.score);
}
