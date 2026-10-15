import { LAMPORTS_PER_SOL, type Connection, type PublicKey } from "@solana/web3.js";
import type { BotSession } from "./bot-session";

/** Free SOL in the bot wallet: the real balance live, the virtual one in DRY_RUN. */
export class Funds {
  constructor(
    private readonly dryRun: boolean,
    private readonly connection: Connection,
    private readonly owner: PublicKey,
    private readonly session: BotSession,
  ) {}

  async walletSol(): Promise<number> {
    if (this.dryRun) return this.session.state.paperBalanceSol ?? 0;
    return this.onchainSol();
  }

  /** Real on-chain balance, even in DRY_RUN. For manual/live actions. */
  async onchainSol(): Promise<number> {
    return (await this.connection.getBalance(this.owner, "confirmed")) / LAMPORTS_PER_SOL;
  }

  /** Paper only: move SOL between the virtual wallet and a position. */
  adjustPaper(deltaSol: number): void {
    this.session.state.paperBalanceSol = (this.session.state.paperBalanceSol ?? 0) + deltaSol;
  }
}
