import { LAMPORTS_PER_SOL, type Connection, type PublicKey } from "@solana/web3.js";

/** GET /api/wallet, mirrored in frontend/src/types.ts. */
export interface WalletBalanceView {
  wallet: string;
  /** On-chain SOL, so the dashboard shows the wallet the keys point at even in DRY_RUN. */
  sol: number;
  at: number;
}

/**
 * Live on-chain SOL balance for the dashboard. A short cache keeps a 5s poll off
 * the RPC; when a refresh fails the last good reading is served instead.
 */
export class WalletBalance {
  private cached: { sol: number; at: number } | null = null;

  constructor(
    private readonly connection: Connection,
    private readonly owner: PublicKey,
    private readonly ttlMs = 4_000,
  ) {}

  async read(): Promise<WalletBalanceView> {
    const now = Date.now();
    if (!this.cached || now - this.cached.at >= this.ttlMs) {
      this.cached = (await this.fetch(now)) ?? this.cached;
    }
    if (!this.cached) throw new Error("Saldo wallet tidak bisa dibaca dari RPC.");
    return { wallet: this.owner.toBase58(), sol: this.cached.sol, at: this.cached.at };
  }

  private async fetch(at: number): Promise<{ sol: number; at: number } | null> {
    try {
      const lamports = await this.connection.getBalance(this.owner, "confirmed");
      return { sol: lamports / LAMPORTS_PER_SOL, at };
    } catch {
      return null;
    }
  }
}
