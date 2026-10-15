import { getJson } from "../../../shared/http-client";
import { SOL_MINT } from "../../../shared/solana/constants";

export interface DexPair {
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  pairCreatedAt?: number;
}

const OPTS = { minSpacingMs: 250 };

export async function tokenPairs(mint: string): Promise<DexPair[]> {
  return getJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, OPTS);
}

async function search(q: string): Promise<DexPair[]> {
  const r = await getJson<{ pairs?: DexPair[] }>(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
    OPTS,
  );
  return (r.pairs ?? []).filter((p) => (p as { chainId?: string }).chainId === "solana");
}

export interface TokenMarket {
  /** 24h volume on non-Meteora venues (Raydium, PumpSwap, ...). */
  otherVolume24h: number;
  earliestPairAt?: number;
}

export async function tokenMarket(mint: string): Promise<TokenMarket> {
  const pairs = await tokenPairs(mint);
  let other = 0;
  let earliest: number | undefined;
  for (const p of pairs) {
    if (!p.dexId.startsWith("meteora")) other += p.volume?.h24 ?? 0;
    if (p.pairCreatedAt && (!earliest || p.pairCreatedAt < earliest)) earliest = p.pairCreatedAt;
  }
  return { otherVolume24h: other, earliestPairAt: earliest };
}

/**
 * PvP check (Modul 5.5): another token with the same symbol doing meaningful
 * volume means two coins fighting for the same narrative.
 */
export async function pvpRivalShare(mint: string, symbol: string, ownVol24h: number): Promise<number> {
  const pairs = await search(symbol);
  let rival = 0;
  for (const p of pairs) {
    if (p.baseToken.address === mint) continue;
    if (p.baseToken.symbol?.toUpperCase() !== symbol.toUpperCase()) continue;
    rival = Math.max(rival, p.volume?.h24 ?? 0);
  }
  return ownVol24h > 0 ? rival / ownVol24h : 0;
}

/** SOL price (USD) and change from the deepest SOL/USD pair (market regime filter). */
export async function solRegime(): Promise<{ change1h: number; change24h: number; priceUsd: number }> {
  const pairs = await tokenPairs(SOL_MINT);
  const usd = pairs
    .filter(
      (p) =>
        p.baseToken.address === SOL_MINT &&
        ["USDC", "USDT"].includes(p.quoteToken.symbol?.toUpperCase()),
    )
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  return {
    change1h: usd?.priceChange?.h1 ?? 0,
    change24h: usd?.priceChange?.h24 ?? 0,
    priceUsd: Number(usd?.priceUsd ?? 0) || 0,
  };
}
