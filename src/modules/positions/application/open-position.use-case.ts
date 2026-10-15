import type { AgentConfig } from "../../../shared/config";
import { sol } from "../../../shared/format";
import { log } from "../../../shared/logger";
import type { Notifier } from "../../../shared/telegram";
import type { Tracer } from "../../activity/application/tracer";
import type { BotSession } from "../../bot/application/bot-session";
import type { Funds } from "../../bot/application/funds";
import type { EntryProposal } from "../../decision/domain/entry-proposal";
import type { ExecutionService } from "../../execution/application/execution.service";
import type { JournalService } from "../../journal/application/journal.service";
import { tokenPriceSol } from "../../strategy/domain/features";
import { pctForBins } from "../../strategy/domain/range-math";
import type { TrackedPosition } from "../domain/position";
import type { PositionRepository } from "../domain/position.repository";

/** Opens one SOL-side position from a decided entry (paper or on-chain). */
export class OpenPosition {
  constructor(
    private readonly cfg: AgentConfig,
    private readonly session: BotSession,
    private readonly positions: PositionRepository,
    private readonly execution: ExecutionService,
    private readonly funds: Funds,
    private readonly journal: JournalService,
    private readonly notifier: Notifier,
    private readonly tracer: Tracer,
    /** Records a skipped pool in the journal and the skip cooldown. */
    private readonly onSkip: (pool: EntryProposal["pool"], why: string) => Promise<void>,
  ) {}

  async execute(p: EntryProposal): Promise<TrackedPosition | null> {
    const pool = p.pool;
    const f = p.features;
    const rangeActual = pctForBins(p.bins, f.binStep);
    const step = this.tracer.step("open", `Buka posisi ${pool.name}`);
    const summary =
      `${p.plan.strategy}, ${p.plan.shape} -${rangeActual.toFixed(1)}% (${p.bins} bin, bin step ${f.binStep}), ` +
      sol(p.sizeSol);
    step.note(`${summary}. Mengirim transaksi...`);
    log.warn(`OPEN ${pool.name} ${summary}${this.cfg.dryRun ? " [PAPER]" : ""}`);

    const base: Omit<
      TrackedPosition,
      "positionPubkey" | "minBinId" | "maxBinId" | "entryActiveBinId" | "openCostSol" | "openSigs"
    > = {
      poolAddress: pool.address,
      poolName: pool.name,
      tokenMint: f.tokenMint,
      tokenSymbol: f.tokenSymbol,
      solIsX: f.solIsX,
      strategy: p.plan.strategy,
      phase: p.plan.phase,
      shape: p.plan.shape,
      rangePct: rangeActual,
      binStep: f.binStep,
      decidedBy: p.decidedBy,
      confidence: p.confidence,
      entryPriceSol: f.priceSol,
      depositSol: p.sizeSol,
      claimedSol: 0,
      exits: p.plan.exits,
      openedAt: Date.now(),
      reasoning: p.reasoning,
      maxDepth: 0,
      lastValueSol: p.sizeSol,
      lastFeesSol: 0,
      lastDepth: 0,
      lastPnlPct: 0,
    };

    let tracked: TrackedPosition;
    if (this.cfg.dryRun) {
      tracked = {
        ...base,
        positionPubkey: `paper-${Date.now().toString(36)}`,
        minBinId: 0,
        maxBinId: p.bins - 1,
        entryActiveBinId: 0,
        openCostSol: p.sizeSol,
        openSigs: [],
        paper: {
          depositSol: p.sizeSol,
          priceTop: tokenPriceSol(pool) / (1 + f.binStep / 10_000),
          binStep: f.binStep,
          bins: p.bins,
          shape: p.plan.shape,
          feesSol: 0,
          lastTickAt: Date.now(),
        },
      };
      this.funds.adjustPaper(-p.sizeSol);
    } else {
      const dlmm = await this.execution.loadPool(pool.address);
      const quote = await this.execution.quoteOpen(dlmm, p.bins, p.plan.shape);
      if (quote.binArrayCostSol > this.cfg.opening.maxBinArrayCostSol) {
        const why = `rent bin array ${sol(quote.binArrayCostSol)} (tidak balik) terlalu mahal`;
        step.skip(`Dilewati: ${why}`);
        await this.onSkip(pool, why);
        return null;
      }
      const before = await this.funds.walletSol();
      if (before - p.sizeSol - quote.positionCostSol - quote.binArrayCostSol < this.cfg.execution.reserveSol) {
        const why = "saldo tidak cukup untuk size + rent + cadangan";
        step.skip(`Dilewati: ${why}`);
        await this.onSkip(pool, why);
        return null;
      }
      try {
        const res = await this.execution.openSolSide(dlmm, { sol: p.sizeSol, bins: p.bins, shape: p.plan.shape });
        const after = await this.funds.walletSol();
        tracked = {
          ...base,
          positionPubkey: res.positionPubkey,
          minBinId: res.range.minBinId,
          maxBinId: res.range.maxBinId,
          entryActiveBinId: res.activeBinId,
          openCostSol: before - after,
          openSigs: res.sigs,
        };
      } catch (e) {
        log.error(`open failed ${pool.name}`, e);
        step.fail(`Transaksi gagal: ${(e as Error).message}`);
        await this.onSkip(pool, "transaksi open gagal");
        return null;
      }
    }

    await this.positions.save(tracked);
    this.session.positions = [...this.session.positions, tracked];
    this.session.state.day.opened += 1;
    step.done(
      `${summary}. SL -${tracked.exits.stopLossPct}%, TP +${tracked.exits.takeProfitPct}%` +
        `${tracked.paper ? " (paper)" : ""}.`,
    );
    await this.journal.record({
      type: "open",
      position: tracked.positionPubkey,
      pool: pool.name,
      address: pool.address,
      strategy: tracked.strategy,
      phase: tracked.phase,
      shape: tracked.shape,
      rangePct: tracked.rangePct,
      binStep: tracked.binStep,
      decidedBy: tracked.decidedBy,
      confidence: tracked.confidence,
      depositSol: tracked.depositSol,
      exits: tracked.exits,
      reasoning: tracked.reasoning,
      paper: !!tracked.paper,
    });
    await this.notifier.send(
      `${tracked.paper ? "[PAPER] " : ""}OPEN ${pool.name} ${tracked.strategy}\n` +
        `${tracked.shape} -${tracked.rangePct.toFixed(0)}%, ${tracked.depositSol.toFixed(3)} SOL\n` +
        `SL -${tracked.exits.stopLossPct}% / TP +${tracked.exits.takeProfitPct}%\n${tracked.reasoning}`,
    );
    return tracked;
  }
}
