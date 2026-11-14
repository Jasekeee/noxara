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

/** Phone width: middle-truncate long ids (the suffix always stays); desktop shows the full id. */
const narrow = () => typeof innerWidth === "number" && innerWidth <= 480;

/** What to call a fighter or player: the real NEAR account id when it has one (full on desktop), else its name. */
export function displayId(account: string | null | undefined, name: string): string {
  return isChainAcct(account) ? (narrow() ? truncAcct(account, 24) : account) : name;
}

/** A headline-sized account label: "zinnia" bold + ".noxara.near" small, reading as one id; plain name offline. */
export function acctLabel(account: string | null | undefined, name: string, cls = "acct-label"): HTMLElement {
  if (!isChainAcct(account)) return h("span", cls, name);
  const shown = narrow() ? truncAcct(account, 24) : account;
  const dot = shown.indexOf(".");
  const el = h("span", cls, undefined, h("b", "", dot > 0 ? shown.slice(0, dot) : shown), dot > 0 ? h("small", "", shown.slice(dot)) : null);
  el.title = account;
  el.setAttribute("aria-label", account);
  return el;
}
