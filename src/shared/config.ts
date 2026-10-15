import "dotenv/config";

export interface AgentConfig {
  rpcUrl: string;
  privateKey: string;
  dryRun: boolean;
  intervalMs: number;
  /** PostgreSQL connection string (Prisma). */
  databaseUrl: string;
  /** Old JSON storage, read only by `npm run import-legacy`. */
  legacyStateFile: string;
  legacyJournalFile: string;

  execution: {
    priorityMicroLamports: number;
    slippagePct: number;
    swapSlippageBps: number;
    maxRetries: number;
    /** SOL kept in the wallet for rent + fees, never deployed. */
    reserveSol: number;
  };

  opening: {
    enabled: boolean;
    maxPositions: number;
    /** Max fraction of bankroll deployed across all positions. */
    maxDeployedPct: number;
    minPositionSol: number;
    maxPositionSol: number;
    /** Max bins per position (wider = more rent, more txs). */
    maxBinsPerPosition: number;
    /** Skip pools whose range needs new bin arrays costing more than this (non-refundable rent). */
    maxBinArrayCostSol: number;
    cooldownMs: number;
    /** Allow S4 "heart attack" tight spot plays (very high risk). */
    allowAggressive: boolean;
    /** Size multiplier on Saturdays (Modul 5.5: weekend volume thinner). */
    weekendSizeFactor: number;
  };

  screening: {
    pageSize: number;
    minTvlUsd: number;
    maxTvlUsd: number;
    minMcapUsd: number;
    maxMcapUsd: number;
    minAgeHours: number;
    minVolume1hUsd: number;
    minFeeTvl24hPct: number;
    minBinStep: number;
    deepCheckCount: number;
    blockedMints: string[];
  };

  risk: {
    dailyLossLimitSol: number;
    dailyProfitStopSol: number;
    solDump1hPct: number;
    solDump24hPct: number;
    rugCandlePct: number;
    outOfRangeBelowMaxMin: number;
    idleAboveMaxMin: number;
    volumeDecayRatio: number;
    claimFeeMinSol: number;
    sellFeeTokens: boolean;
  };

  llm: {
    enabled: boolean;
    apiKey: string;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    /** Tool-calling rounds the decision loop may use per cycle. */
    maxSteps: number;
  };

  telegram: {
    botToken: string;
    chatId: string;
  };

  api: {
    enabled: boolean;
    host: string;
    port: number;
    token: string;
    corsOrigin: string;
  };
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`Missing required env ${name}`);
  return v.trim();
}

function str(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? def : v.trim();
}

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env ${name} is not a number: ${v}`);
  return n;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return def;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

function list(name: string, def: string[]): string[] {
  const v = process.env[name];
  if (!v || v.trim() === "") return def;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(): AgentConfig {
  return {
    rpcUrl: req("RPC_URL"),
    privateKey: req("WALLET_PRIVATE_KEY"),
    dryRun: bool("DRY_RUN", true),
    intervalMs: num("INTERVAL_MS", 60_000),
    databaseUrl: req("DATABASE_URL"),
    legacyStateFile: str("STATE_FILE", "data/state.json"),
    legacyJournalFile: str("JOURNAL_FILE", "data/journal.jsonl"),

    execution: {
      priorityMicroLamports: num("PRIORITY_FEE_MICROLAMPORTS", 200_000),
      slippagePct: num("SLIPPAGE_PCT", 1),
      swapSlippageBps: num("SWAP_SLIPPAGE_BPS", 300),
      maxRetries: num("TX_MAX_RETRIES", 3),
      reserveSol: num("RESERVE_SOL", 0.15),
    },

    opening: {
      enabled: bool("OPENING_ENABLED", true),
      maxPositions: num("MAX_POSITIONS", 5),
      maxDeployedPct: num("MAX_DEPLOYED_PCT", 60),
      minPositionSol: num("MIN_POSITION_SOL", 0.1),
      maxPositionSol: num("MAX_POSITION_SOL", 2),
      maxBinsPerPosition: num("MAX_BINS_PER_POSITION", 140),
      maxBinArrayCostSol: num("MAX_BIN_ARRAY_COST_SOL", 0.2),
      cooldownMs: num("OPEN_COOLDOWN_MS", 2 * 60 * 60_000),
      allowAggressive: bool("ALLOW_AGGRESSIVE", false),
      weekendSizeFactor: num("WEEKEND_SIZE_FACTOR", 0.7),
    },

    screening: {
      pageSize: num("SCREEN_PAGE_SIZE", 150),
      minTvlUsd: num("MIN_TVL_USD", 10_000),
      maxTvlUsd: num("MAX_TVL_USD", 5_000_000),
      minMcapUsd: num("MIN_MCAP_USD", 1_000_000),
      maxMcapUsd: num("MAX_MCAP_USD", 5_000_000),
      minAgeHours: num("MIN_AGE_HOURS", 24),
      minVolume1hUsd: num("MIN_VOLUME_1H_USD", 30_000),
      minFeeTvl24hPct: num("MIN_FEE_TVL_24H_PCT", 3),
      minBinStep: num("MIN_BIN_STEP", 50),
      deepCheckCount: num("DEEP_CHECK_COUNT", 8),
      blockedMints: list("BLOCKED_MINTS", []),
    },

    risk: {
      dailyLossLimitSol: num("DAILY_LOSS_LIMIT_SOL", 1),
      dailyProfitStopSol: num("DAILY_PROFIT_STOP_SOL", 0),
      solDump1hPct: num("SOL_DUMP_1H_PCT", 4),
      solDump24hPct: num("SOL_DUMP_24H_PCT", 10),
      rugCandlePct: num("RUG_CANDLE_PCT", 40),
      outOfRangeBelowMaxMin: num("OOR_BELOW_MAX_MIN", 30),
      idleAboveMaxMin: num("IDLE_ABOVE_MAX_MIN", 90),
      volumeDecayRatio: num("VOLUME_DECAY_RATIO", 0.25),
      claimFeeMinSol: num("CLAIM_FEE_MIN_SOL", 0.05),
      sellFeeTokens: bool("SELL_FEE_TOKENS", true),
    },

    llm: llmConfig(),

    telegram: {
      botToken: str("TELEGRAM_BOT_TOKEN", ""),
      chatId: str("TELEGRAM_CHAT_ID", ""),
    },

    api: apiConfig(),
  };
}

/** DeepSeek decision loop turns on by itself when DEEPSEEK_API_KEY is set; LLM_ENABLED=false opts out. */
function llmConfig(): AgentConfig["llm"] {
  const apiKey = str("DEEPSEEK_API_KEY", "");
  const enabled = bool("LLM_ENABLED", apiKey !== "");
  if (enabled && !apiKey) throw new Error("LLM_ENABLED=true requires DEEPSEEK_API_KEY");
  return {
    enabled,
    apiKey,
    baseUrl: str("DEEPSEEK_BASE_URL", "https://api.deepseek.com").replace(/\/$/, ""),
    model: str("LLM_MODEL", "deepseek-flash"),
    timeoutMs: num("LLM_TIMEOUT_MS", 60_000),
    maxSteps: Math.max(3, num("LLM_MAX_STEPS", 14)),
  };
}

function apiConfig(): AgentConfig["api"] {
  const host = str("API_HOST", "127.0.0.1");
  const token = str("API_TOKEN", "");
  const local = ["127.0.0.1", "localhost", "::1"].includes(host);
  // An open dashboard API on a public interface would leak positions and allow pausing.
  if (!local && !token) throw new Error(`API_HOST=${host} requires API_TOKEN`);
  return {
    enabled: bool("API_ENABLED", true),
    host,
    port: num("API_PORT", 8787),
    token,
    corsOrigin: str("API_CORS_ORIGIN", "*"),
  };
}

