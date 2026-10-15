/** Realised results of the current UTC day. */
export interface DayStats {
  date: string;
  realizedSol: number;
  opened: number;
  closed: number;
}

/** What the bot remembers between cycles besides its positions. */
export interface BotState {
  day: DayStats;
  /** Pool address → when the bot last closed a position there (re-entry cooldown). */
  closedPoolAt: Record<string, number>;
  /** Virtual wallet in DRY_RUN. */
  paperBalanceSol?: number;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function freshDay(): DayStats {
  return { date: today(), realizedSol: 0, opened: 0, closed: 0 };
}

export function freshBotState(): BotState {
  return { day: freshDay(), closedPoolAt: {} };
}

/** Starts a new day when the date changed; returns yesterday's stats if it did. */
export function rollDay(state: BotState): DayStats | null {
  if (state.day.date === today()) return null;
  const prev = state.day;
  state.day = freshDay();
  return prev;
}

export function recordClose(state: BotState, poolAddress: string, realizedSol: number): void {
  state.day.realizedSol += realizedSol;
  state.day.closed += 1;
  state.closedPoolAt[poolAddress] = Date.now();
}
