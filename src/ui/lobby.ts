// Title-screen lobby: the 9 AI fighters as cards (their wallets, upgrades, record, bounty, rookies).
import type { FighterInfo } from "../net/api";
import { h, icon, ICON, PERSONALITY_COLOR, PERSONALITY_ICON, fmt } from "./dom";

function pips(label: string, n: number, max = 2): HTMLElement {
  const el = h("span", "pips", undefined, h("b", "", label));
  for (let i = 0; i < max; i++) el.appendChild(h("i", i < n ? "on" : ""));
  el.title = `${label === "W" ? "Weapon" : "Armor"} tier ${n}/${max}`;
  return el;
}

export function renderLobby(list: HTMLElement, fighters: FighterInfo[], portraits: string[]) {
  list.textContent = "";
  const active = fighters.filter((f) => f.status === "active").sort((a, b) => a.slot - b.slot);
  for (const f of active) {
    const idx = f.slot + 1;
    const li = h("li", "fcard" + (f.bounty ? " bounty" : "") + (f.generation > 0 ? " rookie" : ""));
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
    if (f.generation > 0) top.appendChild(h("span", "fc-rookie", "ROOKIE"));
    li.append(
      top,
      h("div", "fc-name", f.name),
      h("div", "fc-pers", undefined, icon(PERSONALITY_ICON[f.personality] ?? PERSONALITY_ICON.balanced), h("span", "", f.personality)),
      h("div", "fc-bal", undefined, icon(ICON.coin, "ic coin"), h("b", "", fmt(f.balance))),
      h("div", "fc-up", undefined, pips("W", f.upgrades.weaponTier), pips("A", f.upgrades.armor)),
      h("div", "fc-rec", `${f.record.wins}W · ${f.record.kills}K · ${f.record.matches}M`),
    );
    li.title = `${f.name} — ${f.personality}. Wallet ${fmt(f.balance)} $BOUNTY. ${f.record.wins} wins, ${f.record.kills} kills in ${f.record.matches} matches.` + (f.bounty ? ` Carries a ${fmt(f.bountyValue)} $BOUNTY bounty.` : "");
    list.appendChild(li);
  }
}

export function lobbySkeleton(list: HTMLElement) {
  list.textContent = "";
  for (let i = 0; i < 9; i++) list.appendChild(h("li", "fcard skel"));
}
