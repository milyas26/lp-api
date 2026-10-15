import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { SOL_MINT } from "../../../shared/solana/constants";
import { getJson } from "../../../shared/http-client";
import { log } from "../../../shared/logger";
import { sendVersioned } from "./tx";

const BASE = "https://lite-api.jup.ag/swap/v1";

interface Quote {
  outAmount: string;
  priceImpactPct: string;
}

/** Raw token balance (all token accounts of this mint, incl. Token-2022). */
export async function tokenBalanceRaw(
  connection: Connection,
  owner: PublicKey,
  mint: string,
): Promise<bigint> {
  const res = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
  let total = 0n;
  for (const a of res.value) {
    const amt = (a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } })
      .parsed?.info?.tokenAmount?.amount;
    if (amt) total += BigInt(amt);
  }
  return total;
}

/**
 * Zap out: swap the whole wallet balance of `mint` into SOL through Jupiter.
 * Returns signature, or null if there was nothing worth swapping.
 */
export async function swapAllToSol(
  connection: Connection,
  user: Keypair,
  mint: string,
  slippageBps: number,
  priorityLamports: number,
): Promise<string | null> {
  if (mint === SOL_MINT) return null;
  const amount = await tokenBalanceRaw(connection, user.publicKey, mint);
  if (amount === 0n) return null;

  const quote = await getJson<Quote>(
    `${BASE}/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${amount}&slippageBps=${slippageBps}`,
  );
  if (Number(quote.outAmount) < 50_000) {
    log.info(`swap ${mint}: dust (${quote.outAmount} lamports), skipping`);
    return null;
  }

  const res = await fetch(`${BASE}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: user.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: priorityLamports, priorityLevel: "veryHigh" },
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Jupiter swap ${res.status}: ${await res.text()}`);
  const { swapTransaction } = (await res.json()) as { swapTransaction: string };
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  return sendVersioned(connection, tx, user);
}
