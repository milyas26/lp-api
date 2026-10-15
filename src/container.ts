import { Connection } from "@solana/web3.js";
import type { AgentConfig } from "./shared/config";
import { log } from "./shared/logger";
import { Mutex } from "./shared/mutex";
import { createPrisma, databaseLabel } from "./shared/prisma";
import { loadKeypair } from "./shared/solana/keypair";
import { Notifier } from "./shared/telegram";
import { KEEP_CYCLES, Tracer } from "./modules/activity/application/tracer";
import type { Cycle } from "./modules/activity/domain/cycle";
import { PrismaCycleRepository } from "./modules/activity/infrastructure/prisma-cycle.repository";
import { BotOverview } from "./modules/bot/application/bot-overview";
import { BotSession } from "./modules/bot/application/bot-session";
import { CloseAll } from "./modules/bot/application/close-all.use-case";
import { Funds } from "./modules/bot/application/funds";
import { ImportLegacy } from "./modules/bot/application/import-legacy.use-case";
import { RunCycle } from "./modules/bot/application/run-cycle.use-case";
import { WalletBalance } from "./modules/bot/application/wallet-balance";
import { freshBotState } from "./modules/bot/domain/bot-state";
import { PrismaBotStateRepository } from "./modules/bot/infrastructure/prisma-bot-state.repository";
import { AiDecider } from "./modules/decision/application/ai-decider";
import { Research } from "./modules/decision/application/research";
import { RuleDecider } from "./modules/decision/application/rule-decider";
import type { EntryDecider } from "./modules/decision/domain/entry-decider";
import { ExecutionService } from "./modules/execution/application/execution.service";
import { JournalService } from "./modules/journal/application/journal.service";
import { PrismaJournalRepository } from "./modules/journal/infrastructure/prisma-journal.repository";
import { ReadMarket } from "./modules/market/application/read-market.use-case";
import { ClosePosition } from "./modules/positions/application/close-position.use-case";
import { ForceOpen } from "./modules/positions/application/force-open.use-case";
import { ManagePositions } from "./modules/positions/application/manage-positions.use-case";
import { OnchainPositions } from "./modules/positions/application/onchain-positions.use-case";
import { OpenPosition } from "./modules/positions/application/open-position.use-case";
import { PositionIl } from "./modules/positions/application/position-il.use-case";
import { PrismaPositionRepository } from "./modules/positions/infrastructure/prisma-position.repository";
import { CandidateSkips } from "./modules/screening/application/candidate-skips";
import { ScreenPools } from "./modules/screening/application/screen-pools.use-case";
import { SettingsService } from "./modules/settings/application/settings.service";
import { PrismaSettingsRepository } from "./modules/settings/infrastructure/prisma-settings.repository";

const PAPER_START_SOL = 10;

export type Container = Awaited<ReturnType<typeof createContainer>>;

/** Composition root: the only place that knows every concrete class. */
export async function createContainer(cfg: AgentConfig) {
  const prisma = createPrisma(cfg.databaseUrl);
  const positionRepo = new PrismaPositionRepository(prisma);
  const botStateRepo = new PrismaBotStateRepository(prisma);
  const journalRepo = new PrismaJournalRepository(prisma);
  const cycleRepo = new PrismaCycleRepository(prisma);

  // Dashboard overrides go into cfg before anything reads it.
  const settings = new SettingsService(cfg, new PrismaSettingsRepository(prisma));
  await settings.load();

  const state = (await botStateRepo.load()) ?? freshBotState();
  if (cfg.dryRun && state.paperBalanceSol === undefined) state.paperBalanceSol = PAPER_START_SOL;
  const session = new BotSession(state);
  session.positions = await positionRepo.findOpen();

  // Finished cycles go to the database in order; shutdown waits for the queue.
  const tracer = new Tracer();
  tracer.restore(await cycleRepo.recent(KEEP_CYCLES));
  let cycleSaves: Promise<void> = Promise.resolve();
  tracer.on("cycle", (c: Cycle) => {
    if (c.status === "running") return;
    const snapshot = structuredClone(c);
    cycleSaves = cycleSaves.then(() => cycleRepo.save(snapshot).catch((e) => log.warn("cycle save failed", e)));
  });

  const user = loadKeypair(cfg.privateKey);
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const notifier = new Notifier(cfg.telegram.botToken, cfg.telegram.chatId);
  const journal = new JournalService(journalRepo);
  const execution = new ExecutionService(cfg, connection, user);
  const funds = new Funds(cfg.dryRun, connection, user.publicKey, session);
  const walletBalance = new WalletBalance(connection, user.publicKey);
  const skips = new CandidateSkips(session, journal);

  const decider: EntryDecider = cfg.llm.enabled
    ? new AiDecider(cfg, (universe) => new Research(cfg, connection, universe), tracer)
    : new RuleDecider(cfg, tracer);

  const managePositions = new ManagePositions(cfg, session, positionRepo, execution, funds, journal, notifier, tracer);
  const openPosition = new OpenPosition(cfg, session, positionRepo, execution, funds, journal, notifier, tracer, (pool, why) =>
    skips.record(pool, why),
  );
  const runCycle = new RunCycle(
    cfg,
    session,
    botStateRepo,
    tracer,
    new ReadMarket(cfg, tracer),
    managePositions,
    new ScreenPools(cfg, session, skips, tracer),
    decider,
    openPosition,
    funds,
    skips,
  );

  /** One bot action at a time: a cycle, or a close requested from the dashboard. */
  const lock = new Mutex();

  return {
    cfg,
    lock,
    settings,
    tracer,
    session,
    wallet: user.publicKey.toBase58(),
    walletBalance,
    positionRepo,
    journal,
    runCycle,
    closePosition: new ClosePosition(lock, session, botStateRepo, managePositions, tracer),
    onchainPositions: new OnchainPositions(execution),
    positionIl: new PositionIl(cfg, session, execution),
    forceOpen: new ForceOpen(cfg, session, positionRepo, execution, funds, journal, notifier),
    closeAll: new CloseAll(session, botStateRepo, managePositions, journal, tracer),
    overview: new BotOverview(cfg, session, tracer, decider, user.publicKey.toBase58(), databaseLabel(cfg.databaseUrl)),
    importLegacy: new ImportLegacy(botStateRepo, positionRepo, journalRepo),
    async shutdown(): Promise<void> {
      await cycleSaves;
      await prisma.$disconnect();
    },
  };
}
