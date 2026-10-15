/** Candle with prices denominated in the pool's quote token (SOL). */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
