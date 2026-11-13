// Real NEAR account ids for bots. Never invent a name: only ids that came from the chain are shown.
import { h } from "./dom";

/** Chain ids end in .testnet / .near (offline roster ids like "bot.fenwick" are not accounts). */
export const isChainAcct = (a: string | null | undefined): a is string => !!a && /\.(testnet|near)$/.test(a);

/** "brindle.royale.br-7e8492.testnet" -> "brindle.royale…" (full id belongs in a title / aria-label). */
export function shortAcct(a: string): string {
  const l = a.split(".");
  return l.length > 2 ? `${l[0]}.${l[1]}…` : a;
}

/** A small account tag, or null offline. `href` makes it an explorer link. */
export function acctTag(a: string | null | undefined, href?: string, cls = "acct", full = false): HTMLElement | null {
  if (!isChainAcct(a)) return null;
  if (href) {
    const l = h("a", cls, full ? a : shortAcct(a));
    l.href = href;
    l.target = "_blank";
    l.rel = "noopener noreferrer";
    l.title = a;
    l.setAttribute("aria-label", `${a} on the NEAR explorer`);
    return l;
  }
  const s = h("span", cls, full ? a : shortAcct(a));
  s.title = a;
  return s;
}
