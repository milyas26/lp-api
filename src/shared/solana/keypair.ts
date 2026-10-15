import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export function loadKeypair(raw: string): Keypair {
  const s = raw.trim();
  if (s.startsWith("[")) {
    const arr = JSON.parse(s) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(s));
}
