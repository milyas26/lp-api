import type { AgentConfig } from "../../../shared/config";
import { sol } from "../../../shared/format";
import { log } from "../../../shared/logger";
import { SOL_MINT } from "../../../shared/solana/constants";
import type { Notifier } from "../../../shared/telegram";
import type { BotSession } from "../../bot/application/bot-session";
import type { Funds } from "../../bot/application/funds";
import type { ExecutionService } from "../../execution/application/execution.service";
import type { JournalService } from "../../journal/application/journal.service";
import { fetchPool } from "../../screening/infrastructure/meteora-data.client";
import { tokenPriceSol } from "../../strategy/domain/features";
import { STRATEGY_EXITS } from "../../strategy/domain/playbook";
import { pctForBins } from "../../strategy/domain/range-math";
import type { ShapeName } from "../../strategy/domain/shape";
import type { TrackedPosition } from "../domain/position";
import type { PositionRepository } from "../domain/position.repository";

export interface ForceOpenInput {
  poolAddress: string;
  sizeSol: number;
  bins: number;
  shape: ShapeName;
  /** false = preview only; true = send the real transaction. */
  send: boolean;
}

export interface ForceOpenPreview {
  poolName: string;
  tokenSymbol: string;
  solIsX: boolean;
  binStep: number;
  activeBinId: number;
  priceSolPerToken: number;
  bins: number;
  range: { minBinId: number; maxBinId: number };
  sizeSol: number;
  positionCostSol: number;
  binArrayCostSol: number;
  txCount: number;
  walletSol: number;
  requiredSol: number;
  enough: boolean;
}

/**
 * Manual "open this pool now" for testing, bypassing screening and the AI.
 * Always previews cost vs wallet first; only `send` touches the chain, and it
 * records the position so the running bot manages and eventually closes it.
 */
export class ForceOpen {
  constructor(
    private readonly cfg: AgentConfig,
    private readonly session: BotSession,
    private readonly positions: PositionRepository,
    private readonly execution: ExecutionService,
    private readonly funds: Funds,
    private readonly journal: JournalService,
    private readonly notifier: Notifier,
  ) {}

  async preview(input: ForceOpenInput): Promise<ForceOpenPreview> {
    const pool = await fetchPool(input.poolAddress);
    const dlmm = await this.execution.loadPool(input.poolAddress);
    const active = await dlmm.getActiveBin();
    const quote = await this.execution.quoteOpen(dlmm, input.bins, input.shape);
    const solIsX = dlmm.tokenX.publicKey.toBase58() === SOL_MINT;
    const walletSol = await this.funds.onchainSol();
    const requiredSol = input.sizeSol + quote.positionCostSol + quote.binArrayCostSol + 0.001;
    return {
      poolName: pool.name,
      tokenSymbol: solIsX ? pool.token_y.symbol : pool.token_x.symbol,
      solIsX,
      binStep: pool.pool_config.bin_step,
      activeBinId: active.binId,
      priceSolPerToken: tokenPriceSol(pool),
      bins: input.bins,
      range: { minBinId: quote.range.minBinId, maxBinId: quote.range.maxBinId },
      sizeSol: input.sizeSol,
      positionCostSol: quote.positionCostSol,
      binArrayCostSol: quote.binArrayCostSol,
      txCount: quote.txCount,
      walletSol,
      requiredSol,
      enough: walletSol >= requiredSol,
    };
  }

  async execute(
    input: ForceOpenInput,
  ): Promise<
    | { outcome: "sent"; positionPubkey: string; sigs: string[] }
    | { outcome: "blocked"; reason: string }
    | { outcome: "failed"; error: string }
  > {
    const pv = await this.preview(input);
    if (!pv.enough) {
      return {
        outcome: "blocked",
        reason: `saldo kurang: butuh ${sol(pv.requiredSol, 4)}, wallet ${sol(pv.walletSol, 4)}`,
      };
    }
    const pool = await fetchPool(input.poolAddress);
    const dlmm = await this.execution.loadPool(input.poolAddress);
    const token = pv.solIsX ? pool.token_y : pool.token_x;
    const before = await this.funds.onchainSol();
    log.warn(`FORCE-OPEN ${pool.name}: ${sol(input.sizeSol)} ${input.bins} bin ${input.shape}`);
    try {
      const res = await this.execution.openSolSide(dlmm, { sol: input.sizeSol, bins: input.bins, shape: input.shape });
      const after = await this.funds.onchainSol();
      const tracked: TrackedPosition = {
        positionPubkey: res.positionPubkey,
        poolAddress: pool.address,
        poolName: pool.name,
        tokenMint: token.address,
        tokenSymbol: token.symbol,
        solIsX: pv.solIsX,
        strategy: "S2_WIDE_BIDASK",
        phase: "POST_TOP",
        shape: input.shape,
        rangePct: pctForBins(input.bins, pv.binStep),
        binStep: pv.binStep,
        decidedBy: "rules",
        entryPriceSol: pv.priceSolPerToken,
        depositSol: input.sizeSol,
        claimedSol: 0,
        exits: { ...STRATEGY_EXITS.S2_WIDE_BIDASK },
        openedAt: Date.now(),
        reasoning: `Manual force-open (test) ${pool.name}, ${input.bins} bin ${input.shape}, ${sol(input.sizeSol)}.`,
        maxDepth: 0,
        minBinId: res.range.minBinId,
        maxBinId: res.range.maxBinId,
        entryActiveBinId: res.activeBinId,
        openCostSol: before - after,
        openSigs: res.sigs,
        lastValueSol: input.sizeSol,
        lastFeesSol: 0,
        lastDepth: 0,
        lastPnlPct: 0,
      };
      await this.positions.save(tracked);
      this.session.positions = [...this.session.positions, tracked];
      this.session.state.day.opened += 1;
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
        depositSol: tracked.depositSol,
        exits: tracked.exits,
        reasoning: tracked.reasoning,
        paper: false,
      });
      await this.notifier.send(
        `FORCE-OPEN ${pool.name} ${input.shape}\n${input.bins} bin, ${sol(input.sizeSol)}\n` +
          `SL -${tracked.exits.stopLossPct}% / TP +${tracked.exits.takeProfitPct}%`,
      );
      return { outcome: "sent", positionPubkey: res.positionPubkey, sigs: res.sigs };
    } catch (e) {
      log.error("force-open failed", e);
      return { outcome: "failed", error: (e as Error).message };
    }
  }
}
