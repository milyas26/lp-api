import type { AgentConfig } from "../../../shared/config";
import { pct, sol } from "../../../shared/format";
import { log } from "../../../shared/logger";
import type { StepHandle, Tracer } from "../../activity/application/tracer";
import { fetchCandles } from "../../market/infrastructure/gecko.client";
import { pvpRivalShare, tokenMarket } from "../../market/infrastructure/dexscreener.client";
import { rugReport } from "../../market/infrastructure/rugcheck.client";
import { tokenMintOf, type Candidate } from "../../screening/domain/ranker";
import { computeFeatures } from "../../strategy/domain/features";
import { baseSizePct, buildPlan, classifyPhase, type Phase } from "../../strategy/domain/playbook";
import { fitRange } from "../../strategy/domain/range-math";
import type { DecisionInput, EntryDecider } from "../domain/entry-decider";
import type { EntryProposal } from "../domain/entry-proposal";

function phaseReason(phase: Phase): string {
  switch (phase) {
    case "DEAD":
      return "volume dan volatilitas mengering";
    case "FALLING_KNIFE":
      return "harga jatuh, belum stabil";
    default:
      return "tidak ada strategi cocok";
  }
}

/**
 * Playbook rule engine without AI (Modul 5.8 "checklist 60 detik"): checks the
 * candidates in rank order and takes the first one that passes.
 */
export class RuleDecider implements EntryDecider {
  readonly mode = "rules" as const;
  readonly label = null;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly tracer: Tracer,
  ) {}

  async decide(input: DecisionInput): Promise<EntryProposal | null> {
    const deep = this.tracer.step("deep", "Analisa kandidat (rule engine)");
    let checked = 0;
    for (const cand of input.candidates) {
      checked++;
      const child = deep.child("candidate", cand.pool.name);
      const proposal = await this.check(cand, input, child);
      if (!proposal) continue;
      deep.done(`${checked} kandidat dianalisa, ${cand.pool.name} terpilih.`);
      return proposal; // one entry per cycle: re-evaluate next cycle with fresh balances
    }
    deep.skip(`${checked} kandidat dianalisa, tidak ada yang layak dibuka.`);
    return null;
  }

  private async check(cand: Candidate, input: DecisionInput, step: StepHandle): Promise<EntryProposal | null> {
    const c = this.cfg;
    const pool = cand.pool;
    const mint = tokenMintOf(pool);
    const skip = async (why: string, extra?: Record<string, unknown>) => {
      step.skip(`Dilewati: ${why}`);
      await input.onSkip(pool, why, extra);
      return null;
    };

    step.note("Ambil chart 15 menit dan data DEX...");
    const [candles, mkt] = await Promise.all([
      fetchCandles(pool.address, "minute", 15, 480).catch(() => []),
      tokenMarket(mint).catch(() => undefined),
    ]);
    if (candles.length < 16) return skip("chart belum jalan atau candle kurang (jangan LP buta)");

    const f = computeFeatures(pool, candles, mkt?.earliestPairAt);
    // Share of the token's volume routed through this pool (1 = no Raydium/PumpSwap pool, Modul 5.4).
    if (mkt) f.meteoraShare = f.volume24hUsd / Math.max(1, f.volume24hUsd + mkt.otherVolume24h);
    if (f.ageHours < c.screening.minAgeHours) {
      return skip(`umur ${f.ageHours.toFixed(1)} jam, minimal ${c.screening.minAgeHours} jam`);
    }
    if (c.screening.maxAgeHours > 0 && f.ageHours > c.screening.maxAgeHours) {
      return skip(`umur ${f.ageHours.toFixed(1)} jam, maksimal ${c.screening.maxAgeHours} jam`);
    }

    const phase = classifyPhase(f, c);
    step.note(`Fase ${phase}. Cek RugCheck...`);
    const rug = await rugReport(mint).catch(() => null);
    if (!rug) return skip("RugCheck tidak bisa diakses");
    if (!rug.ok) return skip(`RugCheck danger: ${rug.dangers.join(", ")}`);

    const plan = buildPlan(f, phase, c, rug.warnings.length);
    if (!plan) return skip(`fase ${phase} (${phaseReason(phase)})`, { phase });

    step.note(`Fase ${phase}, rencana ${plan.strategy}. Cek PvP...`);
    const pvp = await pvpRivalShare(mint, f.tokenSymbol, f.volume24hUsd + (mkt?.otherVolume24h ?? 0)).catch(() => 0);
    if (pvp >= 0.3) return skip(`PvP, ticker kembaran punya ${(pvp * 100).toFixed(0)}% volume`);

    const fit = fitRange(plan.rangePct, f.binStep, c.opening.maxBinsPerPosition);
    if (!fit.ok) {
      return skip(`bin step ${f.binStep} terlalu kecil: range -${plan.rangePct.toFixed(0)}% paling lebar jadi -${fit.rangePct.toFixed(0)}%`);
    }
    if (fit.shrunk) {
      plan.notes.push(`range dikecilkan dari -${plan.rangePct.toFixed(0)}% supaya muat ${fit.bins} bin`);
      plan.rangePct = fit.rangePct;
    }
    const bins = fit.bins;

    let sizePct = baseSizePct(f.mcapUsd) * plan.sizeFactor;
    if (rug.warnings.length > 0) sizePct *= 0.7;
    if (pvp >= 0.1) sizePct *= 0.6;
    if (new Date().getUTCDay() === 6) sizePct *= c.opening.weekendSizeFactor;
    const sizeSol = Math.min(input.bankrollSol * (sizePct / 100), c.opening.maxPositionSol, input.budgetSol);
    if (sizeSol < c.opening.minPositionSol) return skip(`size ${sol(sizeSol)} di bawah minimum`);

    const reasoning =
      `${phase}: ${plan.strategy} ${plan.shape} -${plan.rangePct.toFixed(0)}% (${bins} bin). ` +
      `${plan.notes.join("; ")}. Drawdown dari ATH ${f.drawdownFromAthPct.toFixed(0)}%, 1 jam ${pct(f.change1hPct, 0)}, ` +
      `swing 15m ${f.swing15mPct.toFixed(1)}%, volume 1 jam $${(f.volume1hUsd / 1000).toFixed(0)}k, ` +
      `fee/TVL 24 jam ${f.feeTvl24hPct.toFixed(1)}%, mcap $${(f.mcapUsd / 1e6).toFixed(1)}M, ` +
      `porsi Meteora ${f.meteoraShare !== undefined ? (f.meteoraShare * 100).toFixed(0) + "%" : "tidak diketahui"}.`;
    log.info(`candidate ${pool.name}: ${reasoning}`);
    step.done(`Layak: ${reasoning} Size ${sol(sizeSol)}.`);

    return { pool, features: f, plan, bins, sizeSol, rug, pvp, reasoning, decidedBy: "rules" };
  }
}
