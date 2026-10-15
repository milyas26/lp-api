import { EventEmitter } from "node:events";
import type { BotStatus, Cycle, Step, StepStatus } from "../domain/cycle";

export const KEEP_CYCLES = 30;

/**
 * Records what the agent is doing, step by step, so the dashboard can show
 * the live pipeline. Emits "cycle" (full cycle object), "status" and "snapshot".
 */
export class Tracer extends EventEmitter {
  readonly cycles: Cycle[] = [];
  status: BotStatus = { state: "starting", cycle: 0, openingPaused: false };
  private seq = 0;

  get current(): Cycle | undefined {
    return this.cycles[this.cycles.length - 1];
  }

  /** Seed history from storage so numbering and the dashboard survive a restart. */
  restore(cycles: Cycle[]): void {
    this.cycles.push(...cycles.slice(-KEEP_CYCLES));
    const last = this.cycles[this.cycles.length - 1];
    if (last) this.status = { ...this.status, cycle: last.n, lastCycleAt: last.endedAt };
  }

  setStatus(patch: Partial<BotStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.status);
  }

  startCycle(): Cycle {
    const n = this.status.cycle + 1;
    const c: Cycle = { n, startedAt: Date.now(), status: "running", steps: [] };
    this.cycles.push(c);
    if (this.cycles.length > KEEP_CYCLES) this.cycles.shift();
    this.setStatus({ state: "running", cycle: n });
    this.publish();
    return c;
  }

  endCycle(failed: boolean): void {
    const c = this.current;
    if (!c) return;
    c.endedAt = Date.now();
    c.status = failed ? "failed" : "done";
    // Anything still marked running when the cycle ends was interrupted.
    const close = (steps: Step[]) => {
      for (const s of steps) {
        if (s.status === "running") {
          s.status = failed ? "failed" : "done";
          s.endedAt = c.endedAt;
        }
        close(s.children);
      }
    };
    close(c.steps);
    this.setStatus({ lastCycleAt: c.endedAt });
    this.publish();
  }

  step(key: string, label: string, parent?: StepHandle): StepHandle {
    const s: Step = {
      id: `s${++this.seq}`,
      key,
      label,
      status: "running",
      startedAt: Date.now(),
      children: [],
    };
    if (parent) parent.raw.children.push(s);
    else this.current?.steps.push(s);
    this.publish();
    return new StepHandle(this, s);
  }

  publish(): void {
    if (this.current) this.emit("cycle", this.current);
  }

  /** Something the dashboard snapshot shows changed outside a cycle (settings). */
  snapshotChanged(): void {
    this.emit("snapshot");
  }
}

export class StepHandle {
  constructor(
    private readonly tracer: Tracer,
    readonly raw: Step,
  ) {}

  private finish(status: StepStatus, detail?: string): void {
    this.raw.status = status;
    if (detail !== undefined) this.raw.detail = detail;
    this.raw.endedAt = Date.now();
    this.tracer.publish();
  }

  attach(data: unknown): this {
    this.raw.data = data;
    this.tracer.publish();
    return this;
  }

  note(detail: string): void {
    this.raw.detail = detail;
    this.tracer.publish();
  }

  done(detail?: string): void {
    this.finish("done", detail);
  }

  skip(detail?: string): void {
    this.finish("skipped", detail);
  }

  fail(detail?: string): void {
    this.finish("failed", detail);
  }

  child(key: string, label: string): StepHandle {
    return this.tracer.step(key, label, this);
  }
}
