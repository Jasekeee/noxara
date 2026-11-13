// Challenge a friend + DAILY: the controller that game.ts drives with three small hooks
// (forcedStart / matchOver / endShown). Everything else (nav chip, banner, end-screen button, pages,
// dialogs) is built here, so index.html and game.ts stay almost untouched. See docs/SOCIAL.md.
import type { GameClient } from "../net/api";
import { guestId, guestName, savedName, saveName, social, type AnswerResult, type ChallengeInfo, type DailyBoard, type DailyInfo, type DailySubmitResult, type RunResult } from "../net/social";
import { FIGHTERS, type MatchConfig, type MatchRecord } from "../sim/types";
import type { StartResult } from "../net/api";
import { h } from "./dom";
import { countdown, mmss, renderDaily } from "./tournament";
import "./social.css";

export interface SocialDeps {
  /** the finished match's record (null while a match is running) */
  getRecord(): MatchRecord | null;
  /** start a match through the game's normal flow (it will call forcedStart) */
  start(): void;
  client(): GameClient | null;
  toast(text: string): void;
  sfx(kind: "ui" | "coin"): void;
  signIn?(): Promise<void>;
}

type Active = { kind: "challenge"; id: string; token: string } | { kind: "daily"; day: string; token: string };

const $ = (id: string) => document.getElementById(id);
export const ordinal = (n: number) => {
  const v = n % 100;
  return `${n}${["th", "st", "nd", "rd"][(v - 20) % 10] ?? ["th", "st", "nd", "rd"][v] ?? "th"}`;
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const FRIENDLY: Record<string, string> = {
  unreachable: "Can't reach the NOXARA server right now, so this can't be shared or ranked. Offline practice still works.",
  rate_limited: "Too many tries from this connection. Wait a bit and try again.",
  too_fast: "That run finished faster than real time, so it was not accepted.",
  replay_mismatch: "The server could not reproduce that run, so it was not accepted.",
  token_expired: "That attempt timed out. Start it again.",
  token_used: "That attempt was already submitted. Start a new one.",
  sim_version_mismatch: "The game was updated while you played. Reload the page and try again.",
  full: "This challenge already has the maximum number of answers.",
};
const why = (code: string, error: string) => FRIENDLY[code] ?? error;

export class Social {
  private d: SocialDeps;
  private ctx: ChallengeInfo | null = null;
  private ctxId: string | null = null;
  private ctxErr: string | null = null;
  private ctxP: Promise<void> = Promise.resolve();
  private active: Active | null = null;
  private pendingDaily: DailyInfo | null = null;
  private banner: HTMLElement;
  private status: HTMLElement;
  private challengeBtn: HTMLButtonElement;
  private pageEl: HTMLElement;
  private bodyEl: HTMLElement;
  private titleEl: HTMLElement;
  private backEl: HTMLButtonElement;
  private modal: HTMLElement;
  private modalCard: HTMLElement;
  private tick: number | undefined;
  private lastFocus: HTMLElement | null = null;
  private dailyLast: DailySubmitResult | null = null;

  constructor(d: SocialDeps) {
    this.d = d;
    const app = $("app") ?? document.body;

    // title: DAILY chip + challenge landing banner
    const chip = h("button", "btn-chip", "DAILY");
    chip.id = "nav-daily";
    chip.addEventListener("click", () => {
      d.sfx("ui");
      void this.openDaily();
    });
    const board = $("nav-board");
    if (board?.parentElement) board.parentElement.insertBefore(chip, board);
    this.banner = h("div", "sc-banner sc-hidden");
    this.banner.id = "challenge-banner";
    this.banner.setAttribute("role", "status");
    const tag = document.querySelector(".title-inner .tag");
    tag?.insertAdjacentElement("afterend", this.banner);

    // end screen: button + status line
    this.status = h("p", "sc-status");
    this.status.setAttribute("role", "status");
    this.status.id = "social-status";
    this.challengeBtn = h("button", "btn-ghost sc-hidden", "CHALLENGE A FRIEND");
    this.challengeBtn.id = "challenge";
    this.challengeBtn.addEventListener("click", () => this.openChallengeDialog());
    const btns = document.querySelector("#end .end-btns");
    if (btns?.parentElement) {
      btns.parentElement.insertBefore(this.status, btns);
      btns.insertBefore(this.challengeBtn, btns.firstChild?.nextSibling ?? null);
    }

    // full-screen page (daily, challenge result) and modal (create a challenge)
    this.pageEl = h("section", "page sc-page sc-hidden");
    this.pageEl.id = "social-page";
    this.pageEl.setAttribute("role", "dialog");
    this.pageEl.setAttribute("aria-modal", "true");
    this.pageEl.setAttribute("aria-labelledby", "social-title");
    this.backEl = h("button", "btn-chip", "← BACK");
    this.backEl.setAttribute("aria-label", "Back");
    this.backEl.addEventListener("click", () => this.closePage());
    this.titleEl = h("h2", "", "DAILY");
    this.titleEl.id = "social-title";
    this.bodyEl = h("div", "page-body");
    this.pageEl.append(h("header", "page-head", undefined, this.backEl, this.titleEl), this.bodyEl);
    this.modalCard = h("div", "modal-card sc-modal");
    this.modal = h("div", "modal sc-hidden", undefined, this.modalCard);
    this.modal.setAttribute("role", "dialog");
    this.modal.setAttribute("aria-modal", "true");
    this.modal.setAttribute("aria-labelledby", "sc-modal-title");
    app.append(this.pageEl, this.modal);
    addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!this.modal.classList.contains("sc-hidden")) this.closeModal();
      else if (!this.pageEl.classList.contains("sc-hidden")) this.closePage();
    });

    // ?challenge=<id>
    const id = new URLSearchParams(location.search).get("challenge");
    if (id && /^[a-z2-7]{8}$/.test(id)) {
      this.ctxId = id;
      this.ctxP = this.loadChallenge(id);
    }
  }

  // ------------------------------------------------------------------ game hooks
  /** Called by startMatch: the config of a challenge / daily match, or null for a normal match. */
  async forcedStart(): Promise<StartResult | null> {
    this.active = null;
    this.setStatus("");
    if (this.pendingDaily) {
      const info = this.pendingDaily;
      this.pendingDaily = null;
      this.active = { kind: "daily", day: info.day, token: info.token };
      return this.asStart(`local-daily-${info.day}`, { seed: info.seed, fighters: info.roster });
    }
    await this.ctxP;
    if (!this.ctxId || !this.ctx) return null;
    // a fresh token anchors the real-time check at the moment this attempt starts
    const fresh = await social.getChallenge(this.ctxId);
    if (fresh.ok) this.ctx = fresh.json;
    this.active = { kind: "challenge", id: this.ctx.id, token: this.ctx.token };
    return this.asStart(`local-challenge-${this.ctx.id}`, this.ctx.cfg);
  }

  /** Called when the match just finished (the record exists). */
  matchOver(record: MatchRecord) {
    const a = this.active;
    this.active = null;
    if (!a) return;
    this.setStatus(a.kind === "daily" ? "Sending your run to today's board…" : "Checking your run against the challenge…");
    if (a.kind === "challenge") void this.finishChallenge(a, record);
    else void this.finishDaily(a, record);
  }

  /** Called by showEnd. */
  endShown(over: boolean) {
    this.challengeBtn.classList.toggle("sc-hidden", !over || !this.d.getRecord());
  }

  // ------------------------------------------------------------------ helpers
  private asStart(matchId: string, cfg: MatchConfig): StartResult {
    const b = cfg.fighters.findIndex((f) => f.bounty);
    return { matchId, cfg, pot: 0, bountyIdx: b >= 0 ? b : null, bountyValue: 0, playerPaid: 0, tx: null };
  }
  private setStatus(t: string, warn = false) {
    this.status.textContent = t;
    this.status.classList.toggle("warn", warn);
  }
  private sfx = (k: "ui" | "coin") => this.d.sfx(k);

  // ------------------------------------------------------------------ challenge landing
  private async loadChallenge(id: string) {
    const r = await social.getChallenge(id);
    if (r.ok) {
      this.ctx = r.json;
      this.ctxErr = null;
    } else this.ctxErr = r.code === "not_found" ? "That challenge link doesn't exist (or expired)." : why(r.code, r.error);
    this.renderBanner();
  }
  private renderBanner() {
    this.banner.textContent = "";
    this.banner.classList.remove("sc-hidden");
    if (this.ctx) {
      const r = this.ctx.result;
      const how = r.placement === 1 ? `win with ${plural(r.kills, "kill")}` : `${ordinal(r.placement)} place with ${plural(r.kills, "kill")}`;
      this.banner.append(h("b", "", `Beat ${r.name}'s ${how}`), h("span", "", `Same island, same fighters${r.bountyKilled ? " — and they took the bounty" : ""}. Press PLAY. No stakes, no tokens.`));
    } else {
      this.banner.append(h("b", "", "Challenge link"), h("span", "", `${this.ctxErr ?? "Loading…"} You can still play a normal match.`));
      if (this.ctxId && this.ctxErr) {
        const retry = h("button", "link-btn", "Try again");
        retry.addEventListener("click", () => {
          this.ctxErr = null;
          this.ctxP = this.loadChallenge(this.ctxId!);
          this.renderBanner();
        });
        this.banner.appendChild(retry);
      }
    }
    const off = h("button", "link-btn", "Play a normal match instead");
    off.addEventListener("click", () => {
      this.ctx = null;
      this.ctxId = null;
      this.banner.classList.add("sc-hidden");
      const u = new URL(location.href);
      u.searchParams.delete("challenge");
      history.replaceState(null, "", u.toString());
    });
    this.banner.appendChild(off);
  }

  // ------------------------------------------------------------------ challenge result
  private async finishChallenge(a: Extract<Active, { kind: "challenge" }>, record: MatchRecord) {
    const name = savedName() || guestName();
    const r = await social.answerChallenge(a.id, a.token, record, name);
    if (!r.ok) return this.setStatus(why(r.code, r.error), true);
    this.setStatus("Run verified by the server.");
    this.sfx("coin");
    setTimeout(() => this.openResult(r.json), 1500);
  }
  private openResult(r: AnswerResult) {
    const you = r.you;
    const them = r.them;
    const body = this.bodyEl;
    body.textContent = "";
    const verdict = r.winner === "you" ? "YOU WIN" : r.winner === "tie" ? "TIE" : `${them.name.toUpperCase()} WINS`;
    const vs = h("div", "sc-vs", undefined, h("div", `verdict${r.winner === "them" ? " lose" : ""}`, verdict), h("div", "who", "You"), h("div", "mid", "vs"), h("div", "who", them.name));
    body.appendChild(vs);
    const better = (a: number, b: number): [boolean, boolean] => [a > b, b > a];
    const rows: [string, string, string, [boolean, boolean]][] = [
      ["Placement", ordinal(you.placement), ordinal(them.placement), better(them.placement, you.placement)],
      ["Kills", String(you.kills), String(them.kills), better(you.kills, them.kills)],
      ["Time alive", mmss(you.ticksSurvived), mmss(them.ticksSurvived), better(you.ticksSurvived, them.ticksSurvived)],
      ["Took the bounty", you.bountyKilled ? "Yes" : "No", them.bountyKilled ? "Yes" : "No", better(+you.bountyKilled, +them.bountyKilled)],
      ["Won the island", you.won ? "Yes" : "No", them.won ? "Yes" : "No", better(+you.won, +them.won)],
    ];
    const table = h("table", "sc-table sc-cmp");
    const cap = h("caption", "", "SIDE BY SIDE");
    table.appendChild(cap);
    const head = h("tr");
    for (const t of ["", "You", them.name]) {
      const th = h("th", "", t);
      th.scope = "col";
      head.appendChild(th);
    }
    table.appendChild(h("thead", "", undefined, head));
    const tb = h("tbody");
    for (const [lab, y, t, [yb, tbt]] of rows) tb.appendChild(h("tr", "", undefined, h("td", "lab", lab), h("td", yb ? "win" : "", y), h("td", tbt ? "win" : "", t)));
    table.appendChild(tb);
    body.appendChild(h("div", "sc-wrap", undefined, table));
    const again = h("button", "btn-primary small", "PLAY AGAIN");
    again.addEventListener("click", () => {
      this.closePage();
      this.d.start();
    });
    const share = h("button", "btn-ghost small", "CHALLENGE A FRIEND");
    share.addEventListener("click", () => {
      this.closePage();
      this.openChallengeDialog();
    });
    body.appendChild(h("div", "sc-foot", undefined, h("span", "", `${plural(r.answers, "player")} answered ${them.name}'s challenge. Both runs were replayed and verified by the server.`), share, again));
    this.openPage("CHALLENGE RESULT", again);
  }

  // ------------------------------------------------------------------ create a challenge
  private openChallengeDialog() {
    const rec = this.d.getRecord();
    if (!rec) return;
    this.sfx("ui");
    const card = this.modalCard;
    card.textContent = "";
    const me = rec.placements[0] || FIGHTERS;
    const title = h("h2", "", "Challenge a friend");
    title.id = "sc-modal-title";
    const kills = "";
    card.append(title, h("p", "", `Your run: ${ordinal(me)} of ${FIGHTERS}${kills}. Your friend plays the same island and the same fighters, and the results are compared side by side. No stakes, no tokens.`));
    const label = h("label", "", "YOUR NAME ON THE LINK");
    label.htmlFor = "sc-name";
    const input = h("input");
    input.id = "sc-name";
    input.type = "text";
    input.maxLength = 18;
    input.value = savedName() || guestName();
    const msg = h("p", "sc-status");
    msg.setAttribute("role", "status");
    const make = h("button", "btn-primary small", "CREATE LINK");
    const cancel = h("button", "btn-ghost small", "CANCEL");
    cancel.addEventListener("click", () => this.closeModal());
    make.addEventListener("click", async () => {
      make.disabled = true;
      msg.textContent = "Checking your run on the server…";
      const name = input.value.trim().slice(0, 18) || guestName();
      saveName(name);
      const r = await social.createChallenge(rec, name);
      if (!r.ok) {
        make.disabled = false;
        msg.textContent = why(r.code, r.error);
        return;
      }
      this.sfx("coin");
      this.showLink(`${(await import("../net/social")).SOCIAL_BASE}${r.json.path}`, r.json.result);
    });
    card.append(label, input, msg, h("div", "sc-btns", undefined, make, cancel));
    this.openModal(input);
  }
  private showLink(url: string, r: RunResult) {
    const card = this.modalCard;
    card.textContent = "";
    const title = h("h2", "", "Link ready");
    title.id = "sc-modal-title";
    const label = h("label", "", "SHARE THIS LINK");
    label.htmlFor = "sc-link";
    const input = h("input");
    input.id = "sc-link";
    input.type = "url";
    input.readOnly = true;
    input.value = url;
    const text = `Placed ${r.placement}/${FIGHTERS} with ${plural(r.kills, "kill")} — can you beat it? NOXARA`;
    const msg = h("p", "sc-status");
    msg.setAttribute("role", "status");
    const copy = h("button", "btn-primary small", "COPY LINK");
    copy.addEventListener("click", async () => {
      this.sfx("ui");
      let ok = false;
      try {
        await navigator.clipboard.writeText(url);
        ok = true;
      } catch {
        input.select();
        try {
          ok = document.execCommand("copy");
        } catch {
          ok = false;
        }
      }
      msg.textContent = ok ? "Link copied." : "Press Ctrl/Cmd+C to copy the selected link.";
    });
    const btns = h("div", "sc-btns", undefined, copy);
    if (typeof navigator.share === "function") {
      const share = h("button", "btn-ghost small", "SHARE…");
      share.addEventListener("click", () => {
        navigator.share({ title: "NOXARA challenge", text, url }).catch(() => undefined);
      });
      btns.appendChild(share);
    }
    const close = h("button", "btn-ghost small", "CLOSE");
    close.addEventListener("click", () => this.closeModal());
    btns.appendChild(close);
    card.append(title, h("p", "", text), label, input, msg, btns);
    copy.focus();
    input.select();
  }

  // ------------------------------------------------------------------ daily
  private myName(): string {
    return this.dailyLast?.name ?? guestName();
  }
  async openDaily() {
    this.openPage("DAILY", null);
    this.bodyEl.textContent = "";
    this.bodyEl.appendChild(h("p", "page-lede", "Loading today's island…"));
    const [info, board] = await Promise.all([social.daily(), social.leaderboard()]);
    this.showDaily(info.ok ? info.json : null, board.ok ? board.json : null, info.ok ? null : why(info.code, info.error));
  }
  private showDaily(info: DailyInfo | null, board: DailyBoard | null, error: string | null) {
    const c = this.d.client();
    const signedIn = !!c && c.mode === "chain" && !c.isGuest();
    const timer = renderDaily(this.bodyEl, {
      info,
      board,
      me: this.myName(),
      last: this.dailyLast,
      error,
      signedIn,
      onPlay: () => void this.playDaily(),
      onRetry: () => void this.openDaily(),
      onSignIn: this.d.signIn && c && c.mode === "chain" ? () => void this.d.signIn!() : undefined,
    });
    if (info && timer) {
      clearInterval(this.tick);
      this.tick = window.setInterval(() => {
        timer.textContent = countdown(info.endsAt - Date.now());
        if (info.endsAt - Date.now() < -2000) {
          clearInterval(this.tick);
          void this.openDaily(); // a new UTC day started
        }
      }, 1000);
    }
  }
  private async playDaily() {
    this.sfx("ui");
    const info = await social.daily(); // a fresh token: the real-time check starts now
    if (!info.ok) return this.showDaily(null, null, why(info.code, info.error));
    this.pendingDaily = info.json;
    this.closePage();
    this.d.start();
  }
  private async finishDaily(a: Extract<Active, { kind: "daily" }>, record: MatchRecord) {
    const c = this.d.client() as (GameClient & { signDaily?: (day: string, inputs: unknown) => Promise<{ account: string; publicKey: string; signature: string } | null> }) | null;
    let who: Record<string, unknown> = { guestId: guestId() };
    if (c && c.mode === "chain" && typeof c.signDaily === "function") {
      const proof = await c.signDaily(a.day, record.inputs).catch(() => null);
      if (proof) who = { ...proof, guestId: guestId() };
    }
    const r = await social.submitDaily(record, a.token, who);
    if (!r.ok) return this.setStatus(why(r.code, r.error), true);
    this.dailyLast = r.json;
    this.setStatus(`Daily: you are #${r.json.rank} today.`);
    this.sfx("coin");
    setTimeout(() => void this.openDaily(), 1500);
  }

  // ------------------------------------------------------------------ page + modal plumbing
  private openPage(title: string, focus: HTMLElement | null) {
    if (this.pageEl.classList.contains("sc-hidden")) this.lastFocus = document.activeElement as HTMLElement | null;
    this.titleEl.textContent = title;
    this.pageEl.classList.remove("sc-hidden");
    this.bodyEl.scrollTop = 0;
    (focus ?? this.backEl).focus({ preventScroll: true });
  }
  private closePage() {
    clearInterval(this.tick);
    this.pageEl.classList.add("sc-hidden");
    this.lastFocus?.focus({ preventScroll: true });
  }
  private openModal(focus: HTMLElement) {
    this.lastFocus = document.activeElement as HTMLElement | null;
    this.modal.classList.remove("sc-hidden");
    focus.focus();
    this.modal.onkeydown = (e) => {
      if (e.key !== "Tab") return;
      const f = [...this.modal.querySelectorAll<HTMLElement>("button:not(:disabled), input")];
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    };
  }
  private closeModal() {
    this.modal.classList.add("sc-hidden");
    this.lastFocus?.focus({ preventScroll: true });
  }
}
