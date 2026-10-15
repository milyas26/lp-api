import { buildApp } from "./app";
import { createContainer } from "./container";
import { loadConfig } from "./shared/config";
import { log } from "./shared/logger";

function sleep(ms: number, signal: { stop: boolean }): Promise<void> {
  // Wake early on shutdown so SIGTERM doesn't wait out a long interval.
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (signal.stop || Date.now() - started >= ms) resolve();
      else setTimeout(tick, Math.min(1_000, ms));
    };
    tick();
  });
}

/** CLI: run (default) | once | status | close-all | import-legacy */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const cmd = process.argv[2] ?? "run";
  const c = await createContainer(cfg);

  try {
    switch (cmd) {
      case "status": {
        const s = c.session.state;
        console.log(JSON.stringify({ day: s.day, paperBalanceSol: s.paperBalanceSol, positions: c.session.positions }, null, 2));
        return;
      }
      case "import-legacy":
        await c.importLegacy.execute(cfg.legacyStateFile, cfg.legacyJournalFile);
        return;
      case "close-all":
        log.warn("close-all: closing every position the bot opened");
        await c.closeAll.execute("manual close-all");
        return;
      case "open-test": {
        const [poolAddress, solArg, binsArg] = process.argv.slice(3);
        if (!poolAddress || !solArg) throw new Error("usage: open-test <poolAddress> <sol> [bins] [--send]");
        const input = {
          poolAddress,
          sizeSol: Number(solArg),
          bins: binsArg && !binsArg.startsWith("--") ? Number(binsArg) : 20,
          shape: "BidAsk" as const,
          send: process.argv.includes("--send"),
        };
        console.log(JSON.stringify(input.send ? await c.forceOpen.execute(input) : await c.forceOpen.preview(input), null, 2));
        return;
      }
      case "once":
        await c.runCycle.execute();
        return;
      case "run":
        await runLoop(c);
        return;
      default:
        throw new Error(`unknown command ${cmd} (run | once | status | close-all | import-legacy)`);
    }
  } finally {
    await c.shutdown();
  }
}

async function runLoop(c: Awaited<ReturnType<typeof createContainer>>): Promise<void> {
  const { cfg, tracer } = c;
  const app = cfg.api.enabled ? await buildApp(c) : null;
  if (app) {
    await app.listen({ host: cfg.api.host, port: cfg.api.port });
    log.info(`api listening on http://${cfg.api.host}:${cfg.api.port}${cfg.api.token ? "" : " (no API_TOKEN: localhost only)"}`);
  }

  log.info(
    `lp-agent start | wallet=${c.wallet} interval=${cfg.intervalMs}ms dryRun=${cfg.dryRun} ` +
      `decision=${c.overview.snapshot().llm ?? "rule engine"} storage=${c.overview.snapshot().storage}`,
  );
  if (cfg.dryRun) log.warn("DRY_RUN=true: paper trading, no transactions will be sent");

  const signal = { stop: false };
  const stop = (sig: string) => {
    log.warn(`${sig} received, stopping after current cycle (positions stay open)`);
    signal.stop = true;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  let failures = 0;
  while (!signal.stop) {
    // The cycle and its hand-off to "sleeping" share the lock with dashboard actions
    // (manual close), so those always start from a settled status.
    const wait = await c.lock.run(async () => {
      const started = Date.now();
      try {
        await c.runCycle.execute();
        failures = 0;
      } catch (e) {
        failures++;
        log.error(`cycle failed (${failures} in a row)`, e);
      }
      // Back off on repeated failures (RPC/API outage) instead of hammering.
      const backoff = Math.min(failures, 5) * cfg.intervalMs;
      const ms = Math.max(1_000, cfg.intervalMs - (Date.now() - started)) + backoff;
      if (!signal.stop) tracer.setStatus({ state: "sleeping", nextCycleAt: Date.now() + ms });
      return ms;
    });
    if (signal.stop) break;
    await sleep(wait, signal);
  }
  tracer.setStatus({ state: "stopped", nextCycleAt: undefined });
  await app?.close();
  log.info("lp-agent stopped");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    log.error("fatal", e);
    process.exit(1);
  });
