/** One bot cycle and its steps, as shown live on the dashboard. */

export type StepStatus = "running" | "done" | "skipped" | "failed";

export interface Step {
  id: string;
  key: string;
  label: string;
  status: StepStatus;
  detail?: string;
  /** Structured payload for the dashboard (AI decision, bin step table, simulation). */
  data?: unknown;
  startedAt: number;
  endedAt?: number;
  children: Step[];
}

export interface Cycle {
  n: number;
  startedAt: number;
  endedAt?: number;
  status: "running" | "done" | "failed";
  steps: Step[];
}

export type BotState = "starting" | "running" | "sleeping" | "stopped";

export interface BotStatus {
  state: BotState;
  cycle: number;
  nextCycleAt?: number;
  lastCycleAt?: number;
  openingPaused: boolean;
}
