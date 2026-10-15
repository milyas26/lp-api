import type { AgentConfig } from "../../../shared/config";
import { sol } from "../../../shared/format";
import { log } from "../../../shared/logger";
import type { StepHandle, Tracer } from "../../activity/application/tracer";
import type { EntryDecider } from "../../decision/domain/entry-decider";
import type { ReadMarket } from "../../market/application/read-market.use-case";
import type { Market } from "../../market/domain/market";
import type { ManagePositions } from "../../positions/application/manage-positions.use-case";
import type { OpenPosition } from "../../positions/application/open-position.use-case";
import type { CandidateSkips } from "../../screening/application/candidate-skips";
import type { ScreenPools } from "../../screening/application/screen-pools.use-case";
import { rollDay } from "../domain/bot-state";
import type { BotStateRepository } from "../domain/bot-state.repository";
import type { BotSession } from "./bot-session";
import type { Funds } from "./funds";

/**
 * One bot cycle: SOL regime → manage open positions → opening gate →
 * screening → entry decision (AI loop or rule engine) → open at most one.
 */
export class RunCycle {
  constructor(
    private readonly cfg: AgentConfig,
    private readonly session: BotSession,
    private readonly botState: BotStateRepository,
    private readonly tracer: Tracer,
    private readonly readMarket: ReadMarket,
    private readonly managePositions: ManagePositions,
    private readonly screenPools: ScreenPools,
    private readonly decider: EntryDecider,
    private readonly openPosition: OpenPosition,
    private readonly funds: Funds,
    private readonly skips: CandidateSkips,
  ) {}

  async execute(): Promise<void> {
    this.tracer.startCycle();
    try {
      await this.body();
      this.tracer.endCycle(false);
    } catch (e) {
      this.tracer.endCycle(true);
      throw e;
    }
  }

  private async body(): Promise<void> {
    const yesterday = rollDay(this.session.state);
    if (yesterday) log.info(`new day; yesterday realized ${yesterday.realizedSol.toFixed(3)} SOL`);

    const market = await this.readMarket.execute();
    this.session.market = market;

    const deployedSol = await this.managePositions.execute(market);
    await this.botState.save(this.session.state);

    const free = await this.funds.walletSol();
    const bankroll = { freeSol: free, deployedSol, totalSol: free + deployedSol, at: Date.now() };
    this.session.bankroll = bankroll;
    const today = this.session.state.day.realizedSol;
    log.info(
      `bankroll≈${bankroll.totalSol.toFixed(3)} SOL (free ${free.toFixed(3)}, deployed ${deployedSol.toFixed(3)}) ` +
        `| today ${today >= 0 ? "+" : ""}${sol(today)}`,
    );

    const gateStep = this.tracer.step("gate", "Cek izin buka posisi baru");
    const gate = this.openingGate(market);
    if (gate) {
      gateStep.skip(gate);
      log.info(`opening paused: ${gate}`);
      return;
    }
    try {
      await this.maybeOpen(bankroll.totalSol, free, deployedSol, gateStep);
    } finally {
      await this.botState.save(this.session.state);
    }
  }

  private openingGate(market: Market): string | null {
    const c = this.cfg;
    const day = this.session.state.day;
    if (this.tracer.status.openingPaused) return "Dijeda dari dashboard.";
    if (!c.opening.enabled) return "OPENING_ENABLED=false di konfigurasi.";
    if (!market.known) return "Kondisi SOL belum diketahui siklus ini.";
    if (market.solDumping) return "SOL sedang volatil atau dump (Modul 9.4).";
    if (day.realizedSol <= -c.risk.dailyLossLimitSol) return `Batas rugi harian tercapai (${sol(day.realizedSol)}).`;
    if (c.risk.dailyProfitStopSol > 0 && day.realizedSol >= c.risk.dailyProfitStopSol) {
      return "Target profit harian tercapai. Berhenti dulu hari ini (Modul 9.7).";
    }
    const open = this.session.positions.length;
    if (open >= c.opening.maxPositions) return `Slot penuh (${open}/${c.opening.maxPositions} posisi).`;
    return null;
  }

  private async maybeOpen(bankroll: number, free: number, deployed: number, gateStep: StepHandle): Promise<void> {
    const c = this.cfg;
    const budget = Math.min(bankroll * (c.opening.maxDeployedPct / 100) - deployed, free - c.execution.reserveSol);
    if (budget < c.opening.minPositionSol) {
      gateStep.skip(`Budget tersisa ${sol(Math.max(0, budget))}, di bawah minimum ${sol(c.opening.minPositionSol)}.`);
      return;
    }
    gateStep.done(`Boleh buka posisi. Budget ${sol(budget)}.`);

    const { universe, ranked } = await this.screenPools.execute();
    if (ranked.length === 0) return;

    const m = this.session.market;
    const proposal = await this.decider.decide({
      candidates: ranked.slice(0, c.screening.deepCheckCount),
      universe,
      bankrollSol: bankroll,
      budgetSol: budget,
      market: { solChange1h: m?.solChange1h ?? 0, solChange24h: m?.solChange24h ?? 0 },
      openPositions: this.session.positions.map((x) => ({
        pool: x.poolName,
        token: x.tokenSymbol,
        strategy: x.strategy,
        pnlPct: x.lastPnlPct,
      })),
      onSkip: (pool, why, extra) => this.skips.record(pool, why, extra),
    });
    if (proposal) await this.openPosition.execute(proposal);
  }
}
