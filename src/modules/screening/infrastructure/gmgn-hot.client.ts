import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** backend/script/gmgn_hot_searches.py; same depth from src/ (tsx) and dist/ (node). */
const SCRIPT = path.resolve(__dirname, "../../../../script/gmgn_hot_searches.py");

export interface HotToken {
  mint: string;
  symbol: string;
  /** 1 = most searched. */
  rank: number;
  mcapUsd: number;
  volumeUsd: number;
  change1hPct: number;
}

/** Raw token row from GMGN; short keys as the API returns them. */
interface GmgnToken {
  a?: string;
  address?: string;
  ca?: string;
  s?: string;
  symbol?: string;
  mc?: number;
  v?: number;
  pcp1h?: number;
}

/**
 * GMGN "hot searches" on Solana: tokens people are searching and trading right
 * now. Runs the Python script because GMGN sits behind Cloudflare and needs
 * curl_cffi; the script prints the token list as JSON.
 */
export async function fetchHotTokens(opts: {
  python: string;
  interval: string;
  minMcapUsd: number;
  maxMcapUsd: number;
  minAgeHours: number;
  maxAgeHours: number;
}): Promise<HotToken[]> {
  const args = [SCRIPT, "--json", "--chain", "sol", "--interval", opts.interval];
  // The script takes market cap in thousands of USD and age in minutes.
  if (opts.minMcapUsd > 0) args.push("--min-mc", String(Math.floor(opts.minMcapUsd / 1000)));
  if (opts.maxMcapUsd > 0) args.push("--max-mc", String(Math.ceil(opts.maxMcapUsd / 1000)));
  if (opts.minAgeHours > 0) args.push("--min-age", String(Math.round(opts.minAgeHours * 60)));
  if (opts.maxAgeHours > 0) args.push("--max-age", String(Math.round(opts.maxAgeHours * 60)));

  const { stdout } = await run(opts.python, args, { timeout: 45_000, maxBuffer: 32 * 1024 * 1024 });
  const rows = JSON.parse(stdout) as GmgnToken[];
  if (!Array.isArray(rows)) throw new Error("GMGN: output bukan list token");

  const seen = new Set<string>();
  const out: HotToken[] = [];
  for (const t of rows) {
    const mint = t.a ?? t.address ?? t.ca;
    if (!mint || seen.has(mint)) continue;
    seen.add(mint);
    out.push({
      mint,
      symbol: t.s ?? t.symbol ?? "?",
      rank: out.length + 1,
      mcapUsd: t.mc ?? 0,
      volumeUsd: t.v ?? 0,
      change1hPct: t.pcp1h ?? 0,
    });
  }
  if (rows.length > 0 && out.length === 0) {
    throw new Error(`GMGN: field alamat token tidak dikenal (key: ${Object.keys(rows[0]).join(", ")})`);
  }
  return out;
}
