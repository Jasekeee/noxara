// Real NEAR account ids for bots. Never invent a name: only ids that came from the chain are shown.
import { h } from "./dom";
import { isChainAcct, truncAcct } from "../net/acctname";

export { isChainAcct };

/** Middle-truncated id that keeps the real suffix; tighter at phone width. */
export function shortAcct(a: string): string {
  return truncAcct(a, typeof innerWidth === "number" && innerWidth <= 480 ? 22 : 28);
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
