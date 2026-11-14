// Display form of a NEAR account id: middle truncation that ALWAYS keeps the real suffix (.testnet / .near / ...).
// Never invents or rewrites a top-level name; the full id belongs in a title / aria-label.

/** Chain ids end in .testnet / .near, or are a 64-hex implicit account. Offline roster ids ("bot.fenwick") are not accounts. */
export const isChainAcct = (a: string | null | undefined): a is string => !!a && (/\.(testnet|near)$/.test(a) || /^[0-9a-f]{64}$/.test(a));

/** Shorten `id` to at most ~`max` chars, keeping the tail (the suffix) intact. */
export function truncAcct(id: string, max = 26): string {
  if (id.length <= max) return id;
  if (/^[0-9a-f]{64}$/.test(id)) return `${id.slice(0, 8)}…${id.slice(-6)}`; // implicit account: no suffix exists
  const labels = id.split(".");
  let tail = labels.length >= 3 ? labels.slice(-2).join(".") : "." + labels[labels.length - 1];
  if (labels.length < 3) tail = id.slice(-Math.min(id.length - 4, Math.max(8, Math.floor(max / 2))));
  if (tail.length > 18) tail = tail.slice(-18);
  const head = id.slice(0, Math.max(3, max - tail.length - 1));
  return head.length + 1 + tail.length >= id.length ? id : `${head}…${tail}`;
}
