// Costs are shown to Claude and the user in USD. Cheap models cost fractions of a cent, so up to
// six decimals are kept; at least two are always shown so a round amount reads as money.
// A positive cost is never rounded down to "$0", which would read as free.
const MIN_DECIMALS = 2;
const MAX_DECIMALS = 6;
const SMALLEST_SHOWN = 10 ** -MAX_DECIMALS;

export function formatCost(usd: number): string {
  if (usd > 0 && usd < SMALLEST_SHOWN) return `<$${SMALLEST_SHOWN.toFixed(MAX_DECIMALS)}`;
  let text = usd.toFixed(MAX_DECIMALS);
  const dot = text.indexOf(".");
  if (dot === -1) return `$${text}`;
  let end = text.length;
  while (end > dot + 1 + MIN_DECIMALS && text[end - 1] === "0") end -= 1;
  text = text.slice(0, end);
  return `$${text}`;
}
