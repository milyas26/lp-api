/** "+1.2%" / "-0.4%", no sign when the rounded value is zero. */
export function pct(x: number, digits = 1): string {
  const shown = Math.abs(x).toFixed(digits);
  return `${Number(shown) === 0 ? "" : x > 0 ? "+" : "-"}${shown}%`;
}

export function sol(x: number, digits = 3): string {
  return `${x.toFixed(digits)} SOL`;
}
