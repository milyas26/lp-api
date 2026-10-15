import type { Cycle } from "./cycle";

export interface CycleRepository {
  save(cycle: Cycle): Promise<void>;
  /** Oldest first, at most `limit`. */
  recent(limit: number): Promise<Cycle[]>;
}
