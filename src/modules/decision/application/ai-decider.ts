import type { AgentConfig } from "../../../shared/config";
import type { ShapeName } from "../../strategy/domain/shape";
import { log } from "../../../shared/logger";
import type { Pool } from "../../screening/domain/pool";
import {
  STRATEGY_EXITS,
  STRATEGY_IDS,
  baseSizePct,
  type Plan,
  type StrategyId,
} from "../../strategy/domain/playbook";
import { binsForPct, fitRange, pctForBins } from "../../strategy/domain/range-math";
import type { StepHandle, Tracer } from "../../activity/application/tracer";
import { DeepSeek, type ChatMessage, type ToolSpec } from "../infrastructure/deepseek.client";
import type { EntryProposal } from "../domain/entry-proposal";
import type { DecisionInput, EntryDecider } from "../domain/entry-decider";
import { tokenMintOf } from "../../screening/domain/ranker";
import type { Research, Analysis } from "./research";

const SHAPES: ShapeName[] = ["Spot", "Curve", "BidAsk"];
const MIN_CONFIDENCE = 0.55;

/** Distilled from dlmm/materi (Yield Hustler, 31 videos). */
const SYSTEM = `Kamu adalah pengambil keputusan entry untuk bot LP Meteora DLMM di Solana yang jalan tanpa pengawasan.
Bot hanya deposit SOL one-sided DI BAWAH harga token (beli token saat harga turun ke range, jual lagi saat mantul, sambil dapat fee swap). P&L dihitung dalam SOL.

Tugasmu tiap siklus: dari daftar kandidat hasil screening, putuskan pool mana (termasuk bin step mana) yang dibuka, dengan shape, range, size, dan strategi apa. Atau tidak buka apa pun. Exit (stop loss, rug candle, out-of-range, take profit) dijalankan rule setelah entry; kamu tidak mengelolanya.

Cara kerja: kamu bekerja dalam loop. Panggil tool untuk mengumpulkan data, pikirkan hasilnya, ulangi sampai yakin, lalu akhiri dengan open_position atau skip_all. Urutan wajar:
1. analyze_token untuk kandidat yang menarik (chart 15m, fase, draft rencana dari rule engine).
2. check_risk (RugCheck + PvP ticker kembaran).
3. compare_bin_steps untuk memilih pool/bin step terbaik bagi range yang kamu mau. Bin step besar = range lebar muat dalam sedikit bin, tapi fee per swap kecil-kecilan lebih jarang; bin step kecil = lebih presisi tapi butuh lebih banyak bin (rent, extended position). Pilih yang fee/TVL dan volumenya sehat dan range-nya muat.
4. simulate_position untuk melihat nilai posisi kalau harga turun X% (IL sebelum fee) dan estimasi fee per hari.
5. open_position (satu saja per siklus) atau skip_all. Kandidat yang jelas jelek boleh dicoret dengan skip_candidate supaya tidak dicek ulang 30 menit.
Kamu boleh membandingkan beberapa kandidat sebelum memilih. Hemat langkah: jangan panggil tool yang sama dua kali dengan argumen sama.

Playbook:
- Pemilihan token lebih penting dari bentuk kurva. Kurva bagus di token rug tetap rugi.
- Syarat berurutan: volume tinggi, volatilitas dua arah (ideal ±20% per candle 5m, bukan longsor satu arah), mcap cukup (> $1M), fee/TVL tinggi, TVL tidak terlalu ramai dibanding volume.
- Sinyal positif: tidak ada pool besar lain (porsi Meteora tinggi), base fee tinggi dengan TVL kecil, sudah selamat dari beberapa dump, retrace sehat dari ATH (10-45%), trading organik dua arah, quote-only fee di koin rawan rug.
- Red flag: PvP, holder terkonsentrasi atau danger RugCheck lain, volume dan volatilitas memudar, harga jatuh bebas tanpa dasar ("jangan tangkap pisau, masuk saat sudah ranging"), SOL sendiri dump, masuk tepat di pucuk.
- Fase ke shape: run-up/breakout = spot sempit (hanya kalau mode agresif); baru nge-top atau ketinggalan run-up = BidAsk lebar (-50% standar, maksimal -55%); sudah dump 60-80% dan ranging = Spot -50%; ranging berminggu-minggu dengan volume = Spot lebar slow cook; volume hilang = skip.
- Range: -50% sampai -55% cukup untuk bot tanpa pengawasan; lebih lebar butuh terlalu banyak bin dan fee jadi encer. Cap besar (puluhan/ratusan juta) boleh lebih sempit (-35 s/d -50%). Dasar range sebaiknya di bawah support yang terlihat (low 24 jam).
- Size: kecil di cap kecil, token baru, PvP, atau koin yang bergantung pada creator/KOL; besar hanya untuk setup A+. Kalau ragu, kecilkan atau skip. Melewatkan trade tidak merugikan; rug menghabiskan posisi.

Strategi (menentukan exit otomatis): S2_WIDE_BIDASK (post-top, BidAsk lebar, SL -22% TP +20% maks 72j), S1_PLAY_THE_DROP (cap ≥ $20M post-top, BidAsk -35..-50%, SL -20% TP +15% 24j), S10_POST_DUMP_SPOT (sudah dump & stabil, Spot -50%, SL -15% TP +12% 24j), S8_SLOW_COOK (umur ≥3 hari ranging, Spot -40..-55%, SL -15% TP +25% 7 hari), S4_HEART_ATTACK (run-up + volume gila, Spot -20%, SL -6% TP +8% 2j, hanya kalau diizinkan).

Pagar keras yang dicek ulang oleh kode (open_position ditolak kalau dilanggar, kamu boleh perbaiki dan coba lagi): token harus sudah dianalisa dan dicek risiko; tidak ada danger RugCheck; PvP < 30%; fase bukan DEAD atau FALLING_KNIFE; range 15-85%; jumlah bin ≤ batas (range yang kelebihan bin otomatis dikecilkan ke range terlebar yang muat, asal tidak kurang dari 70% range yang diminta; compare_bin_steps sudah menampilkan range hasil kecilannya); size di antara minimum dan batas (size di atas batas otomatis dipotong); stop loss tidak boleh lebih longgar dari template strategi; confidence ≥ ${MIN_CONFIDENCE}.

Putuskan hanya dari data yang diberikan tool. Jangan mengarang fakta. Tulis pertimbanganmu singkat (1-3 kalimat) dalam Bahasa Indonesia di setiap giliran sebelum memanggil tool. Teksmu tampil di dashboard: pakai koma atau titik, jangan tanda pisah panjang (em dash).`;

const poolArg = { type: "string", description: "Alamat pool DLMM dari daftar kandidat atau hasil compare_bin_steps" };
const shapeArg = { type: "string", enum: SHAPES };

const TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "analyze_token",
      description:
        "Ambil chart 15 menit (sampai 5 hari) dan data DEX untuk satu pool: harga, ATH, drawdown, perubahan 1/6/24 jam, swing, stabil atau tidak, volume, tren volume, fee/TVL, porsi volume di Meteora, umur, fase lifecycle, dan draft rencana dari rule engine.",
      parameters: { type: "object", properties: { pool: poolArg }, required: ["pool"] },
    },
  },
  {
    type: "function",
    function: {
      name: "check_risk",
      description: "RugCheck (danger dan warning) dan PvP: porsi volume token lain dengan ticker sama.",
      parameters: { type: "object", properties: { pool: poolArg }, required: ["pool"] },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_bin_steps",
      description:
        "Daftar semua pool DLMM token ini yang dipasangkan dengan SOL (bin step berbeda), dengan TVL, volume, fee/TVL, base fee, jumlah bin yang dibutuhkan untuk range yang diminta, apakah muat, dan jenis transaksi.",
      parameters: {
        type: "object",
        properties: {
          pool: poolArg,
          range_pct: { type: "number", description: "Lebar range di bawah harga, persen (15-85)" },
          shape: shapeArg,
        },
        required: ["pool", "range_pct", "shape"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "simulate_position",
      description:
        "Simulasi posisi one-sided SOL: nilai posisi (sebelum fee) kalau harga turun 5%..dasar range, persen range terisi, dan estimasi fee per hari dari fee/TVL 24 jam pool.",
      parameters: {
        type: "object",
        properties: {
          pool: poolArg,
          range_pct: { type: "number" },
          shape: shapeArg,
          size_sol: { type: "number" },
        },
        required: ["pool", "range_pct", "shape", "size_sol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skip_candidate",
      description: "Coret satu kandidat dengan alasan. Dicatat di jurnal dan tidak dicek ulang selama 30 menit.",
      parameters: {
        type: "object",
        properties: { pool: poolArg, reason: { type: "string" } },
        required: ["pool", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_position",
      description: "Keputusan akhir: buka satu posisi. Mengakhiri loop kalau lolos pagar.",
      parameters: {
        type: "object",
        properties: {
          pool: poolArg,
          strategy: { type: "string", enum: STRATEGY_IDS },
          shape: shapeArg,
          range_pct: { type: "number" },
          size_sol: { type: "number" },
          confidence: { type: "number", description: "0..1" },
          stop_loss_pct: { type: "number", description: "Opsional, hanya boleh lebih ketat dari template" },
          take_profit_pct: { type: "number", description: "Opsional, 5-60" },
          reasoning: { type: "string", description: "2-4 kalimat Bahasa Indonesia: kenapa token, bin step, range, dan size ini" },
        },
        required: ["pool", "strategy", "shape", "range_pct", "size_sol", "confidence", "reasoning"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skip_all",
      description: "Keputusan akhir: tidak membuka posisi di siklus ini.",
      parameters: { type: "object", properties: { reasoning: { type: "string" } }, required: ["reasoning"] },
    },
  },
];

export interface DecisionData {
  action: "open" | "skip";
  pool?: string;
  name?: string;
  binStep?: number;
  strategy?: string;
  shape?: ShapeName;
  rangePct?: number;
  bins?: number;
  sizeSol?: number;
  confidence?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  reasoning: string;
  iterations: number;
}

const r1 = (x: number) => Number(x.toFixed(1));
const r2 = (x: number) => Number(x.toFixed(2));
const usdK = (x: number) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${(x / 1e3).toFixed(0)}k`);
const signed = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;

function str(v: unknown): string {
  return typeof v === "string" ? clean(v) : "";
}

/** Model text goes straight onto the dashboard; keep its punctuation plain. */
function clean(text: string): string {
  return text.replace(/\s*\u2014\s*/g, ", ").trim();
}
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function summarizeAnalysis(a: Analysis) {
  const f = a.features;
  return {
    pool: f.pool,
    name: f.name,
    binStep: f.binStep,
    phase: a.phase,
    ageHours: r1(f.ageHours),
    mcapUsd: Math.round(f.mcapUsd),
    holders: f.holders,
    priceSol: f.priceSol,
    drawdownFromAthPct: r1(f.drawdownFromAthPct),
    athAgeHours: r1(f.athAgeHours),
    change1hPct: r1(f.change1hPct),
    change6hPct: r1(f.change6hPct),
    change24hPct: r1(f.change24hPct),
    range24hPct: r1(f.range24hPct),
    supportBelowPricePct: r1((1 - f.low24hSol / f.priceSol) * 100),
    swing15mPct: r1(f.swing15mPct),
    stabilized: f.stabilized,
    volume1hUsd: Math.round(f.volume1hUsd),
    volume24hUsd: Math.round(f.volume24hUsd),
    volumeTrend: r2(f.volumeTrend),
    feeTvl1hPct: r2(f.feeTvl1hPct),
    feeTvl24hPct: r2(f.feeTvl24hPct),
    tvlUsd: Math.round(f.tvlUsd),
    baseFeePct: f.baseFeePct,
    quoteOnlyFees: f.quoteOnlyFees,
    meteoraShare: f.meteoraShare !== undefined ? r2(f.meteoraShare) : null,
    ruleEngineDraft: a.draft
      ? { strategy: a.draft.strategy, shape: a.draft.shape, rangePct: r1(a.draft.rangePct), notes: a.draft.notes }
      : `tidak ada strategi (fase ${a.phase})`,
  };
}

/**
 * Entry decisions by an LLM working in a tool-calling loop: it pulls chart,
 * risk, bin-step and simulation data until it commits to one position or to
 * none. Every proposal is re-checked against hard rules before it is returned.
 */
export class AiDecider implements EntryDecider {
  readonly mode = "ai" as const;
  private readonly llm: DeepSeek;
  /** Pools struck via skip_candidate in the current decide() call. */
  private readonly skipped = new Set<string>();

  constructor(
    private readonly cfg: AgentConfig,
    private readonly research: (universe: Pool[]) => Research,
    private readonly tracer: Tracer,
  ) {
    this.llm = new DeepSeek(cfg.llm);
  }

  get label(): string {
    return `${this.llm.label} ${this.llm.model}`;
  }

  async decide(input: DecisionInput): Promise<EntryProposal | null> {
    const step = this.tracer.step("ai", "Keputusan AI");
    const research = this.research(input.universe);
    this.skipped.clear();
    const maxSteps = this.cfg.llm.maxSteps;
    const context = {
      bankrollSol: r2(input.bankrollSol),
      budgetSol: r2(input.budgetSol),
      sizeLimits: {
        minPositionSol: this.cfg.opening.minPositionSol,
        maxPositionSol: this.cfg.opening.maxPositionSol,
        note: "maxSizeSol per kandidat sudah memperhitungkan mcap, budget, dan hari Sabtu; warning RugCheck memotongnya 20% lagi",
      },
      maxBinsPerPosition: this.cfg.opening.maxBinsPerPosition,
      allowAggressive: this.cfg.opening.allowAggressive,
      saturday: new Date().getUTCDay() === 6,
      sol: { change1hPct: r2(input.market.solChange1h), change24hPct: r2(input.market.solChange24h) },
      openPositions: input.openPositions,
      candidates: input.candidates.map((c) => ({
        pool: c.pool.address,
        name: c.pool.name,
        binStep: c.pool.pool_config.bin_step,
        baseFeePct: c.pool.pool_config.base_fee_pct,
        tvlUsd: Math.round(c.pool.tvl),
        volume1hUsd: Math.round(c.pool.volume?.["1h"] ?? 0),
        feeTvl24hPct: r2(c.pool.fee_tvl_ratio?.["24h"] ?? 0),
        feeTvl4hPct: r2(c.pool.fee_tvl_ratio?.["4h"] ?? 0),
        mcapUsd: Math.round(this.mcapOf(c.pool)),
        maxSizeSol: r2(this.sizeCap(this.mcapOf(c.pool), 0, input)),
        screenScore: r2(c.score),
        otherBinSteps: c.alternatives.filter((p) => p.address !== c.pool.address).map((p) => p.pool_config.bin_step),
      })),
      maxToolRounds: maxSteps,
    };

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Konteks siklus ini (json):\n${JSON.stringify(context)}` },
    ];

    step.note(`${input.candidates.length} kandidat diserahkan ke ${this.label}. Maksimal ${maxSteps} putaran.`);
    let nudged = false;

    for (let round = 1; round <= maxSteps; round++) {
      let reply;
      try {
        reply = await this.llm.chat(messages, TOOLS);
      } catch (e) {
        log.warn(`DeepSeek decision call failed: ${(e as Error).message}`);
        step.fail(`${this.llm.label} tidak bisa dihubungi (${(e as Error).message}). Tidak ada posisi baru (fail-closed).`);
        return null;
      }
      messages.push(reply);

      const thought = clean(reply.content ?? "") || clean(reply.reasoning_content ?? "");
      if (thought) {
        const t = step.child("think", `Putaran ${round}`);
        t.done(thought.length > 900 ? `${thought.slice(0, 900)}...` : thought);
      }

      if (!reply.tool_calls?.length) {
        if (nudged) {
          step.skip("AI berhenti tanpa keputusan. Tidak ada posisi baru.");
          return null;
        }
        nudged = true;
        messages.push({ role: "user", content: "Lanjutkan dengan memanggil tool. Akhiri dengan open_position atau skip_all." });
        continue;
      }

      for (const call of reply.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "argumen bukan JSON valid" }) });
          continue;
        }
        const out = await this.runTool(call.function.name, args, research, input, step, round);
        if (out.final !== undefined) {
          // Remaining calls in this turn are moot once a final decision lands.
          return out.final;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out.result) });
      }
    }

    step.skip(`Batas ${maxSteps} putaran habis sebelum AI memutuskan. Tidak ada posisi baru.`);
    return null;
  }

  private async runTool(
    name: string,
    args: Record<string, unknown>,
    research: Research,
    input: DecisionInput,
    parent: StepHandle,
    round: number,
  ): Promise<{ result?: unknown; final?: EntryProposal | null }> {
    const address = str(args.pool);
    const poolName = research.pool(address)?.name ?? (address ? `${address.slice(0, 4)}...` : "?");

    switch (name) {
      case "analyze_token": {
        const s = parent.child("tool", `Analisa chart ${poolName}`);
        const a = await research.analyze(address);
        if (typeof a === "string") {
          s.fail(a);
          return { result: { error: a } };
        }
        const f = a.features;
        s.done(
          `Fase ${a.phase}. Drawdown ${f.drawdownFromAthPct.toFixed(0)}% dari ATH, 1 jam ${signed(f.change1hPct)}, ` +
            `swing 15m ${f.swing15mPct.toFixed(1)}%, volume 1 jam ${usdK(f.volume1hUsd)}, fee/TVL 24 jam ${f.feeTvl24hPct.toFixed(1)}%` +
            (a.draft ? `. Draft rule: ${a.draft.strategy} ${a.draft.shape} -${a.draft.rangePct.toFixed(0)}%.` : "."),
        );
        return { result: summarizeAnalysis(a) };
      }

      case "check_risk": {
        const s = parent.child("tool", `Cek risiko ${poolName}`);
        const pending = research.risk(address);
        if (typeof pending === "string") {
          s.fail(pending);
          return { result: { error: pending } };
        }
        const r = await pending;
        const rug = r.rug
          ? `RugCheck ${r.rug.dangers.length} danger${r.rug.dangers.length ? ` (${r.rug.dangers.join(", ")})` : ""}, ${r.rug.warnings.length} warning`
          : "RugCheck tidak bisa diakses";
        const detail = `${rug}. PvP ${(r.pvp * 100).toFixed(0)}%.`;
        if (!r.rug || r.rug.dangers.length || r.pvp >= 0.3) s.fail(detail);
        else s.done(detail);
        return {
          result: {
            rugcheck: r.rug ?? "tidak bisa diakses: anggap tidak lolos",
            pvpRivalShare: r2(r.pvp),
          },
        };
      }

      case "compare_bin_steps": {
        const range = num(args.range_pct);
        const shape = (SHAPES.includes(args.shape as ShapeName) ? args.shape : "BidAsk") as ShapeName;
        const s = parent.child("binsteps", `Bandingkan bin step ${poolName}`);
        const rows = await research.binSteps(address, Number.isFinite(range) ? range : 50, shape);
        if (typeof rows === "string") {
          s.fail(rows);
          return { result: { error: rows } };
        }
        s.attach({ rangePct: range, shape, rows });
        s.done(
          `${rows.length} pool untuk range -${range.toFixed(0)}%: ` +
            rows.map((x) => `bin ${x.binStep} (${x.bins} bin${!x.fits ? ", tidak muat" : x.shrunk ? `, range jadi -${x.rangePct.toFixed(0)}%` : ""})`).join(", ") +
            ".",
        );
        return { result: { maxBinsPerPosition: this.cfg.opening.maxBinsPerPosition, pools: rows } };
      }

      case "simulate_position": {
        const s = parent.child("simulate", `Simulasi ${poolName}`);
        const a = await research.analyze(address);
        if (typeof a === "string") {
          s.fail(a);
          return { result: { error: a } };
        }
        const range = num(args.range_pct);
        const size = num(args.size_sol);
        const shape = (SHAPES.includes(args.shape as ShapeName) ? args.shape : "BidAsk") as ShapeName;
        if (!Number.isFinite(range) || !Number.isFinite(size) || size <= 0) {
          s.fail("Argumen range atau size tidak valid.");
          return { result: { error: "range_pct dan size_sol harus angka positif" } };
        }
        const sim = research.simulate(a, Math.min(85, Math.max(15, range)), shape, size);
        s.attach({ pool: a.features.pool, shape, sizeSol: size, binStep: a.features.binStep, ...sim });
        const bottom = sim.rows.find((x) => x.dropPct === Math.round(sim.rangePct));
        s.done(
          `${shape} -${sim.rangePct}% (${sim.bins} bin), ${size.toFixed(2)} SOL. ` +
            (bottom ? `Di dasar range nilai ${bottom.valueSol} SOL (${signed(bottom.pnlPct)}). ` : "") +
            `Estimasi fee ${sim.feePerDaySol} SOL/hari selama di range.`,
        );
        return { result: sim };
      }

      case "skip_candidate": {
        const pool = research.pool(address);
        const reason = str(args.reason) || "dicoret AI";
        const s = parent.child("tool", `Coret ${poolName}`);
        if (!pool) {
          s.fail("Pool tidak dikenal.");
          return { result: { error: "pool tidak dikenal" } };
        }
        await input.onSkip(pool, `AI: ${reason}`);
        this.skipped.add(pool.address);
        s.skip(reason);
        return { result: { ok: true } };
      }

      case "skip_all": {
        const reasoning = str(args.reasoning) || "Tidak ada kandidat yang layak.";
        // Same cooldown as skip_candidate, so the next cycle doesn't pay to re-read the same charts.
        for (const cand of input.candidates) {
          if (this.skipped.has(cand.pool.address)) continue;
          if (await research.cachedAnalysis(cand.pool.address)) await input.onSkip(cand.pool, `AI tidak memilih: ${reasoning}`);
        }
        const s = parent.child("decision", "Keputusan: tidak buka posisi");
        s.attach({ action: "skip", reasoning, iterations: round } satisfies DecisionData);
        s.skip(reasoning);
        parent.skip(`Tidak buka posisi setelah ${round} putaran. ${reasoning}`);
        return { final: null };
      }

      case "open_position": {
        const checked = await this.validate(args, research, input);
        if (typeof checked === "string") {
          const s = parent.child("guard", `Ditolak pagar: ${poolName}`);
          s.fail(checked);
          return { result: { rejected: checked, hint: "Perbaiki lalu panggil open_position lagi, atau skip_all." } };
        }
        const p = checked;
        const data: DecisionData = {
          action: "open",
          pool: p.pool.address,
          name: p.pool.name,
          binStep: p.features.binStep,
          strategy: p.plan.strategy,
          shape: p.plan.shape,
          rangePct: r1(pctForBins(p.bins, p.features.binStep)),
          bins: p.bins,
          sizeSol: r2(p.sizeSol),
          confidence: p.confidence,
          stopLossPct: p.plan.exits.stopLossPct,
          takeProfitPct: p.plan.exits.takeProfitPct,
          reasoning: str(args.reasoning),
          iterations: round,
        };
        const s = parent.child("decision", `Keputusan: buka ${p.pool.name}`);
        s.attach(data);
        s.done(str(args.reasoning));
        parent.done(
          `${p.pool.name} bin step ${p.features.binStep}, ${p.plan.shape} -${data.rangePct}%, ${data.sizeSol} SOL ` +
            `(yakin ${Math.round((p.confidence ?? 0) * 100)}%, ${round} putaran).`,
        );
        return { final: p };
      }

      default:
        return { result: { error: `tool ${name} tidak ada` } };
    }
  }

  private mcapOf(pool: Pool): number {
    return (pool.token_x.address === tokenMintOf(pool) ? pool.token_x : pool.token_y).market_cap ?? 0;
  }

  /** Largest entry allowed for a token, SOL. */
  private sizeCap(mcapUsd: number, rugWarnings: number, input: DecisionInput): number {
    const c = this.cfg.opening;
    let capPct = Math.min(18, baseSizePct(mcapUsd) * 1.5);
    if (rugWarnings > 0) capPct *= 0.8;
    if (new Date().getUTCDay() === 6) capPct *= c.weekendSizeFactor;
    return Math.min(c.maxPositionSol, input.budgetSol, input.bankrollSol * (capPct / 100));
  }

  /** Hard rules the AI cannot override. Returns a reason string when the entry is refused. */
  private async validate(
    args: Record<string, unknown>,
    research: Research,
    input: DecisionInput,
  ): Promise<EntryProposal | string> {
    const c = this.cfg;
    const pool = research.pool(str(args.pool));
    if (!pool) return "pool tidak dikenal";
    const mint = tokenMintOf(pool);
    if (!input.candidates.some((cand) => tokenMintOf(cand.pool) === mint)) {
      return "token ini bukan kandidat siklus ini";
    }
    if (!research.hasRisk(mint)) return "panggil check_risk dulu untuk token ini";

    const a = await research.analyze(pool.address);
    if (typeof a === "string") return `analisa gagal: ${a}`;
    const risk = await research.risk(pool.address);
    if (typeof risk === "string") return risk;
    if (!risk.rug) return "RugCheck tidak bisa diakses (fail-closed)";
    if (risk.rug.dangers.length) return `RugCheck danger: ${risk.rug.dangers.join(", ")}`;
    if (risk.pvp >= 0.3) return `PvP ${(risk.pvp * 100).toFixed(0)}%, batas 30%`;

    const f = a.features;
    if (f.ageHours < c.screening.minAgeHours) return `umur token ${f.ageHours.toFixed(1)} jam, minimal ${c.screening.minAgeHours}`;
    if (a.phase === "DEAD" || a.phase === "FALLING_KNIFE") return `fase ${a.phase} tidak boleh dibuka`;

    const strategy = str(args.strategy) as StrategyId;
    if (!STRATEGY_IDS.includes(strategy)) return `strategi ${strategy} tidak dikenal`;
    if (strategy === "S4_HEART_ATTACK" && !c.opening.allowAggressive) return "S4 butuh ALLOW_AGGRESSIVE=true";
    const shape = str(args.shape) as ShapeName;
    if (!SHAPES.includes(shape)) return `shape ${shape} tidak dikenal`;

    const askedRange = num(args.range_pct);
    if (!(askedRange >= 15 && askedRange <= 85)) return "range_pct harus 15-85";
    const fit = fitRange(askedRange, f.binStep, c.opening.maxBinsPerPosition);
    if (!fit.ok) {
      return `range -${askedRange}% di bin step ${f.binStep} butuh ${binsForPct(askedRange, f.binStep)} bin, batas ${c.opening.maxBinsPerPosition} (paling lebar -${fit.rangePct.toFixed(0)}%). Pilih bin step lebih besar atau range lebih sempit.`;
    }
    const { rangePct, bins } = fit;

    const confidence = num(args.confidence);
    if (!(confidence >= MIN_CONFIDENCE)) return `confidence ${args.confidence} di bawah ${MIN_CONFIDENCE}`;

    const cap = this.sizeCap(f.mcapUsd, risk.rug.warnings.length, input);
    const asked = num(args.size_sol);
    if (!(asked > 0)) return "size_sol harus angka positif";
    const sizeSol = Math.min(asked, cap);
    if (sizeSol < c.opening.minPositionSol) {
      return `size ${sizeSol.toFixed(3)} SOL di bawah minimum ${c.opening.minPositionSol} (batas token ini ${cap.toFixed(3)} SOL)`;
    }

    const template = STRATEGY_EXITS[strategy];
    const exits = { ...template };
    const sl = num(args.stop_loss_pct);
    if (Number.isFinite(sl)) {
      if (sl > template.stopLossPct) return `stop loss ${sl}% lebih longgar dari template ${template.stopLossPct}%`;
      exits.stopLossPct = Math.max(3, sl);
    }
    const tp = num(args.take_profit_pct);
    if (Number.isFinite(tp)) exits.takeProfitPct = Math.min(60, Math.max(5, tp));

    const plan: Plan = {
      strategy,
      phase: a.phase,
      shape,
      rangePct,
      sizeFactor: 1,
      exits,
      notes: [`AI ${this.label}`],
    };
    const clipped = sizeSol < asked ? ` Size dipotong dari ${asked.toFixed(3)} ke batas ${sizeSol.toFixed(3)} SOL.` : "";
    const narrowed = fit.shrunk ? ` Range dikecilkan dari -${askedRange}% supaya muat ${bins} bin.` : "";
    const reasoning =
      `${a.phase}: ${strategy} ${shape} -${pctForBins(bins, f.binStep).toFixed(0)}% (${bins} bin, bin step ${f.binStep}). ` +
      `${this.label} (yakin ${Math.round(confidence * 100)}%): ${str(args.reasoning)}${clipped}${narrowed}`;

    return {
      pool,
      features: f,
      plan,
      bins,
      sizeSol,
      rug: { dangers: risk.rug.dangers, warnings: risk.rug.warnings },
      pvp: risk.pvp,
      reasoning,
      decidedBy: "ai",
      confidence: Math.min(1, confidence),
    };
  }
}
