// Post-match LEDGER: who won, where the pot and the bounty went, what the bots did with their money.
import type { SettleResult, StartResult } from "../net/api";
import { acctTag, isChainAcct, shortAcct } from "./acct";
import { h, icon, ICON, fmt } from "./dom";

export interface LedgerInput {
  names: string[]; // by fighter idx
  accounts: string[]; // by fighter idx (NEAR accounts for bots)
  placements: number[];
  kills: number[];
  winner: number | null;
  start: StartResult | null;
  settle: SettleResult | "pending" | null;
  chain: boolean;
  guest: boolean;
  portraits: string[];
  explorerTx: (h: string) => string;
  explorerAccount: (a: string) => string;
  onSignIn?: () => void;
  /** a coin lands during the money-flow animation (i = how many so far) */
  onCoin?: (i: number) => void;
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Count a number up from 0 in an element (no animation with reduced motion). */
function countUp(el: HTMLElement, to: number, ms: number, delay: number, onTick?: (i: number) => void) {
  if (reduced() || to <= 0) {
    el.textContent = fmt(to);
    return;
  }
  el.textContent = "0";
  const t0 = performance.now() + delay;
  let ticks = 0;
  const step = (now: number) => {
    const k = Math.min(1, Math.max(0, (now - t0) / ms));
    el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - k, 3)) * 100) / 100);
    const want = Math.floor(k * 6);
    while (ticks < want) onTick?.(ticks++);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** The money flow: the pot splits into the winner's share, the House treasury and the burn (amounts from the settle tx). */
export function moneyFlow(pot: number, legs: { label: string; sub: string; amount: number; cls: string }[], onCoin?: (i: number) => void): HTMLElement {
  const wrap = h("div", "mf");
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", `Pot ${fmt(pot)} NOX: ` + legs.map((l) => `${l.label} ${fmt(l.amount)} NOX`).join(", "));
  const potEl = h("b", "", fmt(pot));
  wrap.appendChild(h("div", "mf-pot", undefined, icon(ICON.coin, "ic coin"), h("small", "", "POT"), potEl, h("span", "mf-u", "NOX")));
  const row = h("div", "mf-legs");
  let n = 0;
  legs.forEach((l, i) => {
    const amt = h("b", "", "0");
    const pipe = h("div", "mf-pipe", undefined, h("i"), h("i"), h("i"));
    pipe.style.setProperty("--d", `${0.25 + i * 0.35}s`);
    const leg = h("div", `mf-leg ${l.cls}`, undefined, pipe, h("small", "", l.label), amt, h("span", "mf-sub", l.sub));
    row.appendChild(leg);
    countUp(amt, l.amount, 900, 250 + i * 350, () => onCoin?.(n++));
  });
  wrap.appendChild(row);
  return wrap;
}

/** display name: the real (middle-truncated) chain id when the fighter has one, else the roster name */
/** Display name in headlines and rows; the real account id appears as its own tag/link next to it. */
function dn(L: LedgerInput, i: number): string {
  return L.names[i];
}

function link(text: string, href: string): HTMLAnchorElement {
  const a = h("a", "near-link", undefined, icon(ICON.link), h("span", "", text));
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

export const PLAY_MONEY_NOTE = "NOX is play-money: an in-game score you can spend on entries and upgrades. It has no real-world value, can't be bought or sold, and isn't listed anywhere.";

/** "Entries X + House top-up Y = pot Z": the House tops the pot up, so the pot is more than what players paid in. */
export function potBreakdown(start: StartResult): HTMLElement | null {
  if (start.entries === undefined || !(start.pot > 0)) return null;
  const top = Math.max(0, Math.round((start.pot - start.entries) * 100) / 100);
  const li = h("li", "small pot-sum", `Pot = entries ${fmt(start.entries)} + House top-up ≈${fmt(top)} (× the House multiplier); the winner gets it minus a small burn and the House cut`);
  li.title = `The House (the game's treasury) adds a top-up to every pot, scaled by its public rule (get_economy), so the pot is bigger than the entry fees. 10% of the entries and a small share of the pot are burned. ${PLAY_MONEY_NOTE}`;
  return li;
}

export function renderLedger(el: HTMLElement, L: LedgerInput) {
  el.textContent = "";
  const w = L.winner;
  const wName = w === null ? "Nobody" : w === 0 ? "You" : dn(L, w);
  // winner
  const face = h("img", "lg-face");
  face.alt = "";
  face.width = 72;
  face.height = 72;
  if (w !== null && L.portraits[w]) face.src = L.portraits[w];
  el.appendChild(
    h("div", "lg-winner", undefined, face, h("div", "", undefined, h("small", "", "WINNER"), h("b", "", w === 0 ? "YOU TOOK THE ISLAND" : `${isChainAcct(L.accounts[w ?? -1]) ? wName : wName.toUpperCase()} took the island`), w !== null && w > 0 && L.chain && isChainAcct(L.accounts[w]) ? acctTag(L.accounts[w], L.explorerAccount(L.accounts[w]), "acct", false) : null)),
  );

  const rows = h("ul", "lg-rows");
  const row = (ic: string, text: string, amount?: number | null, cls = "") => {
    const li = h("li", cls, undefined, icon(ic), h("span", "", text));
    if (amount !== undefined && amount !== null) {
      const b = h("b", "amt", `${fmt(amount)} NOX`);
      b.title = PLAY_MONEY_NOTE;
      li.appendChild(b);
    }
    rows.appendChild(li);
  };

  if (!L.chain || !L.start || L.start.matchId.startsWith("local-")) {
    // offline: local results, no amounts
    const order = L.placements.map((p, i) => [p, i] as const).filter(([p]) => p > 0).sort((a, b) => a[0] - b[0]).slice(0, 3);
    for (const [p, i] of order) row(p === 1 ? ICON.crown : ICON.star, `#${p} ${i === 0 ? "You" : dn(L, i)} — ${L.kills[i]} kill${L.kills[i] === 1 ? "" : "s"}`);
    el.appendChild(rows);
    el.appendChild(h("p", "lg-note", "Practice match · not ranked. Results stay on this device."));
    return;
  }

  const s0 = L.settle;
  const failed = s0 !== null && s0 !== "pending" && !s0.verified && s0.payouts.length === 0;
  const s = failed ? null : s0;
  if (s === "pending" || s === null) {
    // never guess the payee before the chain says so (guests' wins go to the house, for example)
    row(ICON.coin, s === "pending" ? "Pot — pending settlement…" : "Pot — not settled", L.start.pot, "pot");
    const sum0 = potBreakdown(L.start);
    if (sum0) rows.appendChild(sum0);
    if (L.start.bountyIdx !== null && L.start.bountyValue > 0) {
      const bi = L.start.bountyIdx;
      row(ICON.crown, L.placements[bi] === 1 ? `${dn(L, bi)} kept the bounty` : `Bounty on ${dn(L, bi)}`, L.start.bountyValue, "bounty");
    }
    el.appendChild(rows);
    if (s === "pending") el.appendChild(h("p", "lg-pending", "Settling on NEAR… the server is re-running your match to check it"));
    else el.appendChild(h("p", "lg-note warn", "Not settled on chain this time — the server could not verify the match. Wallets are unchanged."));
  } else {
    const prize = s.payouts.find((p) => p.reason === "prize") ?? s.payouts.find((p) => p.reason === "house" && p.amount > 0);
    if (prize) row(ICON.coin, prize.reason === "house" ? (w === 0 && L.guest ? "Pot → the House (guests play for glory)" : `Pot → ${prize.name}`) : `Pot → ${prize.name}`, prize.amount, "pot");
    const sum1 = potBreakdown(L.start);
    if (sum1) rows.appendChild(sum1);
    for (const p of s.payouts.filter((x) => x.reason === "bounty")) {
      // the toast shows the carrier's share; the House adds a bonus on top when the multiplier allows
      const bonus = p.amount - (L.start.bountyValue || 0) > 0.005;
      row(ICON.crown, bonus ? `Bounty claimed by ${p.name} — carrier's 15% + House bonus` : `Bounty claimed by ${p.name}`, p.amount, "bounty");
      if (bonus) rows.appendChild(h("li", "small", `${fmt(L.start.bountyValue)} from the carrier's wallet + ${fmt(Math.round((p.amount - L.start.bountyValue) * 100) / 100)} House bonus`));
    }
    if (!s.payouts.some((x) => x.reason === "bounty") && L.start.bountyIdx !== null) {
      const carrier = dn(L, L.start.bountyIdx);
      // the bounty is paid only for a fighter's last hit on the carrier: say what actually happened
      row(ICON.crown, w === L.start.bountyIdx ? `${carrier} won and kept the bounty` : `Nobody claimed ${carrier}'s bounty (no fighter landed the last hit)`, null, "bounty");
    }
    for (const u of s.upgrades) {
      const what = /^weapon/i.test(u.what) ? "a weapon upgrade" : /^armou?r/i.test(u.what) ? "an armor upgrade" : /^skin/i.test(u.what) ? "a new look" : u.what;
      const paid = s.payouts.find((p) => p.reason === "upgrade" && p.name === u.name);
      row(ICON.up, `${u.name} bought ${what} with its winnings`, paid ? paid.amount : null, "up");
    }
    for (const r of s.retired) row(ICON.skull, `${r} went broke and retired`, null, "ret");
    for (const r of s.rookies) row(ICON.star, `${r} joins the island as a rookie`, null, "rookie");
    const house = s.payouts.find((p) => p.reason === "house" && p !== prize);
    const burn = s.payouts.find((p) => p.reason === "burn");
    if (house || burn) rows.appendChild(h("li", "small", `House ${fmt(house?.amount ?? 0)} · burned ${fmt(burn?.amount ?? 0)} NOX`));
    // animated money flow above the rows: pot -> winner / House treasury / burn (only amounts the settle tx reported)
    if (prize || house || burn) {
      const legs: { label: string; sub: string; amount: number; cls: string }[] = [];
      if (prize) legs.push({ label: prize.reason === "house" ? "THE HOUSE" : prize.name === "You" || w === 0 ? "YOU" : prize.name.toUpperCase(), sub: prize.reason === "house" ? "guest win → treasury" : "winner", amount: prize.amount, cls: "win" });
      if (house) legs.push({ label: "HOUSE", sub: "treasury", amount: house.amount, cls: "house" });
      if (burn) legs.push({ label: "BURNED", sub: "gone forever", amount: burn.amount, cls: "burn" });
      const pot = Math.round(legs.reduce((a, l) => a + l.amount, 0) * 100) / 100;
      el.appendChild(moneyFlow(pot, legs, L.onCoin));
    }
    el.appendChild(rows);
    if (s.verified) {
      const v = s.tx ? h("a", "lg-verified", undefined, icon(ICON.check), h("span", "", "Verified on NEAR — the server replayed every input; open the settle tx")) : h("div", "lg-verified", undefined, icon(ICON.check), h("span", "", "Verified — the server replayed every input and got the same result"));
      if (s.tx && v instanceof HTMLAnchorElement) {
        v.href = L.explorerTx(s.tx);
        v.target = "_blank";
        v.rel = "noopener noreferrer";
      }
      el.appendChild(v);
    }
  }

  if (L.guest) {
    const btn = h("button", "btn-near wide", undefined, h("span", "", "Sign in with NEAR"), h("small", "", "next time this pot could be yours"));
    if (L.onSignIn) btn.addEventListener("click", L.onSignIn);
    el.appendChild(h("div", "lg-signin", undefined, h("p", "lg-note", "Guests play for glory — sign in with NEAR to earn NOX."), btn));
  }

  // explorer drawer
  const det = h("details", "lg-near");
  det.appendChild(h("summary", "", "On NEAR"));
  const box = h("div", "lg-links");
  if (L.start.tx) box.appendChild(link("start_match tx", L.explorerTx(L.start.tx)));
  if (s && s !== "pending" && s.tx) box.appendChild(link("settle_match tx", L.explorerTx(s.tx)));
  if (w !== null && w > 0 && L.accounts[w]) box.appendChild(link(isChainAcct(L.accounts[w]) ? L.accounts[w] : `${wName}'s wallet`, L.explorerAccount(L.accounts[w])));
  if (L.start.bountyIdx !== null && L.accounts[L.start.bountyIdx]) box.appendChild(link(isChainAcct(L.accounts[L.start.bountyIdx]) ? L.accounts[L.start.bountyIdx] : `${L.names[L.start.bountyIdx]}'s wallet`, L.explorerAccount(L.accounts[L.start.bountyIdx])));
  // one link per account / tx
  const seen = new Set<string>();
  for (const a of [...box.querySelectorAll("a")]) {
    if (seen.has(a.href)) a.remove();
    else seen.add(a.href);
  }
  if (box.children.length) {
    det.appendChild(box);
    el.appendChild(det);
  }
}
