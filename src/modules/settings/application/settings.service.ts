import type { AgentConfig } from "../../../shared/config";
import { log } from "../../../shared/logger";
import {
  SETTING_DEFS,
  SETTING_GROUPS,
  crossCheck,
  parseSetting,
  type SettingDef,
  type SettingGroup,
  type SettingType,
} from "../domain/setting-definitions";
import type { SettingsRepository } from "../domain/settings.repository";

export interface SettingView {
  key: string;
  env: string;
  label: string;
  help: string;
  type: SettingType;
  unit?: string;
  min?: number;
  max?: number;
  /** Display units. */
  value: unknown;
  /** Value from backend/.env (or the built-in default), display units. */
  envValue: unknown;
  overridden: boolean;
}

export interface SettingsView {
  groups: { id: SettingGroup; label: string; help: string; settings: SettingView[] }[];
}

export class SettingsError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(" "));
  }
}

function getPath(obj: object, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], obj);
}

function setPath(obj: object, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  const parent = keys.reduce<Record<string, unknown>>((o, k) => o[k] as Record<string, unknown>, obj as Record<string, unknown>);
  parent[last] = value;
}

const toDisplay = (def: SettingDef, raw: unknown) =>
  typeof raw === "number" && def.scale ? raw / def.scale : Array.isArray(raw) ? [...raw] : raw;

/**
 * Dashboard-editable config. Overrides live in the database and are written
 * into the shared AgentConfig object in place, so every use case sees them on
 * its next read without a restart.
 */
export class SettingsService {
  private readonly envDefaults = new Map<string, unknown>();
  private readonly overridden = new Set<string>();

  constructor(
    private readonly cfg: AgentConfig,
    private readonly repo: SettingsRepository,
  ) {
    for (const d of SETTING_DEFS) this.envDefaults.set(d.key, structuredClone(getPath(cfg, d.key)));
  }

  /** Applies stored overrides at startup; a value that no longer validates is ignored. */
  async load(): Promise<void> {
    const stored = await this.repo.all();
    for (const d of SETTING_DEFS) {
      if (!(d.key in stored)) continue;
      const parsed = parseSetting(d, toDisplay(d, stored[d.key]));
      if ("error" in parsed) {
        log.warn(`stored setting ${d.key} ignored: ${parsed.error}`);
        continue;
      }
      setPath(this.cfg, d.key, parsed.value);
      this.overridden.add(d.key);
    }
    if (this.overridden.size > 0) log.info(`settings: ${this.overridden.size} override(s) from dashboard`);
  }

  view(): SettingsView {
    return {
      groups: SETTING_GROUPS.map((g) => ({
        ...g,
        settings: SETTING_DEFS.filter((d) => d.group === g.id).map((d) => ({
          key: d.key,
          env: d.env,
          label: d.label,
          help: d.help,
          type: d.type,
          unit: d.unit,
          min: d.min,
          max: d.max,
          value: toDisplay(d, getPath(this.cfg, d.key)),
          envValue: toDisplay(d, this.envDefaults.get(d.key)),
          overridden: this.overridden.has(d.key),
        })),
      })),
    };
  }

  /**
   * `changes` in display units; `null` resets a key to its .env value.
   * All-or-nothing: one invalid value rejects the whole request.
   */
  async update(changes: Record<string, unknown>): Promise<SettingsView> {
    const problems: string[] = [];
    const next = new Map<string, unknown>();
    const toStore: Record<string, unknown | null> = {};

    for (const [key, input] of Object.entries(changes)) {
      const def = SETTING_DEFS.find((d) => d.key === key);
      if (!def) {
        problems.push(`Pengaturan ${key} tidak dikenal atau tidak bisa diubah dari dashboard.`);
        continue;
      }
      if (input === null) {
        next.set(key, structuredClone(this.envDefaults.get(key)));
        toStore[key] = null;
        continue;
      }
      const parsed = parseSetting(def, input);
      if ("error" in parsed) problems.push(parsed.error);
      else {
        next.set(key, parsed.value);
        toStore[key] = parsed.value;
      }
    }
    problems.push(...crossCheck((k) => (next.has(k) ? next.get(k) : getPath(this.cfg, k))));
    if (problems.length > 0) throw new SettingsError(problems);

    await this.repo.apply(toStore);
    for (const [key, value] of next) {
      setPath(this.cfg, key, value);
      if (toStore[key] === null) this.overridden.delete(key);
      else this.overridden.add(key);
    }
    log.warn(`settings changed from dashboard: ${Object.keys(changes).join(", ")}`);
    return this.view();
  }
}
