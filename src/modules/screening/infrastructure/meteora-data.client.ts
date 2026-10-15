import { getJson } from "../../../shared/http-client";
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

export async function fetchPool(address: string): Promise<Pool> {
  return getJson<Pool>(`${BASE}/pools/${address}`);
}
