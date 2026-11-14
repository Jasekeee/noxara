// Title-screen lobby: the 9 AI fighters as cards (their wallets, upgrades, record, bounty, rookies).
import type { FighterInfo } from "../net/api";
import { acctTag, isChainAcct } from "./acct";
import { h, icon, ICON, PERSONALITY_COLOR, PERSONALITY_ICON, fmt } from "./dom";

function pips(label: string, n: number, max = 2): HTMLElement {
  const el = h("span", "pips", undefined, h("b", "", label));
  for (let i = 0; i < max; i++) el.appendChild(h("i", i < n ? "on" : ""));
  el.title = `${label === "W" ? "Weapon" : "Armor"} tier ${n}/${max}`;
  return el;
}

// ---------------------------------------------------------------- change feed (since your last visit)
const SNAP = "bountyroyale.lobby.v1";
export interface Snap { at: number; f: Record<string, { name: string; bal: number; w: number; a: number; wins: number; status: string }> }
export function loadSnap(): Snap | null {
  try {
    const v = JSON.parse(localStorage.getItem(SNAP) ?? "null") as Snap | null;
    return v && typeof v === "object" && v.f ? v : null;
  } catch {
    return null;
  }
}
export function saveSnap(fighters: FighterInfo[]) {
  if (!fighters.length) return;
  const f: Snap["f"] = {};
  for (const x of fighters) f[x.account] = { name: x.name, bal: x.balance, w: x.upgrades.weaponTier, a: x.upgrades.armor, wins: x.record.wins, status: x.status };
  try {
    localStorage.setItem(SNAP, JSON.stringify({ at: Date.now(), f }));
  } catch {
    /* storage blocked: no change feed */
  }
}
/** Ticker lines describing what changed between a snapshot and now. */
export function diffLines(prev: Snap | null, now: FighterInfo[]): string[] {
  if (!prev) return [];
  const out: string[] = [];
  const winners = now.filter((x) => prev.f[x.account] && x.record.wins > prev.f[x.account].wins);
  for (const x of winners) {
    const d = x.balance - prev.f[x.account].bal;
    out.push(d > 0 ? `${x.name} won ${fmt(d)}` : `${x.name} won`);
  }
  for (const x of now) {
    const p = prev.f[x.account];
    if (!p) {
      if (x.status === "active" && x.generation > 0) out.push(`${x.name} joined as a rookie`);
      continue;
    }
    if (p.status === "active" && x.status === "retired") out.push(`${x.name} went broke`);
    if (x.upgrades.armor > p.a) out.push(`${x.name} bought armor ${x.upgrades.armor}`);
    if (x.upgrades.weaponTier > p.w) out.push(`${x.name} bought weapon tier ${x.upgrades.weaponTier}`);
  }
  return out;
}

export function renderLobby(list: HTMLElement, fighters: FighterInfo[], portraits: string[], prev: Snap | null = null) {
  list.textContent = "";
  const active = fighters.filter((f) => f.status === "active").sort((a, b) => a.slot - b.slot);
  for (const f of active) {
    const idx = f.slot + 1;
    const li = h("li", "fcard" + (f.bounty ? " bounty wanted" : "") + (f.generation > 0 && f.record.matches < 5 ? " rookie" : ""));
    li.dataset.acct = f.account;
    const open = h("button", "fc-open");
    open.setAttribute("aria-label", `${f.name}: open profile`);
    li.appendChild(open);
    li.style.setProperty("--pc", PERSONALITY_COLOR[f.personality] ?? "#fff");
    const img = h("img", "fc-face");
    img.alt = "";
    img.width = 80;
    img.height = 80;
    if (portraits[idx]) img.src = portraits[idx];
    const top = h("div", "fc-top", undefined, img);
    if (f.bounty) li.appendChild(h("div", "fc-wanted", "WANTED"));
    if (f.bounty) top.appendChild(h("span", "fc-crown", undefined, icon(ICON.crown), h("b", "", fmt(f.bountyValue))));
    if (f.generation > 0 && f.record.matches < 5) top.appendChild(h("span", "fc-rookie", "ROOKIE"));
    const p = prev?.f[f.account];
    const delta = p ? Math.round((f.balance - p.bal) * 100) / 100 : null;
    const deltaEl = delta !== null && Math.abs(delta) >= 0.01 ? h("span", "fc-delta " + (delta > 0 ? "up" : "down"), `${delta > 0 ? "+" : "−"}${fmt(Math.abs(delta))}`) : !p && prev ? h("span", "fc-delta new", "NEW") : null;
    li.append(
      top,
      h("div", "fc-name", f.name),
      acctTag(f.account, undefined, "fc-acct") ?? "",
      h("div", "fc-pers", undefined, icon(PERSONALITY_ICON[f.personality] ?? PERSONALITY_ICON.balanced), h("span", "", f.personality)),
      h("div", "fc-bal", undefined, icon(ICON.coin, "ic coin"), h("b", "", fmt(f.balance)), deltaEl),
      h("div", "fc-up", undefined, pips("W", f.upgrades.weaponTier), pips("A", f.upgrades.armor)),
      h("div", "fc-rec", `${f.record.wins}W · ${f.record.kills}K · ${f.record.matches}M`),
      h("div", "fc-spark"),
    );
    if (f.bounty) li.appendChild(h("div", "fc-reward", undefined, h("small", "", "BOUNTY"), h("b", "", `${fmt(f.bountyValue)} NOX`)));
    li.title = `${f.name}${isChainAcct(f.account) ? ` (${f.account})` : ""} — ${f.personality}. Wallet ${fmt(f.balance)} NOX. ${f.record.wins} wins, ${f.record.kills} kills in ${f.record.matches} matches.` + (f.bounty ? ` Carries a ${fmt(f.bountyValue)} NOX bounty.` : "");
    list.appendChild(li);
  }
}

export function lobbySkeleton(list: HTMLElement) {
  list.textContent = "";
  for (let i = 0; i < 9; i++) list.appendChild(h("li", "fcard skel"));
}

// ---------------------------------------------------------------- P&L sparklines (from on-chain history)
export interface Spark {
  /** net NOX per recent match, oldest first (prizes + bounties collected − bounties lost − upgrades; entries/upkeep not in the log) */
  pts: number[];
  /** season P&L from the contract (income − costs, entries and upkeep included), or null if unknown */
  pnl: number | null;
}

/** Per-match income from a fighter's chain history (newest-first entries with amounts). */
export function sparkFromHistory(hist: { match: string; kind: string; amount: number; detail: string }[], n = 12): number[] {
  const by = new Map<string, number>();
  const order: string[] = [];
  for (const e of hist) {
    if (!e.match || e.match === "0") continue;
    if (!by.has(e.match)) {
      by.set(e.match, 0);
      order.push(e.match);
    }
    const sign = e.kind === "win" || (e.kind === "bounty" && e.detail !== "lost") ? 1 : e.kind === "upgrade" || (e.kind === "bounty" && e.detail === "lost") ? -1 : 0;
    by.set(e.match, by.get(e.match)! + sign * e.amount);
  }
  return order.slice(0, n).reverse().map((m) => Math.round(by.get(m)! * 100) / 100);
}

/** A tiny bar sparkline (green up, red down) as inline SVG. */
export function sparkSvg(pts: number[], w = 72, hgt = 18): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(hgt));
  svg.setAttribute("aria-hidden", "true");
  const mid = hgt / 2;
  const base = document.createElementNS(NS, "line");
  base.setAttribute("x1", "0"); base.setAttribute("x2", String(w)); base.setAttribute("y1", String(mid)); base.setAttribute("y2", String(mid));
  base.setAttribute("class", "sp-base");
  svg.appendChild(base);
  const max = Math.max(1, ...pts.map((v) => Math.abs(v)));
  const bw = w / Math.max(pts.length, 6);
  pts.forEach((v, i) => {
    const r = document.createElementNS(NS, "rect");
    const hh = Math.max(1.5, (Math.abs(v) / max) * (mid - 1));
    r.setAttribute("x", String(i * bw + 1));
    r.setAttribute("width", String(Math.max(2, bw - 2)));
    r.setAttribute("y", String(v >= 0 ? mid - hh : mid));
    r.setAttribute("height", String(hh));
    r.setAttribute("rx", "1");
    r.setAttribute("class", v > 0 ? "sp-up" : v < 0 ? "sp-down" : "sp-flat");
    svg.appendChild(r);
  });
  return svg;
}

/** Fill the cards' sparkline slots without re-rendering the roster. */
export function fillSparks(list: HTMLElement, sparks: Map<string, Spark>) {
  for (const li of Array.from(list.querySelectorAll<HTMLElement>("li.fcard"))) {
    const s = sparks.get(li.dataset.acct ?? "");
    const slot = li.querySelector<HTMLElement>(".fc-spark");
    if (!s || !slot) continue;
    slot.textContent = "";
    if (s.pts.length) slot.appendChild(sparkSvg(s.pts));
    if (s.pnl !== null) {
      const v = Math.round(s.pnl * 100) / 100;
      slot.appendChild(h("span", "sp-pnl " + (v > 0 ? "up" : v < 0 ? "down" : ""), `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt(Math.abs(v))}`));
    }
    slot.title = `Season P&L ${s.pnl === null ? "n/a" : fmt(s.pnl) + " NOX"} (prizes + bounties − entries, upkeep, upgrades). Bars: income per recent match.`;
  }
}
