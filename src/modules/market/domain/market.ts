/** SOL market regime for the current cycle (Modul 9.4). */
export interface Market {
  /** false when the SOL price feed failed: no new entries, but don't panic-close. */
  known: boolean;
  solChange1h: number;
  solChange24h: number;
  /** SOL price in USD, for the dashboard's USD figures. 0 when unknown. */
  solPriceUsd?: number;
  solDumping: boolean;
}

export function isSolDumping(change1h: number, change24h: number, limits: { dump1hPct: number; dump24hPct: number }): boolean {
  return change1h <= -limits.dump1hPct || change24h <= -limits.dump24hPct;
}
