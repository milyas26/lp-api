import { getJson } from "../../../shared/http-client";
import type { Candle } from "../domain/candle";

export type { Candle };

const BASE = "https://api.geckoterminal.com/api/v2/networks/solana";


interface OhlcvResponse {
  data?: { attributes?: { ohlcv_list?: number[][] } };
}

/**
 * OHLCV for a pool, oldest → newest. `currency=token` gives price in the
 * quote token, so everything stays SOL-denominated like the playbook.
 */
export async function fetchCandles(
  pool: string,
  timeframe: "minute" | "hour",
  aggregate: number,
  limit: number,
): Promise<Candle[]> {
  const url =
    `${BASE}/pools/${pool}/ohlcv/${timeframe}` +
    `?aggregate=${aggregate}&limit=${limit}&currency=token`;
  const json = await getJson<OhlcvResponse>(url, { minSpacingMs: 2_200, retries: 3 });
  const rows = json.data?.attributes?.ohlcv_list ?? [];
  return rows
    .map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }))
    .filter((k) => k.h > 0 && k.l > 0)
    .sort((a, b) => a.t - b.t);
}
