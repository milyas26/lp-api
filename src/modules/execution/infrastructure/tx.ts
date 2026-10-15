import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { log } from "../../../shared/logger";

export interface TxOptions {
  priorityMicroLamports: number;
  maxRetries: number;
}

const COMPUTE_BUDGET_ID = ComputeBudgetProgram.programId.toBase58();

function hasPriceIx(tx: Transaction): boolean {
  // SetComputeUnitPrice discriminator = 3
  return tx.instructions.some(
    (ix) => ix.programId.toBase58() === COMPUTE_BUDGET_ID && ix.data[0] === 3,
  );
}

/**
 * Sign + send a legacy tx with a priority fee and a fresh blockhash on each
 * attempt (Modul 9.5: txs fail exactly when the coin is dumping).
 */
export async function sendLegacy(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  opts: TxOptions,
): Promise<string> {
  if (opts.priorityMicroLamports > 0 && !hasPriceIx(tx)) {
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.priorityMicroLamports }),
    );
  }
  tx.feePayer = signers[0].publicKey;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.signatures = [];
      tx.sign(...signers);
      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 2,
      });
      const res = await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      if (res.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(res.value.err)}`);
      return sig;
    } catch (e) {
      lastErr = e;
      log.warn(`tx attempt ${attempt + 1}/${opts.maxRetries + 1} failed: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function sendVersioned(
  connection: Connection,
  tx: VersionedTransaction,
  signer: Keypair,
): Promise<string> {
  tx.sign([signer]);
  const latest = await connection.getLatestBlockhash("confirmed");
  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const res = await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed",
  );
  if (res.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(res.value.err)}`);
  return sig;
}
