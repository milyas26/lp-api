/** Meteora DLMM pool as returned by the Data API (fields the bot uses). */
export type Window = "30m" | "1h" | "2h" | "4h" | "12h" | "24h";

export interface PoolToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  price: number;
  is_verified?: boolean;
  holders?: number;
  freeze_authority_disabled?: boolean;
  market_cap?: number;
}

export interface Pool {
  address: string;
  name: string;
  token_x: PoolToken;
  token_y: PoolToken;
  tvl: number;
  current_price: number;
  created_at: number;
  dynamic_fee_pct: number;
  is_blacklisted: boolean;
  launchpad?: string;
  pool_config: {
    bin_step: number;
    base_fee_pct: number;
    max_fee_pct: number;
    protocol_fee_pct: number;
    /** 0 = fee in input token, 1 = quote-only (fee only in token Y). */
    collect_fee_mode: number;
  };
  /** Percent, e.g. 17.1 means 17.1% of TVL earned as fees in the window. */
  fee_tvl_ratio: Record<Window, number>;
  fees: Record<Window, number>;
  volume: Record<Window, number>;
}
