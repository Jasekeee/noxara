// Weekly Bounty Cup: a free-entry promo on the title screen. Prizes are paid manually in NEAR by the owner.
// Fill CUP.prizesNear (1st, 2nd, 3rd, in NEAR) to show amounts; null = "Prizes announced soon". No wagering, no backend.
import { h } from "./dom";

export const CUP = {
  name: "Weekly Bounty Cup",
  /** NEAR prize per place (1st, 2nd, 3rd). null until the owner announces it. */
  prizesNear: [null, null, null] as (number | null)[],
  /** The week runs Monday 00:00 UTC to Sunday 23:59 UTC. */
  rules: [
    "Free to enter. No purchase, no wager.",
    "Ranking: the weekly leaderboard of real NEAR accounts. Sign in with NEAR to appear.",
    "Guests can play but are not eligible for prizes.",
    "Each week runs Monday 00:00 UTC to Sunday 23:59 UTC.",
    "Top 3 win NEAR prizes. One prize per account.",
    "Prizes are paid manually in NEAR after the week closes.",
    "Cheating or multiple accounts: the organizer may disqualify you.",
    "NOX is play-money with no real-world value, and is not a prize.",
    "Void where prohibited.",
  ],
};

/** Whole seconds until the current UTC week closes (next Monday 00:00 UTC). */
export function secondsToWeekClose(now = Date.now()): number {
  const d = new Date(now);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
  return Math.max(0, Math.floor((start + 7 * 86400_000 - now) / 1000));
}

export function closesIn(now = Date.now()): string {
  const s = secondsToWeekClose(now);
  const d = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  return d > 0 ? `${d}d ${hh}h` : `${hh}h ${Math.floor((s % 3600) / 60)}m`;
}

export function prizeLabels(): string[] | null {
  if (CUP.prizesNear.every((p) => p === null)) return null;
  return CUP.prizesNear.map((p) => (p === null ? "TBA" : `${p} NEAR`));
}

/** Render the card into `el`. `openBoard` shows the leaderboard; `openRules` opens the rules sheet. */
export function renderCup(el: HTMLElement, openBoard: () => void, openRules: () => void) {
  el.textContent = "";
  const prizes = prizeLabels();
  const head = h("div", "cup-head", undefined, h("h2", "", CUP.name.toUpperCase()), h("span", "cup-free", "FREE"));
  head.querySelector("h2")!.id = "cup-title";
  const line = h("p", "cup-line", "Top 3 on the leaderboard win NEAR prizes. Free to enter.");
  const pz = h("div", "cup-prizes");
  if (prizes) {
    ["1st", "2nd", "3rd"].forEach((p, i) => pz.appendChild(h("span", "cup-prize p" + (i + 1), undefined, h("b", "", p), document.createTextNode(prizes[i]))));
  } else pz.appendChild(h("span", "cup-soon", "Prizes announced soon"));
  pz.appendChild(h("span", "cup-left", `Closes in ${closesIn()}`));
  const btns = h("div", "cup-btns");
  const b = h("button", "btn-chip", "See leaderboard");
  b.type = "button";
  b.addEventListener("click", openBoard);
  const r = h("button", "btn-chip ghost", "Rules");
  r.type = "button";
  r.id = "cup-rules";
  r.addEventListener("click", openRules);
  btns.append(b, r);
  el.append(head, line, pz, btns);
}
