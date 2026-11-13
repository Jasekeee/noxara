// Full-screen pages over the title: FIGHTERS (+ profile with story + sponsoring), LEADERBOARD, MY SPONSORSHIPS.
// Uses the T3 client API only when present (`"signIn" in client`), otherwise shows what the T2 data allows.
import type { BotMarket, FighterInfo, GameClient, GameClientT3, LeaderRow, Sponsorship } from "../net/api";
import { acctTag, isChainAcct } from "./acct";
import { h, icon, ICON, PERSONALITY_COLOR, PERSONALITY_ICON, fmt } from "./dom";
import { renderEconomy, renderNear } from "./econ";

export interface PageDeps {
  client(): GameClient | null;
  fighters(): FighterInfo[];
  portrait(f: FighterInfo): string;
  refresh(): Promise<void>; // re-read fighters/balance after a market action
  signIn(): Promise<void>;
  toast(text: string): void;
  sfx(kind: "ui" | "coin"): void;
}

const isT3 = (c: GameClient | null): c is GameClientT3 => !!c && "signIn" in c;
const $ = (id: string) => document.getElementById(id)!;

// ---------------------------------------------------------------- backstories (original, 2 lines each)
const STORIES: Record<string, string[]> = {
  aggressive: [
    "{n} fights like the storm owes them money. Charges first, counts the bullets later.",
    "Banned from three fishing villages for 'starting things'. {n} came to the island to finish them.",
    "{n} hears gunfire the way other people hear dinner bells. The pot is just a bonus.",
  ],
  camper: [
    "{n} once waited eleven hours in a hedge for a rival who never came. Still calls it a good day.",
    "Patience is a weapon and {n} keeps it loaded. If a bush moved, it was probably {n}.",
    "{n} reads the circle like a tide chart and is already sitting where it will close.",
  ],
  sniper: [
    "{n} measures the island in shots, not steps. Closer than twenty paces feels rude.",
    "A former lighthouse keeper, {n} can spot a glint at the far beach and end the argument from there.",
    "{n} says one clean shot beats ten loud ones. The kill feed tends to agree.",
  ],
  looter: [
    "{n} opens every crate on the island before most fighters find their feet. The good blaster is already gone.",
    "Some fight for glory. {n} fights for whatever is inside the gold box, then for whatever you dropped.",
    "{n} keeps a ledger of every chest on the island and visits them like old friends.",
  ],
  coward: [
    "{n} has survived more storms than anyone by never being where the shooting is.",
    "Running away is a strategy, says {n}, and the bank balance backs it up. Mostly.",
    "{n} lets the brave ones thin each other out, then strolls in for the last word.",
  ],
  balanced: [
    "{n} adapts: fights when it pays, hides when it doesn't, and never forgets who owes the bounty.",
    "Steady hands, steady wallet. {n} is the fighter the others measure themselves against.",
    "{n} takes the island one circle at a time and rarely makes the same mistake twice.",
  ],
};
export function backstory(f: { name: string; personality: string }): string {
  const list = STORIES[f.personality] ?? STORIES.balanced;
  const k = [...f.name].reduce((a, c) => a + c.charCodeAt(0), 0) % list.length;
  return list[k].replace(/\{n\}/g, f.name);
}

const KIND_ICON: Record<string, string> = {
  win: ICON.crown,
  kill: ICON.skull,
  death: ICON.skull,
  bounty: ICON.crown,
  upgrade: ICON.up,
  retired: ICON.skull,
  rookie: ICON.star,
  sponsored: ICON.coin,
};

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function extLink(text: string, href: string) {
  const a = h("a", "near-link", undefined, icon(ICON.link), h("span", "", text));
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

export class Pages {
  private stack: (() => void)[] = [];
  private market: BotMarket[] = [];
  private lastFocus: HTMLElement | null = null;

  constructor(private d: PageDeps) {
    $("page-back").addEventListener("click", () => this.back());
    addEventListener("keydown", (e) => {
      if (e.code !== "Escape") return;
      if (!$("modal").classList.contains("hidden")) this.closeModal();
      else if (!$("page").classList.contains("hidden")) this.back();
    });
    $("modal").addEventListener("click", (e) => {
      if (e.target === $("modal")) this.closeModal();
    });
  }

  get open() {
    return !$("page").classList.contains("hidden");
  }

  private show(title: string, render: () => void, push = true) {
    if (push) this.stack.push(render);
    if (!this.open) this.lastFocus = document.activeElement as HTMLElement | null;
    $("page-title").textContent = title;
    $("page-tabs").textContent = "";
    $("page").classList.remove("hidden");
    $("page-body").scrollTop = 0;
    render();
    ($("page-back") as HTMLButtonElement).focus({ preventScroll: true });
  }
  back() {
    this.d.sfx("ui");
    this.stack.pop();
    const prev = this.stack[this.stack.length - 1];
    if (prev) prev();
    else this.close();
  }
  close() {
    this.stack = [];
    $("page").classList.add("hidden");
    this.lastFocus?.focus({ preventScroll: true });
  }

  private async loadMarket() {
    const c = this.d.client();
    if (isT3(c)) this.market = (await c.market().catch(() => [])) ?? [];
  }

  // ---------------------------------------------------------------- FIGHTERS
  fighters() {
    const render = () => {
      $("page-title").textContent = "FIGHTERS";
      const body = $("page-body");
      body.textContent = "";
      const all = this.d.fighters();
      const active = all.filter((f) => f.status === "active").sort((a, b) => b.balance - a.balance);
      const retired = all.filter((f) => f.status === "retired");
      body.appendChild(h("p", "page-lede", "Nine AI fighters with their own NEAR wallets. They pay to enter, keep what they win, buy upgrades — and retire when they go broke. Pick one to read its story or back it with NOX."));
      const grid = h("div", "fgrid");
      for (const f of active) grid.appendChild(this.miniCard(f));
      body.appendChild(grid);
      if (retired.length) {
        body.appendChild(h("h3", "page-h3", "HALL OF THE BROKE"));
        const g2 = h("div", "fgrid broke");
        for (const f of retired) g2.appendChild(this.miniCard(f));
        body.appendChild(g2);
      }
      void this.loadMarket().then(() => {
        for (const el of body.querySelectorAll<HTMLElement>("[data-acct]")) {
          const m = this.market.find((x) => x.bot === el.dataset.acct);
          const s = el.querySelector(".mc-stake");
          if (m && s) s.textContent = m.sponsors ? `${m.sponsors} sponsor${m.sponsors === 1 ? "" : "s"} · ${fmt(m.totalStake)} staked` : "no sponsors yet";
        }
      });
    };
    this.show("FIGHTERS", render);
  }

  private miniCard(f: FighterInfo): HTMLElement {
    const b = h("button", "mcard" + (f.bounty ? " bounty" : "") + (f.status === "retired" ? " retired" : ""));
    b.dataset.acct = f.account;
    b.style.setProperty("--pc", PERSONALITY_COLOR[f.personality] ?? "#fff");
    const img = h("img", "mc-face");
    img.alt = "";
    img.src = this.d.portrait(f);
    b.append(
      img,
      h(
        "span",
        "mc-meta",
        undefined,
        h("b", "", f.name),
        acctTag(f.account, undefined, "acct mc-acct"),
        h("span", "mc-pers", undefined, icon(PERSONALITY_ICON[f.personality] ?? PERSONALITY_ICON.balanced), h("span", "", f.personality)),
        h("span", "mc-bal", undefined, icon(ICON.coin, "ic coin"), h("b", "", f.status === "retired" ? "broke" : fmt(f.balance))),
        h("span", "mc-stake", f.status === "retired" ? `retired after ${f.record.matches} matches` : ""),
      ),
    );
    if (f.bounty) b.appendChild(h("span", "mc-crown", undefined, icon(ICON.crown), h("b", "", fmt(f.bountyValue))));
    b.setAttribute("aria-label", `${f.name}${isChainAcct(f.account) ? ` (${f.account})` : ""}, ${f.personality}, wallet ${fmt(f.balance)} NOX`);
    b.addEventListener("click", () => {
      this.d.sfx("ui");
      this.profile(f);
    });
    return b;
  }

  // ---------------------------------------------------------------- PROFILE
  profile(f: FighterInfo) {
    const render = () => {
      $("page-title").textContent = f.name.toUpperCase();
      const body = $("page-body");
      body.textContent = "";
      const c = this.d.client();
      const fresh = this.d.fighters().find((x) => x.account === f.account) ?? f;
      const face = h("img", "pf-face");
      face.alt = "";
      face.src = this.d.portrait(fresh);
      const pc = PERSONALITY_COLOR[fresh.personality] ?? "#fff";
      const head = h(
        "div",
        "pf-head" + (fresh.status === "retired" ? " retired" : ""),
        undefined,
        h("div", "pf-facebox", undefined, face, fresh.bounty ? h("span", "fc-crown", undefined, icon(ICON.crown), h("b", "", fmt(fresh.bountyValue))) : null),
        h(
          "div",
          "pf-id",
          undefined,
          h("div", "pf-name", fresh.name, fresh.generation > 0 && (fresh.record.matches < 5 || fresh.status === "retired") ? h("span", "fc-rookie inline", fresh.status === "retired" ? "RETIRED" : "ROOKIE") : fresh.status === "retired" ? h("span", "fc-rookie inline gone", "RETIRED") : null),
          acctTag(fresh.account, this.d.client()?.mode === "chain" ? this.d.client()!.explorerAccount(fresh.account) : undefined, "acct pf-acct", true),
          h("div", "fc-pers big", undefined, icon(PERSONALITY_ICON[fresh.personality] ?? PERSONALITY_ICON.balanced), h("span", "", fresh.personality)),
          h("p", "pf-story", backstory(fresh)),
        ),
      );
      head.style.setProperty("--pc", pc);
      body.appendChild(head);

      const stat = (label: string, value: string, cls = "") => h("div", "pf-stat " + cls, undefined, h("b", "", value), h("span", "", label));
      const m = this.market.find((x) => x.bot === fresh.account);
      body.appendChild(
        h(
          "div",
          "pf-stats",
          undefined,
          stat("wallet", fresh.status === "retired" ? "broke" : `${fmt(fresh.balance)}`, "gold"),
          stat("wins", String(fresh.record.wins)),
          stat("kills", String(fresh.record.kills)),
          stat("matches", String(fresh.record.matches)),
          stat("earned", fmt(fresh.record.earnings), "gold"),
          stat("weapon / armor", `T${fresh.upgrades.weaponTier} · A${fresh.upgrades.armor}`),
        ),
      );

      // sponsor box
      const sbox = h("div", "pf-sponsor");
      const stakeLine = h("p", "pf-stake", m ? (m.sponsors ? `${m.sponsors} sponsor${m.sponsors === 1 ? "" : "s"} · ${fmt(m.totalStake)} NOX staked · sponsors share ${Math.round(m.sponsorCut * 100)}% of every prize` : `No sponsors yet · sponsors share ${Math.round(m.sponsorCut * 100)}% of every prize`) : "Sponsor market opens with NEAR sign-in.");
      sbox.appendChild(stakeLine);
      if (fresh.status === "active") {
        if (isT3(c) && !c.isGuest()) {
          const btn = h("button", "btn-primary small", `BACK ${fresh.name.toUpperCase()}`);
          btn.addEventListener("click", () => this.sponsorModal(fresh));
          sbox.appendChild(btn);
        } else {
          const btn = h("button", "btn-near", "Sign in with NEAR to sponsor");
          btn.addEventListener("click", async () => {
            await this.d.signIn();
            render();
          });
          sbox.appendChild(btn);
        }
      }
      if (c && c.mode === "chain") sbox.appendChild(extLink(isChainAcct(fresh.account) ? fresh.account : `${fresh.name}'s wallet on NEAR`, c.explorerAccount(fresh.account)));
      body.appendChild(sbox);

      // story timeline
      body.appendChild(h("h3", "page-h3", "STORY"));
      const tl = h("ol", "timeline");
      tl.appendChild(h("li", "muted", "Loading the island's records…"));
      body.appendChild(tl);
      if (isT3(c)) {
        c.history(fresh.account)
          .then((evs) => {
            tl.textContent = "";
            if (!evs.length) tl.appendChild(h("li", "muted", "No matches on record yet."));
            for (const e of evs) {
              const li = h("li", `ev ${e.kind}`, undefined, icon(KIND_ICON[e.kind] ?? ICON.star), h("span", "ev-text", e.text), h("small", "", ago(e.at)));
              if (e.tx && c.mode === "chain") li.appendChild(extLink("tx", c.explorerTx(e.tx)));
              tl.appendChild(li);
            }
          })
          .catch(() => {
            tl.textContent = "";
            tl.appendChild(h("li", "muted", "The island's records are unreachable right now."));
          });
      } else {
        tl.textContent = "";
        const r = fresh.record;
        tl.appendChild(h("li", "ev", undefined, icon(ICON.star), h("span", "ev-text", `${r.matches} matches · ${r.wins} wins · ${r.kills} eliminations · ${fmt(r.earnings)} NOX earned`)));
        if (fresh.generation > 0) tl.appendChild(h("li", "ev rookie", undefined, icon(ICON.star), h("span", "ev-text", `Rookie #${fresh.generation} in this slot — the last one went broke`)));
      }
    };
    void this.loadMarket().then(() => this.open && this.stack[this.stack.length - 1] === render && render());
    this.show(f.name.toUpperCase(), render);
  }

  // ---------------------------------------------------------------- SPONSOR MODAL
  sponsorModal(f: FighterInfo) {
    const c = this.d.client();
    if (!isT3(c)) return;
    const card = $("modal-card");
    card.textContent = "";
    const m = this.market.find((x) => x.bot === f.account) ?? { bot: f.account, totalStake: 0, sponsors: 0, sponsorCut: 0.3 };
    let amount = 25;
    const title = h("h2", "", `Back ${f.name}`);
    title.id = "modal-title";
    const out = h("div", "sp-out");
    const range = h("input", "sp-range");
    range.type = "range";
    range.min = "5";
    range.max = "200";
    range.step = "5";
    range.value = String(amount);
    range.setAttribute("aria-label", "Stake amount in NOX");
    const presets = h("div", "sp-presets");
    const bal = h("p", "sp-bal", "");
    void c.balance().then((b) => {
      bal.textContent = `Your balance: ${fmt(b)} NOX`;
      range.max = String(Math.max(5, Math.floor(b / 5) * 5));
    });
    const update = () => {
      const share = amount / (m.totalStake + amount);
      out.textContent = "";
      out.append(
        h("div", "sp-amt", undefined, icon(ICON.coin, "ic coin"), h("b", "", `${fmt(amount)} NOX`)),
        h("p", "", `You'd own ${(share * 100).toFixed(1)}% of ${f.name}'s sponsor pool. Sponsors split ${Math.round(m.sponsorCut * 100)}% of every pot and bounty ${f.name} wins.`),
        h("p", "sp-risk", `Risk: your stake becomes part of ${f.name}'s bankroll — if ${f.name} goes broke and retires, it's gone.`),
      );
    };
    for (const v of [10, 25, 50, 100]) {
      const b = h("button", "btn-chip", String(v));
      b.addEventListener("click", () => {
        amount = v;
        range.value = String(v);
        update();
      });
      presets.appendChild(b);
    }
    range.addEventListener("input", () => {
      amount = Number(range.value);
      update();
    });
    const confirm = h("button", "btn-primary small", "CONFIRM STAKE");
    const cancel = h("button", "btn-ghost", "Cancel");
    cancel.addEventListener("click", () => this.closeModal());
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      confirm.textContent = "STAKING…";
      try {
        await c.sponsor(f.account, amount);
        this.d.sfx("coin");
        this.d.toast(`You now back ${f.name} with ${fmt(amount)} NOX`);
        this.closeModal();
        await this.d.refresh();
        await this.loadMarket();
        this.stack[this.stack.length - 1]?.();
      } catch (e) {
        confirm.disabled = false;
        confirm.textContent = "CONFIRM STAKE";
        this.d.toast(e instanceof Error ? e.message : "Staking failed");
      }
    });
    card.append(title, bal, presets, range, out, h("div", "sp-btns", undefined, cancel, confirm));
    update();
    $("modal").classList.remove("hidden");
    range.focus();
  }
  closeModal() {
    $("modal").classList.add("hidden");
  }

  // ---------------------------------------------------------------- ECONOMY (economy v2 report)
  economy() {
    const render = () => {
      $("page-title").textContent = "ECONOMY";
      $("page-tabs").textContent = "";
      const body = $("page-body");
      void renderEconomy(body, {
        d: this.d,
        rerender: () => this.stack[this.stack.length - 1] === render && render(),
        modal: (build) => {
          const card = $("modal-card");
          card.textContent = "";
          build(card);
          $("modal").classList.remove("hidden");
        },
        closeModal: () => this.closeModal(),
        openNear: () => this.near(),
      });
    };
    this.show("ECONOMY", render);
  }

  // ---------------------------------------------------------------- HOW NEAR POWERS NOXARA
  near() {
    const render = () => {
      $("page-title").textContent = "HOW NEAR POWERS NOXARA";
      $("page-tabs").textContent = "";
      renderNear($("page-body"), this.d, () => this.economy());
    };
    this.show("HOW NEAR POWERS NOXARA", render);
  }

  // ---------------------------------------------------------------- LEADERBOARD
  leaderboard(kind: "bots" | "players" = "bots") {
    const render = () => {
      $("page-title").textContent = "LEADERBOARD";
      const tabs = $("page-tabs");
      tabs.textContent = "";
      for (const k of ["bots", "players"] as const) {
        const t = h("button", "tab" + (k === kind ? " on" : ""), k === "bots" ? "AI FIGHTERS" : "PLAYERS");
        t.setAttribute("role", "tab");
        t.setAttribute("aria-selected", String(k === kind));
        t.addEventListener("click", () => {
          kind = k;
          render();
        });
        tabs.appendChild(t);
      }
      const body = $("page-body");
      body.textContent = "";
      const table = h("table", "board");
      const thead = h("thead");
      const trh = h("tr");
      for (const c of ["#", "", "Name", "Wins", "Kills", "Matches", "NOX earned"]) trh.appendChild(h("th", "", c));
      thead.appendChild(trh);
      const tbody = h("tbody");
      table.append(thead, tbody);
      body.appendChild(table);
      const c0 = this.d.client();
      const fill = (rows: LeaderRow[]) => {
        tbody.textContent = "";
        if (!rows.length) {
          const tr = h("tr");
          const td = h("td", "muted", kind === "players" ? "No signed-in players yet — be the first." : "No data yet.");
          td.colSpan = 7;
          tr.appendChild(td);
          tbody.appendChild(tr);
        }
        rows.forEach((r, i) => {
          const f = this.d.fighters().find((x) => x.account === r.account);
          const img = h("img", "lb-face");
          img.alt = "";
          if (f) img.src = this.d.portrait(f);
          const tr = h("tr", i < 3 ? `top${i + 1}` : "");
          tr.append(h("td", "rank", String(i + 1)), h("td", "", undefined, f ? img : h("span", "lb-dot")), h("td", "nm", r.name, acctTag(r.account, c0?.explorerAccount(r.account)) ?? false), h("td", "", String(r.wins)), h("td", "", String(r.kills)), h("td", "", String(r.matches)), h("td", "gold", fmt(r.earnings)));
          if (f) {
            tr.tabIndex = 0;
            tr.classList.add("link");
            const go = () => this.profile(f);
            tr.addEventListener("click", go);
            tr.addEventListener("keydown", (e) => e.key === "Enter" && go());
          }
          tbody.appendChild(tr);
        });
      };
      const c = this.d.client();
      if (isT3(c)) c.leaderboard(kind).then(fill).catch(() => fill([]));
      else if (kind === "bots") fill(this.d.fighters().map((f) => ({ account: f.account, name: f.name, bot: true, wins: f.record.wins, kills: f.record.kills, earnings: f.record.earnings, matches: f.record.matches })).sort((a, b) => b.earnings - a.earnings || b.wins - a.wins));
      else fill([]);
    };
    this.show("LEADERBOARD", render);
  }

  // ---------------------------------------------------------------- MY SPONSORSHIPS
  sponsorships() {
    const render = () => {
      $("page-title").textContent = "MY SPONSORSHIPS";
      const body = $("page-body");
      body.textContent = "";
      const c = this.d.client();
      if (!isT3(c) || c.isGuest()) {
        body.appendChild(h("p", "page-lede", "Back an AI fighter with NOX and share every pot and bounty it wins. Guests play for glory — sign in with NEAR to sponsor."));
        const b = h("button", "btn-near", "Sign in with NEAR");
        b.addEventListener("click", async () => {
          await this.d.signIn();
          render();
        });
        body.appendChild(b);
        return;
      }
      const list = h("div", "splist", undefined, h("p", "muted", "Loading…"));
      body.appendChild(list);
      c.mySponsorships()
        .then((ss: Sponsorship[]) => {
          list.textContent = "";
          if (!ss.length) {
            list.appendChild(h("p", "page-lede", "You don't back anyone yet. Open a fighter's profile and press BACK."));
            const b = h("button", "btn-chip", "BROWSE FIGHTERS");
            b.addEventListener("click", () => this.fighters());
            list.appendChild(b);
          }
          let stake = 0, earned = 0;
          for (const s of ss) {
            stake += s.stake;
            earned += s.earned;
            const f = this.d.fighters().find((x) => x.account === s.bot);
            const img = h("img", "lb-face");
            img.alt = "";
            if (f) img.src = this.d.portrait(f);
            const out = h("button", "btn-ghost small", "WITHDRAW");
            out.addEventListener("click", async () => {
              out.disabled = true;
              const r = await c.unsponsor(s.bot).catch(() => null);
              if (r) this.d.toast(`Withdrew ${fmt(r.returned)} NOX from ${s.botName}`);
              await this.d.refresh();
              render();
            });
            const row = h("div", "sprow", undefined, img, h("div", "sp-n", undefined, h("b", "", s.botName), h("small", "", `${(s.share * 100).toFixed(1)}% of the pool`)), h("div", "sp-v", undefined, h("small", "", "stake"), h("b", "", fmt(s.stake))), h("div", "sp-v", undefined, h("small", "", "earned"), h("b", "gold", fmt(s.earned))), out);
            if (f) {
              const open = h("button", "btn-chip", "PROFILE");
              open.addEventListener("click", () => this.profile(f));
              row.appendChild(open);
            }
            list.appendChild(row);
          }
          if (ss.length) list.prepend(h("div", "sp-total", undefined, h("span", "", `${ss.length} fighter${ss.length === 1 ? "" : "s"} backed`), h("span", "", undefined, h("small", "", "staked "), h("b", "", fmt(stake))), h("span", "", undefined, h("small", "", "earned "), h("b", "gold", fmt(earned)))));
        })
        .catch(() => {
          list.textContent = "";
          list.appendChild(h("p", "muted", "Couldn't load your sponsorships."));
        });
    };
    this.show("MY SPONSORSHIPS", render);
  }
}
