// ECONOMY page (EVE-style season economic report in our game style) and HOW NEAR POWERS NOXARA.
// Pure view code: reads GameClientEcon, never throws into the UI (every view has neutral fallbacks).
import { NEAR_NETWORK, NETWORK_DEFAULTS } from "../net/client";
import type { EconomyInfo, FighterInfo, GameClient, GameClientEcon, Holding, Listing, SeasonRow, ShareMarketRow } from "../net/api";
import { acctTag } from "./acct";
import { h, icon, ICON, fmt } from "./dom";
import type { PageDeps } from "./pages";

const NS = "http://www.w3.org/2000/svg";
const $ = (id: string) => document.getElementById(id)!;
export const hasEcon = (c: GameClient | null): c is GameClient & GameClientEcon => !!c && "economy" in c && "sharesMarket" in c;

function extLink(text: string, href: string) {
  const a = h("a", "near-link", undefined, icon(ICON.link), h("span", "", text));
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

/** Tiny inline-SVG sparkline (no chart library). `lo`/`hi` optionally pin the y range. */
export function sparkline(values: number[], label: string, color = "#3df2ff", lo?: number, hi?: number): SVGSVGElement {
  const W = 120, H = 34, P = 3;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "spark");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  if (values.length < 2) return svg;
  const mn = lo ?? Math.min(...values), mx = hi ?? Math.max(...values);
  const span = mx - mn || 1;
  const pts = values.map((v, i) => `${(P + (i / (values.length - 1)) * (W - 2 * P)).toFixed(1)},${(H - P - ((v - mn) / span) * (H - 2 * P)).toFixed(1)}`);
  const area = document.createElementNS(NS, "polygon");
  area.setAttribute("points", `${P},${H - P} ${pts.join(" ")} ${W - P},${H - P}`);
  area.setAttribute("fill", color);
  area.setAttribute("opacity", ".18");
  const line = document.createElementNS(NS, "polyline");
  line.setAttribute("points", pts.join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-linejoin", "round");
  line.setAttribute("stroke-linecap", "round");
  svg.append(area, line);
  return svg;
}

function countdown(ms: number): string {
  const s = Math.max(0, Math.floor((ms - Date.now()) / 1000));
  const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${hr}h ${m}m` : `${hr}h ${m}m`;
}
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d).replace(/\.0$/, "")}%`;
const signed = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmt(Math.abs(n));
export const upkeepHint = (wallet: number) => (wallet > 600 ? "4% upkeep on the part above 600" : wallet > 300 ? "2% upkeep above 300" : wallet > 150 ? "1% upkeep above 150" : "no upkeep (under 150)");

function tile(label: string, value: string, sub: string, extra?: Node | null, cls = ""): HTMLElement {
  return h("div", "et " + cls, undefined, h("span", "et-l", label), h("b", "et-v", value), h("small", "et-s", sub), extra || null);
}
function bar(value: number, max: number, marks: { at: number; label: string }[] = []): HTMLElement {
  const b = h("div", "ebar");
  b.setAttribute("role", "presentation");
  const f = h("i", "ebar-f");
  f.style.width = `${Math.max(0, Math.min(1, value / (max || 1))) * 100}%`;
  b.appendChild(f);
  for (const m of marks) {
    const k = h("em", "ebar-m");
    k.style.left = `${Math.min(1, m.at / (max || 1)) * 100}%`;
    k.title = m.label;
    b.appendChild(k);
  }
  return b;
}

type Ctx = { d: PageDeps; c: GameClient & GameClientEcon; rerender(): void; signedIn: boolean; modal(build: (card: HTMLElement) => void): void; closeModal(): void };

/** Render the whole ECONOMY page into `body`. */
export async function renderEconomy(body: HTMLElement, ctx: Omit<Ctx, "c" | "signedIn"> & { openNear(): void }) {
  body.textContent = "";
  const c = ctx.d.client();
  body.appendChild(h("p", "page-lede", "The season economic report of an AI esports league (a season = 2 days). Nine autonomous fighters with wallets, one public rule that steers the money, and shares you can own. NOX is play-money: no real-money wagering anywhere."));
  if (!hasEcon(c)) {
    body.appendChild(h("p", "muted", "The economy needs the game client. Reload the page."));
    return;
  }
  const guest = c.isGuest();
  const x: Ctx = { ...ctx, c, signedIn: !guest };
  const loading = h("p", "muted", "Loading live economy from NEAR…");
  body.appendChild(loading);
  let ecoFailed = false; // a rate limit / outage, not a missing economy
  const [eco, market, season, mine, listings] = await Promise.all([
    c.economy().catch(() => ((ecoFailed = true), null)),
    c.sharesMarket().catch(() => [] as ShareMarketRow[]),
    c.seasonStandings().catch(() => [] as SeasonRow[]),
    guest ? Promise.resolve([] as Holding[]) : c.myShares().catch(() => [] as Holding[]),
    c.listings().catch(() => [] as Listing[]),
  ]);
  if (!body.contains(loading)) return; // the page was re-rendered or closed meanwhile
  loading.remove();
  const live = !!eco && eco.genesis > 0;
  if (!live) {
    body.appendChild(h("p", "e-warn", c.mode === "chain" && !ecoFailed ? "Economy v2 isn't live on this contract yet: the numbers below stay empty until the contract upgrade lands." : "Live data is unavailable right now. Try again."));
    const retry = h("button", "btn-ghost small", "TRY AGAIN");
    retry.addEventListener("click", () => ctx.rerender());
    body.appendChild(retry);
  }
  const e: EconomyInfo = eco ?? ({ supply: 0, genesis: 0, minted: 0, burned: 0, house: 0, houseEma: 0, floor: 0, target: 0, m: 0, houseShare: 0, burnShare: 0, brake: 0, topUp: 0, season: 0, seasonEndsAt: 0, seasonBurned: 0, seasonRewards: 0, snapshots: [] } as EconomyInfo);
  const sn = e.snapshots;

  // ------------------------------------------------ headline tiles
  const grid = h("div", "etgrid");
  grid.append(
    tile("SUPPLY", live ? fmt(e.supply) : "–", live ? (e.minted > e.genesis ? `of ${fmt(e.genesis)} at genesis · 0 minted since economy v2 · ${fmt(e.minted - e.genesis)} was minted by the old v1 economy before this contract was upgraded (testnet)` : `of ${fmt(e.genesis)} at genesis · 0 minted since`) : "no data", live ? h("div", "et-x", undefined, bar(e.supply, e.genesis), sparkline(sn.map((s) => s.supply), "Supply over the last matches")) : null),
    tile("BURNED", live ? fmt(e.burned) : "–", live ? `${fmt(e.seasonBurned)} this season` : "no data", live ? sparkline(sn.map((s) => s.burned), "Burned NOX over the last matches", "#ff4d6d") : null),
    tile("HOUSE TREASURY", live ? fmt(e.house) : "–", live ? `target ${fmt(e.target)} · floor ${fmt(e.floor)} · average ${fmt(e.houseEma)}` : "no data", live ? h("div", "et-x", undefined, bar(e.house, Math.max(e.target * 1.5, e.house), [{ at: e.floor, label: "floor" }, { at: e.target, label: "target" }]), sparkline(sn.map((s) => s.house), "House treasury over the last matches", "#ffc93c")) : null, "gold"),
    tile("REWARD MULTIPLIER m", live ? `×${e.m.toFixed(2)}` : "–", live ? `pot top-up ${fmt(e.topUp)} NOX · max ×1.5` : "no data", live ? sparkline(sn.map((s) => s.m), "Reward multiplier over the last matches", "#3ef0c0", 0, 1.5) : null),
    tile("POT SPLIT", live ? `${pct(e.houseShare)} / ${pct(e.burnShare)}` : "–", "House share / burn share of every pot"),
    tile("DEFLATION BRAKE s", live ? e.brake.toFixed(2) : "–", live ? (e.brake >= 1 ? "all burns burn" : `only ${pct(e.brake, 0)} of each burn burns, the rest goes to the House`) : "no data"),
    tile("SEASON", live ? `#${e.season}` : "–", live ? `ends in ${countdown(e.seasonEndsAt)} · rewards paid ${fmt(e.seasonRewards)} NOX` : "no data"),
  );
  body.appendChild(grid);

  // ------------------------------------------------ explainer
  if (live) {
    const dir = e.house >= e.target ? "above" : "below";
    body.appendChild(
      h(
        "p",
        "e-explain",
        `The House rule, in plain English: the House holds ${fmt(e.house)} NOX (its 16-match average is ${fmt(e.houseEma)}) against a target of ${fmt(e.target)} and a floor of ${fmt(e.floor)}. ` +
          `It is ${dir} target, so rewards run at ×${e.m.toFixed(2)}, the House keeps ${pct(e.houseShare)} of every pot and ${pct(e.burnShare)} is burned (scaled by the brake ${e.brake.toFixed(2)}). ` +
          `Richer House means bigger rewards and lighter taxes; a poorer House the opposite. Economy v2 mints nothing (on testnet, 250 NOX were minted by the v1 economy before the upgrade), and nobody patches this: the rule is public in get_economy. `,
        extLinkDoc(),
      ),
    );
  } else {
    body.appendChild(h("p", "e-explain", "The House rule steers rewards from the treasury's moving average: richer House, bigger rewards and lighter taxes; poorer House, the opposite. Nothing is minted after genesis. ", extLinkDoc()));
  }

  // ------------------------------------------------ bots by P&L
  body.appendChild(h("h3", "page-h3", "BOTS BY P&L (THIS SEASON)"));
  const byBot = new Map(market.map((m) => [m.bot, m]));
  const pnlRows = [...season].sort((a, b) => b.pnl - a.pnl);
  body.appendChild(
    table(
      ["#", "Fighter", "Income", "Costs", "P&L", "Wallet", "Upkeep bracket"],
      pnlRows.map((r, i) => ({
        cls: r.pnl < 0 ? "neg" : "",
        cells: [
          { t: String(i + 1), l: "#", c: "rank" },
          { t: r.name, n: acctTag(r.bot) ?? undefined, l: "Fighter", c: "nm" },
          { t: fmt(r.income), l: "Income" },
          { t: fmt(r.costs), l: "Costs" },
          { t: signed(r.pnl), l: "P&L", c: r.pnl < 0 ? "red" : "mint" },
          { t: byBot.has(r.bot) ? fmt(byBot.get(r.bot)!.wallet) : "–", l: "Wallet", c: "gold" },
          { t: byBot.has(r.bot) ? upkeepHint(byBot.get(r.bot)!.wallet) : "–", l: "Upkeep", c: "uphint" },
        ],
      })),
      "No season results yet.",
      "Bots ranked by season profit and loss",
    ),
  );

  // ------------------------------------------------ shares
  body.appendChild(h("h3", "page-h3", "SHARES (1,000 PER FIGHTER)"));
  if (guest) {
    const g = h("div", "e-guest", undefined, h("span", "", "Sign in to own shares — guests can't hold shares."));
    const b = h("button", "btn-near", "Sign in with NEAR");
    b.addEventListener("click", async () => {
      await ctx.d.signIn();
      ctx.rerender();
    });
    g.appendChild(b);
    body.appendChild(g);
  }
  const mkBtn = (label: string, aria: string, fn: () => void, cls = "btn-chip small") => {
    const b = h("button", cls, label);
    b.setAttribute("aria-label", aria);
    b.addEventListener("click", fn);
    return b;
  };
  const myByBot = new Map(mine.map((m) => [m.bot, m]));
  body.appendChild(
    table(
      guest ? ["Fighter", "IPO left", "IPO price", "Last price", "Book value", "Dividends paid", "Holders"] : ["Fighter", "IPO left", "IPO price", "Last price", "Book value", "Dividends paid", "Holders", "Actions"],
      market.map((r) => {
        const own = myByBot.get(r.bot);
        const acts = h("div", "acts");
        if (!guest && r.status === "active") {
          if (r.ipoLeft > 0) acts.appendChild(mkBtn("BUY IPO", `Buy IPO shares of ${r.name}`, () => ipoModal(x, r)));
          if (own && own.shares > 0) acts.appendChild(mkBtn("LIST", `List your ${r.name} shares for sale`, () => listModal(x, r, own.shares)));
          if (own && own.claimable > 0) acts.appendChild(mkBtn(`CLAIM ${fmt(own.claimable)}`, `Claim ${fmt(own.claimable)} NOX of ${r.name} dividends`, () => act(x, () => c.claimDividends(r.bot), `Claimed ${r.name}'s dividends`), "btn-chip small claim"));
        }
        return {
          cls: r.status === "retired" ? "gone" : "",
          cells: [
            { t: r.name + (r.status === "retired" ? " (retired)" : "") + (own ? ` · you own ${own.shares}` : ""), n: acctTag(r.bot) ?? undefined, l: "Fighter", c: "nm" },
            { t: r.status === "retired" ? "–" : r.ipoLeft ? String(r.ipoLeft) : "sold out", l: "IPO left" },
            { t: r.ipoLeft ? `${fmt(r.ipoPrice)} NOX` : "–", l: "IPO price" },
            { t: r.lastPrice === null ? "no trades" : `${fmt(r.lastPrice)} NOX`, l: "Last price" },
            { t: `${fmt(r.wallet / 1000)} NOX`, l: "Book value", c: "gold" },
            { t: `${fmt(r.dividendsPaid)} NOX`, l: "Dividends" },
            { t: String(r.holders), l: "Holders" },
            ...(guest ? [] : [{ n: acts, l: "Actions" }]),
          ],
        };
      }),
      "The share market opens with the contract upgrade.",
      "Fighter shares: IPO, last price, book value and dividends",
    ),
  );
  body.appendChild(h("p", "e-note", "Book value = the fighter's wallet / 1,000. Dividends are 20% of a fighter's profit above its high-water mark. A rookie's IPO often loses money; that is the risk. Trades carry a 2% tax that is burned."));

  // ------------------------------------------------ my holdings + listings
  if (!guest && mine.length) {
    body.appendChild(h("h3", "page-h3", "YOUR SHARES"));
    body.appendChild(
      table(
        ["Fighter", "Shares", "Value", "Dividends waiting"],
        mine.map((m) => ({ cells: [{ t: m.name, n: acctTag(m.bot) ?? undefined, l: "Fighter", c: "nm" }, { t: String(m.shares), l: "Shares" }, { t: `${fmt(m.value)} NOX`, l: "Value", c: "gold" }, { t: `${fmt(m.claimable)} NOX`, l: "Dividends", c: "mint" }] })),
        "",
        "Your shares",
      ),
    );
  }
  body.appendChild(h("h3", "page-h3", "SHARES FOR SALE"));
  const me = guest ? "" : await c.account().catch(() => "");
  body.appendChild(
    table(
      guest ? ["Fighter", "Shares", "Price / share", "Total (+2% tax)", "Seller", "Expires"] : ["Fighter", "Shares", "Price / share", "Total (+2% tax)", "Seller", "Expires", "Actions"],
      listings.map((l) => {
        const acts = h("div", "acts");
        if (!guest) acts.appendChild(l.seller === me ? mkBtn("CANCEL", `Cancel your listing of ${l.name}`, () => act(x, () => c.cancelListing(l.id), "Listing cancelled"), "btn-chip small") : mkBtn("BUY (WALLET)", `Buy ${l.shares} ${l.name} shares, confirmed in your wallet`, () => act(x, () => c.buyListing(l.id), `Bought ${l.shares} ${l.name} shares`, true), "btn-chip small"));
        return {
          cells: [
            { t: l.name, n: acctTag(l.bot) ?? undefined, l: "Fighter", c: "nm" },
            { t: String(l.shares), l: "Shares" },
            { t: `${fmt(l.pricePerShare)} NOX`, l: "Price" },
            { t: `${fmt(l.shares * l.pricePerShare * 1.02)} NOX`, l: "Total", c: "gold" },
            { t: l.seller === me ? "you" : l.seller.replace(/\.(testnet|near)$/, ""), l: "Seller" },
            { t: l.expiresAt ? `in ${countdown(l.expiresAt)}` : "–", l: "Expires" },
            ...(guest ? [] : [{ n: acts, l: "Actions" }]),
          ],
        };
      }),
      "No open listings.",
      "Open share listings",
    ),
  );

  // ------------------------------------------------ standings
  body.appendChild(h("h3", "page-h3", `SEASON ${live ? "#" + e.season + " " : ""}STANDINGS`));
  body.appendChild(
    table(
      ["#", "Fighter", "Points", "Wins", "Kills"],
      [...season].sort((a, b) => b.points - a.points).map((r, i) => ({ cls: i < 3 ? `top${i + 1}` : "", cells: [{ t: String(i + 1), l: "#", c: "rank" }, { t: r.name, n: acctTag(r.bot) ?? undefined, l: "Fighter", c: "nm" }, { t: String(r.points), l: "Points", c: "gold" }, { t: String(r.wins), l: "Wins" }, { t: String(r.kills), l: "Kills" }] })),
      "No standings yet.",
      "Season standings: 10 points per win, 2 per kill",
    ),
  );
  body.appendChild(h("p", "e-note", "10 points per win, 2 per kill. Seasons last 2 days; points and P&L reset, career history and shares stay."));

  const foot = h("div", "e-foot", undefined, h("span", "", "Everything above is read straight from the contract."));
  const near = h("button", "btn-chip", "HOW NEAR POWERS NOXARA →");
  near.addEventListener("click", ctx.openNear);
  foot.appendChild(near);
  body.appendChild(foot);
}

function extLinkDoc(): HTMLElement {
  const s = h("span", "e-doc", undefined, h("span", "", "Full spec: "), h("code", "", "docs/ECONOMY.md"), h("span", "", " in the repository."));
  return s;
}

type Row = { cls?: string; cells: { t?: string; n?: Node; l: string; c?: string }[] };
/** A real <table> on desktop; `data-label` + CSS turns each row into a card at ≤720 px. */
function table(head: string[], rows: Row[], empty: string, caption: string): HTMLElement {
  const wrap = h("div", "etable-wrap");
  const t = h("table", "board etable");
  t.appendChild(h("caption", "sr-only", caption));
  const thead = h("thead");
  const tr = h("tr");
  for (const c of head) {
    const th = h("th", "", c);
    th.scope = "col";
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  const tb = h("tbody");
  if (!rows.length && empty) {
    const r = h("tr");
    const td = h("td", "muted", empty);
    td.colSpan = head.length;
    r.appendChild(td);
    tb.appendChild(r);
  }
  for (const r of rows) {
    const row = h("tr", r.cls ?? "");
    for (const c of r.cells) {
      const td = h("td", c.c ?? "", c.t);
      td.dataset.label = c.l;
      if (c.n) td.appendChild(c.n);
      row.appendChild(td);
    }
    tb.appendChild(row);
  }
  t.append(thead, tb);
  wrap.appendChild(t);
  return wrap;
}

async function act(x: Ctx, fn: () => Promise<unknown>, ok: string, wallet = false) {
  try {
    if (wallet) x.d.toast("Confirm in your wallet…");
    await fn();
    x.d.sfx("coin");
    x.d.toast(ok);
    await x.d.refresh();
    x.rerender();
  } catch (e) {
    x.d.toast(e instanceof Error ? e.message : "That didn't go through");
  }
}

function numInput(label: string, min: number, max: number, value: number, step = 1) {
  const id = "ei-" + label.replace(/\W/g, "");
  const wrap = h("label", "e-field");
  wrap.htmlFor = id;
  const inp = h("input", "e-input");
  inp.id = id;
  inp.type = "number";
  inp.min = String(min);
  inp.max = String(max);
  inp.step = String(step);
  inp.value = String(value);
  wrap.append(h("span", "", label), inp);
  return { wrap, inp };
}

function ipoModal(x: Ctx, r: ShareMarketRow) {
  x.modal((card) => {
    const t = h("h2", "", `Buy ${r.name} shares (IPO)`);
    t.id = "modal-title";
    const { wrap, inp } = numInput("Shares", 1, r.ipoLeft, Math.min(10, r.ipoLeft));
    const out = h("p", "e-cost");
    const upd = () => {
      const n = Math.max(1, Math.min(r.ipoLeft, Math.floor(Number(inp.value)) || 1));
      out.textContent = `${n} shares × ${fmt(r.ipoPrice)} = ${fmt(n * r.ipoPrice)} NOX. The NOX goes into ${r.name}'s own wallet as bankroll, and you receive 20% of its profits pro rata.`;
    };
    inp.addEventListener("input", upd);
    upd();
    const risk = h("p", "sp-risk", `Risk: ${r.name} can go broke. Then the shares are worth nothing. NOX is play-money.`);
    const ok = h("button", "btn-primary small", "CONFIRM");
    const cancel = h("button", "btn-ghost", "Cancel");
    cancel.addEventListener("click", () => x.closeModal());
    ok.addEventListener("click", async () => {
      const n = Math.max(1, Math.min(r.ipoLeft, Math.floor(Number(inp.value)) || 1));
      ok.disabled = true;
      ok.textContent = "BUYING…";
      x.closeModal();
      await act(x, () => x.c.buyIpo(r.bot, n), `Bought ${n} ${r.name} shares`);
    });
    card.append(t, wrap, out, risk, h("div", "sp-btns", undefined, cancel, ok));
    inp.focus();
  });
}

function listModal(x: Ctx, r: ShareMarketRow, owned: number) {
  x.modal((card) => {
    const t = h("h2", "", `List ${r.name} shares`);
    t.id = "modal-title";
    const a = numInput("Shares to sell", 1, owned, owned);
    const b = numInput("Price per share (NOX)", 0.01, 1000, Math.max(0.01, Math.round((r.lastPrice ?? r.wallet / 1000) * 100) / 100), 0.01);
    const out = h("p", "e-cost");
    const upd = () => {
      const n = Math.max(1, Math.min(owned, Math.floor(Number(a.inp.value)) || 1));
      const p = Math.max(0.01, Number(b.inp.value) || 0.01);
      out.textContent = `Buyer pays ${fmt(n * p * 1.02)} NOX (2% tax is burned). You get ${fmt(n * p)} NOX. The listing lasts 48 h. You confirm in your wallet (1 yoctoNEAR, no fee to you): this protects your shares.`;
    };
    a.inp.addEventListener("input", upd);
    b.inp.addEventListener("input", upd);
    upd();
    const ok = h("button", "btn-primary small", "LIST (CONFIRM IN WALLET)");
    const cancel = h("button", "btn-ghost", "Cancel");
    cancel.addEventListener("click", () => x.closeModal());
    ok.addEventListener("click", async () => {
      const n = Math.max(1, Math.min(owned, Math.floor(Number(a.inp.value)) || 1));
      const p = Math.max(0.01, Number(b.inp.value) || 0.01);
      x.closeModal();
      await act(x, () => x.c.listShares(r.bot, n, p), `Listed ${n} ${r.name} shares`, true);
    });
    card.append(t, a.wrap, b.wrap, out, h("div", "sp-btns", undefined, cancel, ok));
    a.inp.focus();
  });
}

// ====================================================================== HOW NEAR POWERS NOXARA
export function renderNear(body: HTMLElement, d: PageDeps, openEconomy: () => void) {
  body.textContent = "";
  const c = d.client();
  const contract = (c as unknown as { contractId?: string } | null)?.contractId ?? NETWORK_DEFAULTS[NEAR_NETWORK].contract;
  const acct = (a: string) => (c ? c.explorerAccount(a) : `${NETWORK_DEFAULTS[NEAR_NETWORK].explorer}/address/${a}`);
  const sec = (title: string, ...kids: (Node | null)[]) => h("section", "nsec", undefined, h("h3", "", title), ...kids);
  const p = (t: string) => h("p", "", t);
  body.appendChild(h("p", "page-lede", "NOXARA is a game first. You never need a wallet to play. Here is what NEAR does underneath, with live links so you can check it yourself."));
  const fighters = d.fighters().filter((f: FighterInfo) => f.status === "active");
  const chips = h("div", "nlinks");
  for (const f of fighters) chips.appendChild(extLink(f.name, acct(f.account)));
  body.append(
    sec("Fighters are keyless NEAR accounts", p("Each of the nine AI fighters is a real sub-account of the game contract with no access key: nobody, including us, can sign for it. Its NOX wallet is a balance in the contract, so what it earns and spends is public."), fighters.length ? chips : null),
    sec("Match seeds come from next-block randomness", p("start_match fixes the seed from the randomness of a block that does not exist yet when you press play. Neither the player nor the server can pick it.")),
    sec("Every match is settled on chain after a replay check", p("The match server replays the input log before settling, and the contract records the result with its hash. Anyone can replay that log themselves (npm run verify-match) and must get the same result hash."), extLink("Settlements: the game contract's transactions", acct(contract))),
    sec("NOX is a NEP-141 token; shares are NEP-245", p("NOX and the fighter shares live in one contract. NOX follows NEP-141. Fighter shares follow NEP-245 (views, transfers, events); they never leave the contract. NOX is play-money: it can't be bought, there is no swap.")),
    sec("Gasless guest play", p("A guest gets a function-call key limited to the game contract, and a relayer wraps each call in a NEP-366 meta-transaction and pays the gas. No wallet pop-up, no fee. Real NEAR accounts sign in once and then play the same way.")),
    sec("Welcome credit", p("A real account gets 30 NOX of entry-only credit, once, with a daily cap. The House pays it out of treasury NOX. Nothing is minted for it, and guests earn 0.")),
    sec("The House rule is readable on chain", p("Rewards, taxes, burns and the brake follow one public formula of the House's moving average. Read it yourself:"), h("pre", "ncode", `near view ${contract} get_economy`), (() => { const b = h("button", "btn-chip small", "SEE THE LIVE NUMBERS"); b.addEventListener("click", openEconomy); return b; })()),
    sec("Honest trust model", p("The match server computes and replays each match before settling it; the contract records the result and the input-log hash; anyone can re-verify it independently. Settlement proves the result matches the recorded inputs, not that a human played them. During judging the developer keeps the contract key so bugs can be fixed. This is testnet; nothing here is real money."), extLink("The contract on NEAR", acct(contract))),
  );
}
