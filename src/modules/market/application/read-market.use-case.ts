import type { AgentConfig } from "../../../shared/config";
import { pct } from "../../../shared/format";
import { log } from "../../../shared/logger";
import type { Tracer } from "../../activity/application/tracer";
import { isSolDumping, type Market } from "../domain/market";
import { solRegime } from "../infrastructure/dexscreener.client";

/** Modul 9.4: SOL itself dumping means close everything and stop opening. */
export class ReadMarket {
  constructor(
    private readonly cfg: AgentConfig,
    private readonly tracer: Tracer,
  ) {}

  async execute(): Promise<Market> {
    const step = this.tracer.step("market", "Cek kondisi SOL");
    try {
      const r = await solRegime();
      const solDumping = isSolDumping(r.change1h, r.change24h, {
        dump1hPct: this.cfg.risk.solDump1hPct,
        dump24hPct: this.cfg.risk.solDump24hPct,
      });
      const detail = `SOL 1 jam ${pct(r.change1h)}, 24 jam ${pct(r.change24h)}`;
      if (solDumping) step.fail(`${detail}. SOL sedang dump: semua posisi ditutup, buka posisi ditahan.`);
      else step.done(`${detail}. Aman.`);
      return { known: true, solChange1h: r.change1h, solChange24h: r.change24h, solPriceUsd: r.priceUsd, solDumping };
    } catch (e) {
      log.warn("SOL regime check failed; no new entries this cycle", e);
      step.fail("Data harga SOL tidak bisa diambil. Posisi tetap dikelola, buka posisi baru ditahan.");
      return { known: false, solChange1h: 0, solChange24h: 0, solDumping: false };
    }
  }
}
