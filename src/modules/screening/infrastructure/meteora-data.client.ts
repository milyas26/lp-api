import { getJson } from "../../../shared/http-client";
import { SOL_MINT } from "../../../shared/solana/constants";
import type { Pool } from "../domain/pool";

const BASE = "https://dlmm.datapi.meteora.ag";

interface PoolListResponse {
  total: number;
  data: Pool[];
}

export async function fetchPools(opts: {
  pageSize: number;
  minTvlUsd: number;
  sortBy?: string;
}): Promise<Pool[]> {
  const params = new URLSearchParams();
  params.set("page_size", String(Math.min(200, opts.pageSize)));
  params.set("sort_by", opts.sortBy ?? "fee_tvl_ratio_24h:desc");
  params.set("filter_by", `is_blacklisted=false && tvl>=${opts.minTvlUsd}`);
  const json = await getJson<PoolListResponse>(`${BASE}/pools?${params.toString()}`);
  return json.data ?? [];
}

/** TOKEN-SOL pools for these mints, by 24h volume. Mints are OR-ed in one filter per chunk. */
export async function fetchPoolsOfTokens(mints: string[], opts: { minTvlUsd: number }): Promise<Pool[]> {
  const out: Pool[] = [];
  for (let i = 0; i < mints.length; i += 15) {
    const anyMint = mints
      .slice(i, i + 15)
      .flatMap((m) => [`token_x=${m}`, `token_y=${m}`])
      .join(" || ");
    const params = new URLSearchParams();
    params.set("page_size", "200");
    params.set("sort_by", "volume_24h:desc");
    params.set(
      "filter_by",
      `(${anyMint}) && (token_x=${SOL_MINT} || token_y=${SOL_MINT}) && is_blacklisted=false && tvl>=${opts.minTvlUsd}`,
    );
    const json = await getJson<PoolListResponse>(`${BASE}/pools?${params.toString()}`);
    out.push(...(json.data ?? []));
  }
  return out;
}

export async function fetchPool(address: string): Promise<Pool> {
  return getJson<Pool>(`${BASE}/pools/${address}`);
}
