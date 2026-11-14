// The DAILY page: today's seed, countdown, PLAY DAILY, the leaderboard with you highlighted.
import type { DailyBoard, DailyInfo, DailySubmitResult } from "../net/social";
import { h } from "./dom";

export const mmss = (ticks: number) => {
  const s = Math.round(ticks / 20);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
export const seedHex = (seed: number) => `#${(seed >>> 0).toString(16).padStart(8, "0")}`;
export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export interface DailyView {
  info: DailyInfo | null;
  board: DailyBoard | null;
  /** display name that identifies this player on the board */
  me: string;
  /** the result of the run that just finished, if any */
  last: DailySubmitResult | null;
  error: string | null;
  signedIn: boolean;
  onPlay(): void;
  onRetry(): void;
  onSignIn?: () => void;
}

/** Renders into `body`; returns the element whose text the caller updates every second (the countdown). */
export function renderDaily(body: HTMLElement, v: DailyView): HTMLElement | null {
  body.textContent = "";
  body.appendChild(h("p", "page-lede", "One island for the whole world today: same seed, same fighters, your best run counts. Free to play — no stakes."));
  if (v.error) {
    body.appendChild(h("p", "sc-error", v.error));
    const retry = h("button", "btn-ghost small", "TRY AGAIN");
    retry.addEventListener("click", v.onRetry);
    body.appendChild(retry);
    body.appendChild(h("p", "sc-note", "Practice is open while the island reconnects."));
    return null;
  }
  let timer: HTMLElement | null = null;
  const info = v.info;
  if (info) {
    timer = h("b", "", countdown(info.endsAt - Date.now()));
    timer.setAttribute("aria-label", "time until the daily resets");
    const play = h("button", "btn-primary small sc-cta", "PLAY DAILY");
    play.addEventListener("click", v.onPlay);
    body.appendChild(
      h("div", "sc-hero", undefined,
        h("div", "", undefined, h("small", "", `Daily ${info.day}`), h("span", "sc-seed", seedHex(info.seed))),
        h("div", "", undefined, h("small", "", "Resets in"), timer),
        play,
      ),
    );
  }
  if (v.last) {
    const l = v.last;
    const run = `${l.run.placement}/10, ${l.run.kills} kill${l.run.kills === 1 ? "" : "s"}, ${mmss(l.run.ticksSurvived)} alive`;
    const p = h("p", "sc-result", `Your run: ${run}. ${l.improved ? `New best — you are #${l.rank} today.` : `Your best today still stands (#${l.rank}).`}`);
    p.setAttribute("role", "status");
    body.appendChild(p);
  }
  body.appendChild(h("p", "sc-note", v.signedIn ? "Signed-in accounts are eligible for the daily prize (play-money, paid by the House on testnet)." : "Guests appear on the board but earn no NOX. Sign in with NEAR to be prize-eligible."));
  if (!v.signedIn && v.onSignIn) {
    const b = h("button", "btn-near wide", undefined, h("span", "", "Sign in with NEAR"), h("small", "", "be eligible for the daily prize"));
    b.addEventListener("click", v.onSignIn);
    body.appendChild(b);
  }

  const wrap = h("div", "sc-wrap");
  const table = h("table", "sc-table");
  table.appendChild(h("caption", "", v.board?.total ? `TOP ${Math.min(50, v.board.total)} TODAY` : "LEADERBOARD"));
  const head = h("tr");
  for (const [t, num] of [["#", true], ["Player", false], ["Place", true], ["Kills", true], ["Alive", true]] as const) {
    const th = h("th", num ? "num" : "", t);
    th.scope = "col";
    head.appendChild(th);
  }
  table.appendChild(h("thead", "", undefined, head));
  const tb = h("tbody");
  const rows = v.board?.rows ?? [];
  for (const r of rows) {
    const mine = r.name === v.me;
    const tr = h("tr", mine ? "me" : "");
    if (mine) tr.setAttribute("aria-current", "true");
    const name = h("td", "", r.name);
    if (mine) name.appendChild(h("span", "sc-tag", "YOU"));
    if (r.kind === "guest") name.appendChild(h("span", "sc-tag", "GUEST"));
    if (r.kind === "unverified") name.appendChild(h("span", "sc-tag warn", "NO PRIZE"));
    tr.append(h("td", "num", r.rank), name, h("td", "num", `${r.placement}/10`), h("td", "num", r.kills + (r.bountyKilled ? " ★" : "")), h("td", "num", mmss(r.ticksSurvived)));
    tb.appendChild(tr);
  }
  if (!rows.length) {
    const td = h("td", "", "Nobody has played today's island yet. Be the first.");
    td.colSpan = 5;
    tb.appendChild(h("tr", "", undefined, td));
  }
  table.appendChild(tb);
  wrap.appendChild(table);
  body.appendChild(wrap);
  return timer;
}
