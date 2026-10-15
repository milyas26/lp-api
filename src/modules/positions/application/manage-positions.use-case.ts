import type DLMM from "@meteora-ag/dlmm";
import type { LbPosition } from "@meteora-ag/dlmm";
import type { AgentConfig } from "../../../shared/config";
import { pct, sol } from "../../../shared/format";
import { log } from "../../../shared/logger";
import type { Notifier } from "../../../shared/telegram";
import type { StepHandle, Tracer } from "../../activity/application/tracer";
import type { BotSession } from "../../bot/application/bot-session";
import type { Funds } from "../../bot/application/funds";
import { recordClose } from "../../bot/domain/bot-state";
import type { ExecutionService } from "../../execution/application/execution.service";
import type { JournalService } from "../../journal/application/journal.service";
import type { Market } from "../../market/domain/market";
import { fetchCandles } from "../../market/infrastructure/gecko.client";
import { fetchPool } from "../../screening/infrastructure/meteora-data.client";
import { tokenPriceSol } from "../../strategy/domain/features";
import { paperAccrue, paperValue } from "../../strategy/domain/paper-sim";
import { depthInRange } from "../../strategy/domain/range-math";
import { evaluateExit, trackSnapshot, type Snapshot } from "../domain/exit-rules";
import type { TrackedPosition } from "../domain/position";
import type { PositionRepository } from "../domain/position.repository";

type Onchain = Map<string, { dlmmPool: string; position: LbPosition }>;
type Live = { dlmm: DLMM; position: LbPosition };

function describeDepth(depth: number): string {
  if (depth <= 0) return "harga di atas range (belum terisi)";
  if (depth > 1) return "harga di bawah range";
  return `harga ${(depth * 100).toFixed(0)}% masuk range`;
}

/**
 * Modul 8: value every open position in SOL, run the exit rules, claim and
 * sell fees, close when a rule fires. Exits are never handed to the AI.
 */
export class ManagePositions {
  private readonly warnedUntracked = new Set<string>();

  constructor(
    private readonly cfg: AgentConfig,
    private readonly session: BotSession,
    private readonly positions: PositionRepository,
    private readonly execution: ExecutionService,
    private readonly funds: Funds,
    private readonly journal: JournalService,
    private readonly notifier: Notifier,
    private readonly tracer: Tracer,
  ) {}

  /** Returns the SOL value still deployed after this pass. */
  async execute(market: Market): Promise<number> {
    const tracked = await this.positions.findOpen();
    this.session.positions = tracked;
    const step = this.tracer.step("manage", "Kelola posisi terbuka");

    let onchain: Onchain = new Map();
    if (!this.cfg.dryRun) {
      onchain = await this.execution.onchainPositions();
      const ours = new Set(tracked.map((p) => p.positionPubkey));
      for (const pk of onchain.keys()) {
        if (!ours.has(pk) && !this.warnedUntracked.has(pk)) {
          this.warnedUntracked.add(pk);
          log.warn(`untracked position ${pk} (opened manually?), bot will not touch it`);
        }
      }
    }

    if (tracked.length === 0) {
      step.skip("Belum ada posisi terbuka.");
      return 0;
    }

    let deployed = 0;
    const pools = new Map<string, DLMM>();
    for (const p of tracked) {
      const child = step.child("position", p.poolName);
      try {
        deployed += (await this.manageOne(p, market, onchain, pools, child)).valueSol;
      } catch (e) {
        log.error(`manage ${p.poolName} ${p.positionPubkey} failed`, e);
        child.fail(`Gagal dicek: ${(e as Error).message}. Dicoba lagi siklus berikutnya.`);
        deployed += p.lastValueSol ?? p.depositSol;
      }
    }
    step.done(`${tracked.length} posisi dicek.`);
    this.session.positions = await this.positions.findOpen();
    return deployed;
  }

  /** Close everything (SOL dump, `close-all`). */
  async closeEverything(): Promise<void> {
    await this.execute({ known: true, solChange1h: 0, solChange24h: 0, solDumping: true });
  }

  /**
   * Close one position now, whatever the exit rules say (dashboard "Tutup posisi").
   * Returns null when the position is not open, otherwise the outcome.
   */
  async closeOne(pubkey: string, reason: string): Promise<{ closed: boolean; realizedSol?: number | null } | null> {
    const p = (await this.positions.findOpen()).find((x) => x.positionPubkey === pubkey);
    if (!p) return null;
    const step = this.tracer.step("manual", `Tutup manual ${p.poolName}`);
    const onchain: Onchain = this.cfg.dryRun ? new Map() : await this.execution.onchainPositions();
    const market: Market = { known: false, solChange1h: 0, solChange24h: 0, solDumping: false };
    try {
      const r = await this.manageOne(p, market, onchain, new Map(), step, reason);
      return r.closed ? { closed: true, realizedSol: r.closed.realizedSol } : { closed: false };
    } catch (e) {
      log.error(`manual close ${p.poolName} failed`, e);
      step.fail(`Gagal: ${(e as Error).message}`);
      return { closed: false };
    } finally {
      this.session.positions = await this.positions.findOpen();
    }
  }

  private async manageOne(
    p: TrackedPosition,
    market: Market,
    onchain: Onchain,
    pools: Map<string, DLMM>,
    step: StepHandle,
    force?: string,
  ): Promise<{ valueSol: number; closed?: { realizedSol: number | null } }> {
    const now = Date.now();
    const poolData = await fetchPool(p.poolAddress);
    const worstDrop = await this.worstRecentDrop(p.poolAddress);

    let liquiditySol: number;
    let feesSol: number;
    let feesInTokenSol = 0;
    let priceSol: number;
    let depth: number;
    let live: Live | null = null;

    if (p.paper) {
      priceSol = tokenPriceSol(poolData);
      paperAccrue(p.paper, priceSol, poolData.fee_tvl_ratio?.["1h"] ?? 0, now);
      const v = paperValue(p.paper, priceSol);
      liquiditySol = v.liquiditySol;
      feesSol = p.paper.feesSol;
      depth = v.depth;
    } else {
      let dlmm = pools.get(p.poolAddress);
      if (!dlmm) {
        dlmm = await this.execution.loadPool(p.poolAddress);
        pools.set(p.poolAddress, dlmm);
      }
      // The bulk enumeration can miss a position; confirm with a direct read before dropping it.
      const position =
        onchain.get(p.positionPubkey)?.position ??
        (await this.execution.getPosition(dlmm, p.positionPubkey).catch(() => undefined));
      if (!position) {
        log.warn(`${p.poolName} ${p.positionPubkey} no longer on-chain, dropping`);
        await this.journal.record({ type: "close", position: p.positionPubkey, pool: p.poolName, reason: "external" });
        await this.positions.markClosed(p.positionPubkey, "external", null);
        step.skip("Sudah tidak ada on-chain (ditutup di luar bot). Dihapus dari daftar.");
        return { valueSol: 0, closed: { realizedSol: null } };
      }
      const v = await this.execution.value(dlmm, position);
      liquiditySol = v.liquiditySol;
      feesSol = v.feesSol;
      feesInTokenSol = v.feesInTokenSol;
      priceSol = v.priceSolPerToken;
      depth = depthInRange(v.activeBinId, { minBinId: p.minBinId, maxBinId: p.maxBinId, bins: 0 }, p.solIsX);
      live = { dlmm, position };
    }

    const pnlSol = liquiditySol + feesSol + p.claimedSol - p.depositSol;
    const snap: Snapshot = {
      now,
      priceSol,
      depth,
      pnlPct: (pnlSol / p.depositSol) * 100,
      poolVolume1hUsd: poolData.volume?.["1h"] ?? 0,
      poolVolume24hUsd: poolData.volume?.["24h"] ?? 0,
      worstCandleDropPct: worstDrop,
    };
    trackSnapshot(p, snap);
    p.lastValueSol = liquiditySol + feesSol;
    p.lastFeesSol = feesSol;
    p.lastDepth = depth;
    p.lastCheckedAt = now;

    let exit = force ? { reason: force, urgent: true } : evaluateExit(p, snap, this.cfg);
    if (!exit && market.known && market.solDumping) exit = { reason: "sol-regime-dump", urgent: true };
    p.lastPriceSol = priceSol;

    const summary = `P&L ${pct(snap.pnlPct, 2)}, fee ${sol(feesSol, 4)}, ${describeDepth(depth)}`;
    log.info(`${p.poolName} [${p.strategy}] ${summary}`);

    if (exit) {
      step.note(`${summary}. Exit: ${exit.reason}. Menutup...`);
      const realizedSol = await this.close(p, exit.reason, liquiditySol + feesSol, live, step);
      if (realizedSol !== null) return { valueSol: 0, closed: { realizedSol } };
      await this.positions.save(p);
      return { valueSol: liquiditySol + feesSol };
    }

    // Modul 8.1: claim & sell token fees on coins we don't marry.
    if (live && feesSol >= this.cfg.risk.claimFeeMinSol) {
      step.note(`${summary}. Claim fee...`);
      await this.claim(p, live, feesSol, feesInTokenSol);
      step.done(`${summary}. Fee di-claim, posisi ditahan.`);
    } else {
      step.done(`${summary}. Tahan.`);
    }
    await this.positions.save(p);
    return { valueSol: liquiditySol + feesSol };
  }

  /** Worst single 15m candle body drop in the last hour, %. */
  private async worstRecentDrop(pool: string): Promise<number> {
    try {
      const c = await fetchCandles(pool, "minute", 15, 4);
      return Math.max(0, ...c.map((k) => (1 - k.l / k.o) * 100));
    } catch {
      return 0;
    }
  }

  private async claim(p: TrackedPosition, live: Live, feesSol: number, feesInTokenSol: number): Promise<void> {
    log.info(`claim ${p.poolName} fees≈${feesSol.toFixed(4)} SOL (token part ${feesInTokenSol.toFixed(4)})`);
    const before = await this.funds.walletSol();
    try {
      await this.execution.claim(live.dlmm, live.position);
      if (this.cfg.risk.sellFeeTokens && feesInTokenSol > 0) await this.execution.zapOut(p.tokenMint);
    } catch (e) {
      log.error(`claim failed ${p.positionPubkey}`, e);
    }
    const got = (await this.funds.walletSol()) - before;
    p.claimedSol += got;
    await this.journal.record({ type: "claim", position: p.positionPubkey, pool: p.poolName, sol: got });
  }

  /** Returns the realized SOL, or null when the close transaction failed (the position stays open and is retried). */
  private async close(
    p: TrackedPosition,
    reason: string,
    markValueSol: number,
    live: Live | null,
    step: StepHandle,
  ): Promise<number | null> {
    log.warn(`CLOSE ${p.poolName} ${p.positionPubkey} reason=${reason}`);
    let realized: number;
    let swapNote = "";

    if (p.paper || !live) {
      realized = markValueSol + p.claimedSol - p.depositSol;
      this.funds.adjustPaper(markValueSol);
    } else {
      const before = await this.funds.walletSol();
      try {
        const sigs = await this.execution.closeFully(live.dlmm, live.position);
        log.info(`withdrawn ${p.positionPubkey} sigs=${sigs.join(",")}`);
      } catch (e) {
        log.error(`close failed ${p.positionPubkey}; will retry next cycle`, e);
        step.fail(`Exit ${reason}, tapi transaksi close gagal. Dicoba lagi siklus berikutnya.`);
        return null;
      }
      if (!(await this.execution.zapOut(p.tokenMint))) swapNote = " Token sisa gagal dijual, masih di wallet.";
      const received = (await this.funds.walletSol()) - before;
      realized = received + p.claimedSol - p.openCostSol;
    }

    recordClose(this.session.state, p.poolAddress, realized);
    await this.positions.save(p);
    await this.positions.markClosed(p.positionPubkey, reason, realized);

    const heldMin = Math.round((Date.now() - p.openedAt) / 60_000);
    step.done(`Ditutup (${reason}). Hasil ${realized >= 0 ? "+" : ""}${sol(realized, 4)} setelah ${heldMin} menit.${swapNote}`);
    await this.journal.record({
      type: "close",
      position: p.positionPubkey,
      pool: p.poolName,
      strategy: p.strategy,
      reason,
      depositSol: p.depositSol,
      realizedSol: realized,
      heldMin,
      paper: !!p.paper,
    });
    await this.notifier.send(
      `${p.paper ? "[PAPER] " : ""}CLOSE ${p.poolName} (${p.strategy})\n` +
        `reason: ${reason}\nP&L: ${realized >= 0 ? "+" : ""}${realized.toFixed(4)} SOL, held ${heldMin}m`,
    );
    return realized;
  }
}
