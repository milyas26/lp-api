export interface SettingsRepository {
  /** Stored overrides, raw config units, keyed by config path. */
  all(): Promise<Record<string, unknown>>;
  /** Writes and deletes in one transaction; `null` removes the override. */
  apply(changes: Record<string, unknown | null>): Promise<void>;
}
