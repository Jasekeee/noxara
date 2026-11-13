// Title-screen lobby: the 9 AI fighters as cards (their wallets, upgrades, record, bounty, rookies).
import type { FighterInfo } from "../net/api";
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
    const li = h("li", "fcard" + (f.bounty ? " bounty" : "") + (f.generation > 0 && f.record.matches < 5 ? " rookie" : ""));
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
    if (f.bounty) top.appendChild(h("span", "fc-crown", undefined, icon(ICON.crown), h("b", "", fmt(f.bountyValue))));
    if (f.generation > 0 && f.record.matches < 5) top.appendChild(h("span", "fc-rookie", "ROOKIE"));
    const p = prev?.f[f.account];
    const delta = p ? Math.round((f.balance - p.bal) * 100) / 100 : null;
    const deltaEl = delta !== null && Math.abs(delta) >= 0.01 ? h("span", "fc-delta " + (delta > 0 ? "up" : "down"), `${delta > 0 ? "+" : "−"}${fmt(Math.abs(delta))}`) : !p && prev ? h("span", "fc-delta new", "NEW") : null;
    li.append(
      top,
      h("div", "fc-name", f.name),
      h("div", "fc-pers", undefined, icon(PERSONALITY_ICON[f.personality] ?? PERSONALITY_ICON.balanced), h("span", "", f.personality)),
      h("div", "fc-bal", undefined, icon(ICON.coin, "ic coin"), h("b", "", fmt(f.balance)), deltaEl),
      h("div", "fc-up", undefined, pips("W", f.upgrades.weaponTier), pips("A", f.upgrades.armor)),
      h("div", "fc-rec", `${f.record.wins}W · ${f.record.kills}K · ${f.record.matches}M`),
    );
    li.title = `${f.name} — ${f.personality}. Wallet ${fmt(f.balance)} NOX. ${f.record.wins} wins, ${f.record.kills} kills in ${f.record.matches} matches.` + (f.bounty ? ` Carries a ${fmt(f.bountyValue)} NOX bounty.` : "");
    list.appendChild(li);
  }
}

export function lobbySkeleton(list: HTMLElement) {
  list.textContent = "";
  for (let i = 0; i < 9; i++) list.appendChild(h("li", "fcard skel"));
}
