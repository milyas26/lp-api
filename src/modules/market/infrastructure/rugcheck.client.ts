import { getJson } from "../../../shared/http-client";

interface Risk {
  name: string;
  level: string;
  description?: string;
  score?: number;
}

interface Summary {
  score_normalised?: number;
  risks?: Risk[];
}

export interface RugReport {
  ok: boolean;
  dangers: string[];
  warnings: string[];
  score: number;
}

/** RugCheck summary. Any "danger" level risk (e.g. top holders, mint authority) rejects. */
export async function rugReport(mint: string): Promise<RugReport> {
  const s = await getJson<Summary>(
    `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`,
    { minSpacingMs: 1_100 },
  );
  const risks = s.risks ?? [];
  const dangers = risks.filter((r) => r.level === "danger").map((r) => r.name);
  const warnings = risks.filter((r) => r.level === "warn").map((r) => r.name);
  return { ok: dangers.length === 0, dangers, warnings, score: s.score_normalised ?? 0 };
}
