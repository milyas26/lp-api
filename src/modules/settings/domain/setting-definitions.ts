/**
 * Config values the dashboard may change at runtime. Secrets, connection
 * strings, DRY_RUN and anything read only at startup stay in backend/.env.
 * Values are exposed in display units: raw = shown × scale (e.g. ms = seconds × 1000).
 */

export type SettingType = "number" | "integer" | "boolean" | "list";

export type SettingGroup = "cycle" | "opening" | "screening" | "risk" | "execution";

export interface SettingDef {
  /** Path into AgentConfig, e.g. "risk.dailyLossLimitSol". */
  key: string;
  env: string;
  group: SettingGroup;
  label: string;
  help: string;
  type: SettingType;
  unit?: string;
  min?: number;
  max?: number;
  scale?: number;
}

export const SETTING_GROUPS: { id: SettingGroup; label: string; help: string }[] = [
  { id: "cycle", label: "Siklus dan AI", help: "Seberapa sering bot berjalan dan seberapa lama AI boleh menimbang." },
  { id: "opening", label: "Buka posisi", help: "Batas ukuran dan jumlah posisi baru." },
  { id: "screening", label: "Screening pool", help: "Saringan awal sebelum kandidat dianalisa." },
  { id: "risk", label: "Risiko dan exit", help: "Batas harian dan aturan menutup posisi." },
  { id: "execution", label: "Eksekusi transaksi", help: "Hanya dipakai saat live, bukan paper." },
];

export const SETTING_DEFS: SettingDef[] = [
  // Cycle and AI
  { key: "intervalMs", env: "INTERVAL_MS", group: "cycle", label: "Jeda antar siklus", help: "Berlaku setelah jeda yang sedang berjalan selesai.", type: "integer", unit: "detik", min: 10, max: 3600, scale: 1000 },
  { key: "llm.maxSteps", env: "LLM_MAX_STEPS", group: "cycle", label: "Putaran AI per siklus", help: "Batas panggilan alat sebelum AI wajib memutuskan.", type: "integer", unit: "putaran", min: 3, max: 40 },
  { key: "llm.timeoutMs", env: "LLM_TIMEOUT_MS", group: "cycle", label: "Batas waktu jawaban AI", help: "Lewat dari ini, siklus tidak membuka posisi.", type: "integer", unit: "detik", min: 10, max: 300, scale: 1000 },

  // Opening
  { key: "opening.maxPositions", env: "MAX_POSITIONS", group: "opening", label: "Maksimal posisi terbuka", help: "Bot berhenti membuka posisi baru saat slot penuh.", type: "integer", unit: "posisi", min: 1, max: 20 },
  { key: "opening.maxDeployedPct", env: "MAX_DEPLOYED_PCT", group: "opening", label: "Maksimal modal terpasang", help: "Porsi total modal yang boleh ada di posisi.", type: "number", unit: "%", min: 1, max: 100 },
  { key: "opening.minPositionSol", env: "MIN_POSITION_SOL", group: "opening", label: "Size minimal per posisi", help: "Di bawah ini, kandidat dilewati.", type: "number", unit: "SOL", min: 0.01, max: 100 },
  { key: "opening.maxPositionSol", env: "MAX_POSITION_SOL", group: "opening", label: "Size maksimal per posisi", help: "Batas atas, AI tidak bisa melewatinya.", type: "number", unit: "SOL", min: 0.01, max: 100 },
  { key: "opening.maxBinsPerPosition", env: "MAX_BINS_PER_POSITION", group: "opening", label: "Maksimal bin per posisi", help: "Range lebih lebar butuh lebih banyak bin dan rent.", type: "integer", unit: "bin", min: 10, max: 1400 },
  { key: "opening.maxBinArrayCostSol", env: "MAX_BIN_ARRAY_COST_SOL", group: "opening", label: "Maksimal rent bin array", help: "Rent ini tidak kembali. Pool yang butuh lebih dilewati.", type: "number", unit: "SOL", min: 0, max: 5 },
  { key: "opening.cooldownMs", env: "OPEN_COOLDOWN_MS", group: "opening", label: "Jeda buka ulang pool yang sama", help: "Setelah posisi di pool ditutup.", type: "integer", unit: "menit", min: 0, max: 10_080, scale: 60_000 },
  { key: "opening.weekendSizeFactor", env: "WEEKEND_SIZE_FACTOR", group: "opening", label: "Pengali size hari Sabtu", help: "Volume akhir pekan lebih tipis. 1 berarti tidak dikurangi.", type: "number", unit: "x", min: 0.1, max: 1 },
  { key: "opening.allowAggressive", env: "ALLOW_AGGRESSIVE", group: "opening", label: "Izinkan strategi S4 Heart attack", help: "Spot sempit dengan risiko sangat tinggi.", type: "boolean" },

  // Screening
  { key: "screening.minTvlUsd", env: "MIN_TVL_USD", group: "screening", label: "TVL minimal", help: "", type: "number", unit: "USD", min: 0, max: 100_000_000 },
  { key: "screening.maxTvlUsd", env: "MAX_TVL_USD", group: "screening", label: "TVL maksimal", help: "Pool besar biasanya fee/TVL-nya kecil.", type: "number", unit: "USD", min: 0, max: 1_000_000_000 },
  { key: "screening.minMcapUsd", env: "MIN_MCAP_USD", group: "screening", label: "Market cap minimal", help: "", type: "number", unit: "USD", min: 0, max: 10_000_000_000 },
  { key: "screening.maxMcapUsd", env: "MAX_MCAP_USD", group: "screening", label: "Market cap maksimal", help: "Pool dengan mcap di atas ini dilewati.", type: "number", unit: "USD", min: 0, max: 10_000_000_000 },
  { key: "screening.minAgeHours", env: "MIN_AGE_HOURS", group: "screening", label: "Umur token minimal", help: "", type: "number", unit: "jam", min: 0, max: 10_000 },
  { key: "screening.minVolume1hUsd", env: "MIN_VOLUME_1H_USD", group: "screening", label: "Volume 1 jam minimal", help: "", type: "number", unit: "USD", min: 0, max: 100_000_000 },
  { key: "screening.minFeeTvl24hPct", env: "MIN_FEE_TVL_24H_PCT", group: "screening", label: "Fee/TVL 24 jam minimal", help: "", type: "number", unit: "%", min: 0, max: 1000 },
  { key: "screening.minBinStep", env: "MIN_BIN_STEP", group: "screening", label: "Bin step minimal", help: "", type: "integer", min: 1, max: 500 },
  { key: "screening.deepCheckCount", env: "DEEP_CHECK_COUNT", group: "screening", label: "Kandidat yang dianalisa", help: "Jumlah teratas yang diteruskan ke AI atau rule engine.", type: "integer", unit: "pool", min: 1, max: 30 },
  { key: "screening.pageSize", env: "SCREEN_PAGE_SIZE", group: "screening", label: "Pool yang diambil per siklus", help: "", type: "integer", unit: "pool", min: 20, max: 200 },
  { key: "screening.blockedMints", env: "BLOCKED_MINTS", group: "screening", label: "Token yang diblokir", help: "Alamat mint, satu per baris. Pool dengan token ini tidak pernah dibuka.", type: "list" },

  // Risk and exits
  { key: "risk.dailyLossLimitSol", env: "DAILY_LOSS_LIMIT_SOL", group: "risk", label: "Batas rugi harian", help: "Tercapai, bot berhenti membuka posisi sampai besok.", type: "number", unit: "SOL", min: 0, max: 1000 },
  { key: "risk.dailyProfitStopSol", env: "DAILY_PROFIT_STOP_SOL", group: "risk", label: "Target profit harian", help: "Tercapai, bot berhenti membuka posisi. 0 berarti mati.", type: "number", unit: "SOL", min: 0, max: 1000 },
  { key: "risk.solDump1hPct", env: "SOL_DUMP_1H_PCT", group: "risk", label: "SOL dump 1 jam", help: "Turun lebih dari ini, semua posisi ditutup.", type: "number", unit: "%", min: 0.5, max: 50 },
  { key: "risk.solDump24hPct", env: "SOL_DUMP_24H_PCT", group: "risk", label: "SOL dump 24 jam", help: "", type: "number", unit: "%", min: 0.5, max: 80 },
  { key: "risk.rugCandlePct", env: "RUG_CANDLE_PCT", group: "risk", label: "Candle anjlok", help: "Satu candle 15 menit turun sebesar ini, posisi ditutup.", type: "number", unit: "%", min: 5, max: 95 },
  { key: "risk.outOfRangeBelowMaxMin", env: "OOR_BELOW_MAX_MIN", group: "risk", label: "Maksimal di bawah range", help: "", type: "integer", unit: "menit", min: 1, max: 1440 },
  { key: "risk.idleAboveMaxMin", env: "IDLE_ABOVE_MAX_MIN", group: "risk", label: "Maksimal di atas range", help: "Posisi belum terisi selama ini ditutup.", type: "integer", unit: "menit", min: 1, max: 1440 },
  { key: "risk.volumeDecayRatio", env: "VOLUME_DECAY_RATIO", group: "risk", label: "Rasio volume menurun", help: "Volume 1 jam di bawah rasio ini dari rata-rata, posisi ditutup.", type: "number", unit: "x", min: 0, max: 1 },
  { key: "risk.claimFeeMinSol", env: "CLAIM_FEE_MIN_SOL", group: "risk", label: "Claim fee mulai dari", help: "", type: "number", unit: "SOL", min: 0, max: 10 },
  { key: "risk.sellFeeTokens", env: "SELL_FEE_TOKENS", group: "risk", label: "Jual token hasil fee", help: "Langsung ditukar ke SOL setelah claim.", type: "boolean" },

  // Execution
  { key: "execution.reserveSol", env: "RESERVE_SOL", group: "execution", label: "Cadangan SOL di wallet", help: "Untuk rent dan biaya, tidak pernah dipasang.", type: "number", unit: "SOL", min: 0, max: 100 },
  { key: "execution.slippagePct", env: "SLIPPAGE_PCT", group: "execution", label: "Slippage tambah likuiditas", help: "", type: "number", unit: "%", min: 0.1, max: 20 },
  { key: "execution.swapSlippageBps", env: "SWAP_SLIPPAGE_BPS", group: "execution", label: "Slippage swap", help: "", type: "integer", unit: "bps", min: 10, max: 3000 },
  { key: "execution.priorityMicroLamports", env: "PRIORITY_FEE_MICROLAMPORTS", group: "execution", label: "Priority fee", help: "", type: "integer", unit: "microlamports", min: 0, max: 50_000_000 },
  { key: "execution.maxRetries", env: "TX_MAX_RETRIES", group: "execution", label: "Percobaan ulang transaksi", help: "", type: "integer", unit: "kali", min: 0, max: 10 },
];

/** Cross-field rules checked after every change. Returns a message per broken rule. */
export function crossCheck(get: (key: string) => unknown): string[] {
  const errors: string[] = [];
  if ((get("opening.minPositionSol") as number) > (get("opening.maxPositionSol") as number)) {
    errors.push("Size minimal per posisi tidak boleh lebih besar dari size maksimal.");
  }
  if ((get("screening.minTvlUsd") as number) > (get("screening.maxTvlUsd") as number)) {
    errors.push("TVL minimal tidak boleh lebih besar dari TVL maksimal.");
  }
  if ((get("screening.minMcapUsd") as number) > (get("screening.maxMcapUsd") as number)) {
    errors.push("Market cap minimal tidak boleh lebih besar dari maksimal.");
  }
  return errors;
}

/** Validates one value in display units; returns the raw config value or an error message. */
export function parseSetting(def: SettingDef, input: unknown): { value: unknown } | { error: string } {
  switch (def.type) {
    case "boolean":
      return typeof input === "boolean" ? { value: input } : { error: `${def.label}: harus ya atau tidak.` };
    case "list": {
      if (!Array.isArray(input) || input.some((x) => typeof x !== "string")) {
        return { error: `${def.label}: harus daftar teks.` };
      }
      const items = [...new Set(input.map((x: string) => x.trim()).filter(Boolean))];
      if (items.some((x) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x))) {
        return { error: `${def.label}: ada alamat mint yang tidak valid.` };
      }
      return { value: items };
    }
    default: {
      if (typeof input !== "number" || !Number.isFinite(input)) return { error: `${def.label}: harus angka.` };
      if (def.type === "integer" && !Number.isInteger(input)) return { error: `${def.label}: harus bilangan bulat.` };
      if (def.min !== undefined && input < def.min) return { error: `${def.label}: minimal ${def.min}.` };
      if (def.max !== undefined && input > def.max) return { error: `${def.label}: maksimal ${def.max}.` };
      return { value: input * (def.scale ?? 1) };
    }
  }
}
