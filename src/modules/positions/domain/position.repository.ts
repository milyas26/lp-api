import type { TrackedPosition } from "./position";

export interface ClosedPositionView {
  position: TrackedPosition;
  closedAt: number;
  closeReason: string | null;
  realizedSol: number | null;
}

export interface PositionRepository {
  findOpen(): Promise<TrackedPosition[]>;
  /** Insert a new open position or update its tracked fields. */
  save(position: TrackedPosition): Promise<void>;
  markClosed(pubkey: string, reason: string, realizedSol: number | null): Promise<void>;
  recentClosed(limit: number): Promise<ClosedPositionView[]>;
}
