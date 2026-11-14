// NOXARA client: fixed-step simulation (TICK_HZ) + interpolated Three.js rendering + juice.
import * as THREE from "three";
import { FIGHTERS, TICK_HZ, type Input, type Match, type MatchRecord, type SimEvent } from "./sim/types";
import { createMatch } from "./sim/match";
import { botInput } from "./sim/ai";
import { displayId, isChainAcct, shortAcct } from "./ui/acct";
import { PauseMenu } from "./ui/menu";
import { AimLine } from "./render/aimline";
import { Recorder } from "./sim/record";
import { t1Roster } from "./sim/roster";
import { SPAWN_PROTECT, WEAPONS } from "./sim/rules";
import { HUMAN_SKIN_IDS, charFor, loadAll } from "./render/assets";
import { makeWater, World } from "./render/world";
import { FighterView } from "./render/fighters";
import { Fx } from "./render/fx";
import { makePortraits, makeWeaponIcons } from "./render/icons";
import { BOLT_COLOR, PAL, WEAPON_LABEL } from "./render/palette";
import { Controls } from "./input/input";
import { Hud } from "./ui/hud";
import { sfx } from "./audio/sfx";
import { createGameClient, NEAR_NETWORK } from "./net/client";
import type { FighterInfo, GameClient, GameClientT3, SettleResult, StartResult } from "./net/api";
import { withMock } from "./ui/mock";
import { Pages } from "./ui/pages";
import { levelBadge, localXp, renderXp, setLocalXp } from "./ui/progress";
import { levelProgress, upgradesForLevel, xpForMatch } from "./sim/progression";
import type { MatchConfig } from "./sim/types";
import { diffLines, fillSparks, loadSnap, lobbySkeleton, renderLobby, saveSnap, sparkFromHistory, type Snap, type Spark } from "./ui/lobby";
import { renderLedger, PLAY_MONEY_NOTE } from "./ui/ledger";
import { Coach } from "./ui/coach";
import { specsFromFighters } from "./net/roster";
import { Social } from "./ui/challenge";
import { fmt } from "./ui/dom";
import { BIG_ISLAND_ENABLED } from "./modes";

const U = 1 / 1000;
const DT = 1 / TICK_HZ;
const params = new URLSearchParams(location.search);
const E2E = params.has("e2e");
const AUTOPLAY = params.has("autoplay");
const SKIP_TITLE = params.get("bots") === "1";
const CAM_DIST = Number(params.get("cam") ?? 0) || 0;
const MOCK = params.has("mock");
/** ?offline: the whole session stays local (no network at all), like ?seed. */
const OFFLINE = params.has("offline");
/** ?map=big: local matches are played on Big Island (tests / FPS runs) */
const BIG_PARAM = BIG_ISLAND_ENABLED && params.get("map") === "big";
const SPEED = Math.max(0.25, Math.min(16, Number(params.get("speed") ?? 1) || 1));
const $ = (id: string) => document.getElementById(id)!;
/** touch hints on any touch-first device (coarse pointer) or once a touch has been seen, however narrow the window */
const touchy = () => controls.touchMode || matchMedia("(pointer: coarse)").matches;

// ------------------------------------------------------------------ renderer + scene
// Let the title paint first, and keep GPU probing / context creation in their own short tasks.
const yieldTask = () => new Promise<void>((r) => setTimeout(r, 0));
await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const canvas = $("view") as HTMLCanvasElement;
// Software rasterizers (SwiftShader / llvmpipe, e.g. headless CI or blocklisted GPUs) start in low quality.
const SOFTWARE_GL = (() => {
  try {
    const gl = document.createElement("canvas").getContext("webgl2") as WebGL2RenderingContext | null;
    if (!gl) return false;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return /swiftshader|llvmpipe|software|softpipe/i.test(name);
  } catch {
    return false;
  }
})();
await yieldTask();
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !SOFTWARE_GL, alpha: true, powerPreference: "high-performance" });
const FORCED_Q = params.has("q") ? Math.max(0, Math.min(4, Number(params.get("q")) || 0)) : -1;
const BASE_DPR = Math.min(2, devicePixelRatio || 1);
renderer.setPixelRatio(BASE_DPR);
// Auto quality: if the frame rate stays low, render fewer pixels / drop shadows (never raises above BASE_DPR).
let quality = 0;
let qT = 0, qFrames = 0, qGrace = 1.2;
function setQuality(q: number) {
  quality = q;
  const scale = [1, 0.8, 0.65, 0.55, 0.45][q];
  renderer.setPixelRatio(Math.max(0.4, BASE_DPR * scale));
  if (q >= 2 && renderer.shadowMap.enabled) {
    renderer.shadowMap.enabled = false;
    sun.castShadow = false;
  }
  resize();
}
function autoQuality(rdt: number) {
  if (FORCED_Q >= 0) return;
  if (qGrace > 0) { qGrace -= rdt; return; }
  qT += rdt; qFrames++;
  if (qT < 0.75) return;
  const fps = qFrames / qT;
  qT = 0; qFrames = 0;
  if (fps < 48 && quality < 4) {
    setQuality(quality + 1);
    qGrace = 0.25;
  }
}
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(PAL.sky);
scene.fog = new THREE.Fog(PAL.fog, 48, 115);

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.5, 300);
const hemi = new THREE.HemisphereLight(PAL.hemiSky, PAL.hemiGround, 1.05);
scene.add(hemi);
const sun = new THREE.DirectionalLight(PAL.sun, 2.15);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -22; sc.right = 22; sc.top = 22; sc.bottom = -22; sc.near = 1; sc.far = 80;
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

// ground arrow that points back to the safe zone while you are in the storm
const safeArrow = (() => {
  const sh = new THREE.Shape();
  sh.moveTo(0, 1.1); sh.lineTo(0.75, 0.2); sh.lineTo(0.28, 0.2); sh.lineTo(0.28, -0.7); sh.lineTo(-0.28, -0.7); sh.lineTo(-0.28, 0.2); sh.lineTo(-0.75, 0.2); sh.closePath();
  const g = new THREE.ShapeGeometry(sh);
  g.rotateX(-Math.PI / 2); // tip points to -Z
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false }));
  m.renderOrder = 20;
  m.visible = false;
  return m;
})();
const water = makeWater();
scene.add(water.mesh, safeArrow);
const fx = new Fx(scene);
const hud = new Hud();
const coach = new Coach(document.getElementById("coach")!);
const controls = new Controls(canvas, camera);
const aimLine = new AimLine();
scene.add(aimLine.group);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();
if (FORCED_Q > 0) setQuality(FORCED_Q);
else if (SOFTWARE_GL) setQuality(3);

// ------------------------------------------------------------------ game state
type Phase = "title" | "playing" | "over";
let phase: Phase = "title";
let match: Match | null = null;
let world: World | null = null;
let views: FighterView[] = [];
let recorder = new Recorder();
let record: MatchRecord | null = null;
let acc = 0;
let time = 0;
let timeScale = 1;
let slowT = 0;
let watch = 0;
let meDeadAt = -1;
let endShown = false;
let spectating = false;
let matchStartT = 0;
let stormTickT = 0;
let introT = 0;
const INTRO = 1.0;
let countShown = -1;
let lastAmmo = -1;
let gotChest = false;
let meBushSeen = false;
let myKillTimes: number[] = [];
const humanInput: Input = { mx: 0, my: 0, aim: 0, fire: false };
const inputs = new Map<number, Input>();
const killerOf = new Map<number, number | null>();

// camera rig
const camTarget = new THREE.Vector3();
const camLook = new THREE.Vector3();
let trauma = 0;
const PITCH = THREE.MathUtils.degToRad(52);

const SEED_PARAM = (() => {
  const s = params.get("seed");
  return s !== null && /^\d+$/.test(s) ? Number(s) >>> 0 : null;
})();
function localSeed(): number {
  if (SEED_PARAM !== null) return SEED_PARAM;
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}

// ------------------------------------------------------------------ chain (invisible to the player)
let client: GameClient | null = null;
// ?seed=N is a deterministic local match (tests / replays): no network at all.
const clientP: Promise<GameClient | null> =
  SEED_PARAM !== null || OFFLINE
    ? Promise.resolve(null)
    : createGameClient()
        .then((c) => (client = MOCK ? withMock(c) : c))
        .catch(() => null);
const isT3 = (c: GameClient | null): c is GameClientT3 => !!c && "signIn" in c;
let fighters: FighterInfo[] = [];
let portraits: string[] = [];
let skinPortraits: string[] = [];
let current: StartResult | null = null;
let settleState: SettleResult | "pending" | null = null;
let starting = false;
let iClaimedBounty = false;
let xpBefore = 0;
let xpAfter = 0;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

async function refreshLobby() {
  const c = await clientP;
  const mode = $("net-mode");
  if (!c) {
    mode.textContent = "offline practice — results aren't recorded";
    if (!fighters.length) fighters = localFighters();
    if (portraits.length) renderLobby($("roster"), fighters, portraits, null);
    await refreshAccount();
    return;
  }
  const list = await withTimeout(c.fighters(), 8000);
  if (list) fighters = list;
  const why: Record<string, string> = {
    relayer_unreachable: "can't reach the island server",
    wrong_contract: "island server is on another season",
    sim_version_mismatch: "game update pending",
    no_webcrypto: "this browser can't hold a guest key",
    chain_error: "NEAR is busy",
    guests_closed: "free guest spots are used up — PLAY opens the free Training Island; sign in with NEAR to play for real",
  };
  const r = c.offlineReason ? why[c.offlineReason] ?? "" : "";
  mode.textContent = c.mode === "chain" ? `live wallets · NEAR ${NEAR_NETWORK}` : `offline practice — results aren't recorded${r ? ` (${r})` : ""}`;
  mode.classList.toggle("chain", c.mode === "chain");
  if (fighters.length && portraits.length) {
    renderLobby($("roster"), fighters, portraits, prevSnap);
    void loadSparks(c);
  }
  renderTicker();
  rebuildPreview();
  await refreshAccount();
}

// ------------------------------------------------------------------ rivalry (offline modes): "<name> remembers you"
const RIVAL_KEY = "noxara.rival";
function rememberRival(name: string) {
  try {
    localStorage.setItem(RIVAL_KEY, name);
  } catch {
    /* storage blocked: no rivalry */
  }
}
function rivalIdx(cfg: MatchConfig): number | null {
  let name: string | null = null;
  try {
    name = localStorage.getItem(RIVAL_KEY);
  } catch {
    return null;
  }
  if (!name) return null;
  const i = cfg.fighters.findIndex((f, k) => k > 0 && f.name === name);
  return i > 0 ? i : null;
}

// ------------------------------------------------------------------ lobby P&L sparklines (chain history + season P&L)
let sparks = new Map<string, Spark>();
let ipoOpen = new Map<string, { left: number; price: number }>();
let sparksAt = 0;
async function loadSparks(c: GameClient) {
  if (c.mode !== "chain") return;
  const raw = c as GameClient & { rawHistory?: (a: string) => Promise<{ match: string; kind: string; amount: number; detail: string }[]>; sharesMarket?: () => Promise<{ bot: string; seasonPnl: number }[]> };
  if (!raw.rawHistory) return;
  if (Date.now() - sparksAt > 60_000 || !sparks.size) {
    sparksAt = Date.now();
    const active = fighters.filter((f) => f.status === "active");
    const [hists, market] = await Promise.all([
      Promise.all(active.map((f) => raw.rawHistory!(f.account).catch(() => []))),
      raw.sharesMarket ? raw.sharesMarket().catch(() => []) : Promise.resolve([]),
    ]);
    const pnl = new Map(market.map((m) => [m.bot, m.seasonPnl]));
    ipoOpen = new Map((market as { bot: string; ipoLeft?: number; ipoPrice?: number }[]).filter((m) => (m.ipoLeft ?? 0) > 0).map((m) => [m.bot, { left: m.ipoLeft!, price: m.ipoPrice ?? 0 }]));
    const next = new Map<string, Spark>();
    active.forEach((f, i) => next.set(f.account, { pts: sparkFromHistory(hists[i]), pnl: pnl.has(f.account) ? pnl.get(f.account)! : null }));
    sparks = next;
  }
  fillSparks($("roster"), sparks);
  renderTicker();
}

// ------------------------------------------------------------------ lobby change feed
let prevSnap: Snap | null = loadSnap();
let lastSettleLines: string[] | null = null;
function settleLines(r: SettleResult): string[] {
  const out: string[] = [];
  const prize = r.payouts.find((p) => p.reason === "prize");
  if (prize) out.push(`${prize.name} won ${fmt(prize.amount)}`);
  for (const p of r.payouts.filter((x) => x.reason === "bounty")) out.push(`${p.name} claimed a ${fmt(p.amount)} bounty`);
  for (const n of r.retired) out.push(`${n} went broke`);
  for (const n of r.rookies) out.push(`${n} joined as a rookie`);
  for (const u of r.upgrades) out.push(`${u.name} bought ${/^armou?r/i.test(u.what) ? "armor" : /^weapon/i.test(u.what) ? "a weapon upgrade" : u.what}`);
  return out;
}
/** Live world state from the contract: the Mark and its bounty, rookies (and open IPOs), recent bankruptcies. */
export function worldLines(list: FighterInfo[], ipo: Map<string, { left: number; price: number }>): string[] {
  const out: string[] = [];
  const mark = list.find((f) => f.status === "active" && f.bounty);
  if (mark) out.push(`THE MARK: ${displayId(mark.account, mark.name)} — ${mark.bountyValue > 0 ? `${fmt(mark.bountyValue)} NOX bounty` : "bounty on its head"}`);
  for (const f of list.filter((x) => x.status === "active" && x.generation > 0 && x.record.matches < 10)) {
    const i = ipo.get(f.account);
    out.push(i ? `Rookie ${displayId(f.account, f.name)}: IPO open, ${i.left} shares at ${fmt(i.price)} NOX` : `Rookie ${displayId(f.account, f.name)} joined the board`);
  }
  for (const f of list.filter((x) => x.status === "retired").slice(-3).reverse()) out.push(`${displayId(f.account, f.name)} went broke after ${f.record.matches} matches`);
  return out;
}
function renderTicker() {
  const recent = lastSettleLines ?? diffLines(prevSnap, fighters);
  const live = client?.mode === "chain" ? worldLines(fighters, ipoOpen) : [];
  const lines = [...live, ...recent];
  $("ticker").classList.toggle("hidden", !lines.length);
  $("ticker").querySelector("b")!.textContent = live.length ? "LIVE ON NEAR" : "LAST MATCH";
  const txt = $("ticker-text");
  const text = lines.join("   ·   ");
  if (txt.dataset.t === text) return;
  txt.dataset.t = text;
  txt.textContent = "";
  const run = document.createElement("span");
  run.className = "tk-run";
  run.textContent = text;
  txt.appendChild(run);
  // scroll like a news ticker only when it doesn't fit (and motion is allowed)
  requestAnimationFrame(() => {
    const over = run.scrollWidth > txt.clientWidth + 4;
    txt.classList.toggle("marquee", over);
    if (over) {
      const copy = run.cloneNode(true) as HTMLElement;
      copy.setAttribute("aria-hidden", "true");
      txt.appendChild(copy);
      txt.style.setProperty("--tk-dur", `${Math.max(14, Math.round(run.scrollWidth / 45))}s`);
    }
  });
}
addEventListener("pagehide", () => saveSnap(fighters));

/** Title-screen island: in chain mode the fighters walking around are tonight's real roster. */
function rebuildPreview() {
  if (phase !== "title" || starting || !fighters.length || !portraits.length || !client || client.mode !== "chain") return;
  const active = fighters.filter((f) => f.status === "active").sort((a, b) => a.slot - b.slot);
  if (active.length !== 9) return;
  const cfg = localStart().cfg;
  if (match) cfg.seed = match.cfg.seed; // keep the same island, just swap in the live fighters
  active.forEach((f, i) => {
    cfg.fighters[i + 1] = { id: f.account, name: f.name, personality: f.personality, human: false, upgrades: { ...f.upgrades }, bounty: f.bounty };
  });
  buildMatch(cfg);
}

// ------------------------------------------------------------------ account / level
let myXp = localXp();
let loginTried = false;
async function refreshAccount() {
  const c = client;
  const t3 = isT3(c) && c.mode === "chain";
  const guest = !c || c.isGuest();
  // the sign-in entry is always offered to guests in chain mode (it explains itself if wallets aren't live yet)
  $("signin").classList.toggle("hidden", !c || c.mode !== "chain" || !guest);
  $("acct-chip").classList.toggle("hidden", !t3 || guest);
  // economy v2: sponsorship is legacy (exit only) — the chip shows only for players who still hold an old position
  $("nav-sponsor").classList.add("hidden");
  if (t3 && !guest) void c.mySponsorships().then((v) => $("nav-sponsor").classList.toggle("hidden", v.length === 0)).catch(() => undefined);
  const wel = $("welcome");
  wel.classList.add("hidden");
  if (t3 && !guest) {
    // daily login reward: claimed once per session on entering the game; silent unless it paid
    const daily = c as unknown as import("./net/api").GameClientDaily;
    if (!loginTried && daily.claimLogin) {
      loginTried = true;
      void daily.claimLogin().then((p) => { if (p > 0) { sfx.coin(4); toast(`+${fmt(p)} NOX daily login`); void refreshAccount(); } }, () => undefined);
    }
    { const id = await c.account().catch(() => ""); const el = $("acct-name"); el.textContent = id ? shortAcct(id) : ""; el.title = id; if (id) el.setAttribute("aria-label", id); }
    const b = await c.balance().catch(() => 0);
    $("acct-bal").textContent = `${fmt(b)} NOX`;
    // welcome credit: play-money that only pays match entries (never transferable)
    const credit = await c.welcomeCredit().catch(() => 0);
    wel.textContent = "";
    if (credit > 0) {
      wel.append(Object.assign(document.createElement("b"), { textContent: `Welcome credit ${fmt(credit)}` }), Object.assign(document.createElement("span"), { className: "wel-note", textContent: " play-money · pays your entry fees" }));
      wel.title = "Welcome credit: play-money that pays your match entry fees. It can't be withdrawn or transferred.";
      wel.classList.remove("hidden");
    } else if (!welcomeDone()) {
      const btn = document.createElement("button");
      btn.className = "btn-chip claim";
      btn.textContent = "Claim welcome credit";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const got = await c.claimWelcome();
          markWelcomeDone();
          sfx.heal();
          toast(`Welcome! ${fmt(got)} in entry credit — your next matches are on the house`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Couldn't claim the welcome credit";
          if (/already/i.test(msg)) markWelcomeDone();
          toast(msg);
        }
        await refreshAccount();
      });
      wel.appendChild(btn);
      wel.classList.remove("hidden");
    }
  }
  // the client is the source of truth for XP (chain for signed-in players and guests, its own store offline)
  if (isT3(c)) {
    const p = await c.progress().catch(() => null);
    myXp = p ? p.xp : myXp;
  } else myXp = localXp();
  levelBadge($("lv-badge"), myXp);
  levelBadge($("lv-chip"), myXp);
}
async function signIn() {
  const c = client;
  if (!isT3(c)) {
    toast("NEAR wallet sign-in opens with the next island update — until then you play as a guest (no tokens).");
    return;
  }
  const btn = $("signin") as HTMLButtonElement;
  btn.disabled = true;
  try {
    await c.signIn();
    sfx.chest();
    toast("Signed in — your matches now earn NOX");
  } catch {
    toast("Sign-in was cancelled");
  }
  btn.disabled = false;
  await refreshLobby();
}
const WELCOME_KEY = "bountyroyale.welcomed.v1";
const welcomeDone = () => {
  try {
    return localStorage.getItem(WELCOME_KEY) === "1";
  } catch {
    return false;
  }
};
const markWelcomeDone = () => {
  try {
    localStorage.setItem(WELCOME_KEY, "1");
  } catch {
    /* ignore */
  }
};
let toastT = 0;
function toast(text: string) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
  clearTimeout(toastT);
  toastT = window.setTimeout(() => el.classList.remove("show"), 3200);
}
const pages = new Pages({
  client: () => client,
  fighters: () => fighters,
  portrait: (f) => portraits[f.slot + 1] ?? "",
  refresh: refreshLobby,
  signIn,
  toast,
  sfx: (k) => (k === "coin" ? sfx.coin(3) : sfx.ui()),
});
// Challenge a friend + DAILY (docs/SOCIAL.md): own DOM, three hooks below (forcedStart / matchOver / endShown)
const social = new Social({
  getRecord: () => record,
  start: () => { if (!bootDone) wantPlay = true; else void startMatch(); }, // before the island is built: start when ready
  client: () => client,
  toast,
  sfx: (k) => { sfx.start(); if (k === "coin") sfx.coin(3); else sfx.ui(); },
  signIn,
});
$("signin").addEventListener("click", () => void signIn());
$("signout").addEventListener("click", async () => {
  if (isT3(client)) await client.signOut().catch(() => {});
  loginTried = false; // the next account to sign in gets its own daily login claim
  await refreshLobby();
});
$("nav-fighters").addEventListener("click", () => { sfx.start(); sfx.ui(); pages.fighters(); });
$("nav-board").addEventListener("click", () => { sfx.start(); sfx.ui(); pages.leaderboard(); });
$("nav-economy").addEventListener("click", () => { sfx.start(); sfx.ui(); pages.economy(); });
$("nav-sponsor").addEventListener("click", () => { sfx.start(); sfx.ui(); pages.sponsorships(); });
$("roster").addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>("[data-acct]");
  const f = li && fighters.find((x) => x.account === li.dataset.acct);
  if (f) { sfx.ui(); pages.profile(f); }
});
$("roster").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const li = (e.target as HTMLElement).closest<HTMLElement>("[data-acct]");
  const f = li && fighters.find((x) => x.account === li.dataset.acct);
  if (f) { e.preventDefault(); pages.profile(f); }
});

/** The local roster as lobby cards (no wallets: offline practice). */
function localFighters(): FighterInfo[] {
  return t1Roster()
    .slice(1)
    .map((f, i) => ({
      slot: i,
      account: f.id,
      name: f.name,
      personality: f.personality,
      balance: 0,
      upgrades: { ...f.upgrades },
      record: { matches: 0, wins: 0, kills: 0, deaths: 0, earnings: 0 },
      bounty: f.bounty,
      bountyValue: 0,
      generation: 0,
      status: "active" as const,
    }));
}

/** set by the TRAINING ISLAND buttons: the next match is offline with easy bots (cfg.training) */
let wantTraining = false;
let inTraining = false;
/** set by the BIG ISLAND button: the next match is offline on the big map (cfg.map = "big") */
let wantBig = false;
let inBig = false;

function localStart(): StartResult {
  const cfg: MatchConfig = { seed: localSeed(), fighters: t1Roster() };
  // offline fallback after a chain failure: tonight's real roster from the lobby, not the stale default one
  const cached = SEED_PARAM === null ? specsFromFighters(fighters.filter((f) => isChainAcct(f.account))) : null;
  if (cached) cfg.fighters = [cfg.fighters[0], ...cached];
  if (SEED_PARAM === null) cfg.fighters[0].upgrades = upgradesForLevel(levelProgress(myXp).level); // your level's gear (offline)
  if (BIG_PARAM) cfg.map = "big";
  const b = cfg.fighters.findIndex((f) => f.bounty);
  return { matchId: `local-${cfg.seed}`, cfg, pot: 0, bountyIdx: b >= 0 ? b : null, bountyValue: 0, playerPaid: 0, tx: null };
}

function buildMatch(cfg: MatchConfig, lazy = false) {
  if (world) world.dispose();
  for (const v of views) v.dispose();
  fx.clear();
  match = createMatch(cfg);
  world = new World(match, lazy);
  world.onBurst = (x, z, kind) => (kind === "chest" ? fx.chestBurst(x, z) : fx.healBurst(x, z));
  scene.add(world.group);
  water.uniforms.uR.value = world.radius;
  const tags = $("tags");
  const bv = current?.bountyValue ?? 0;
  views = match.state.fighters.map((f, i) => {
    const v = new FighterView(i, f, tags, cfg.fighters[i].upgrades.skin);
    // name tag over the head: the real NEAR account id (full on desktop), the name only offline
    const nm = v.tag.querySelector<HTMLElement>(".nm");
    if (nm && i > 0) nm.textContent = displayId(cfg.fighters[i].id, f.name);
    if (f.bounty) v.setBountyValue(bv);
    scene.add(v.root);
    return v;
  });
  recorder = new Recorder();
  record = null;
  killerOf.clear();
  watch = 0;
  meDeadAt = -1;
  endShown = false;
  spectating = false;
  acc = 0;
  const me = match.state.fighters[0];
  camTarget.set(me.x * U, 0, me.y * U);
  camLook.copy(camTarget);
}

async function startMatch() {
  if (starting) return;
  starting = true;
  endOpen = false;
  iClaimedBounty = false;
  if (!fighters.length && SEED_PARAM === null && !OFFLINE) await withTimeout(refreshLobby(), 4000);
  if (fighters.length) {
    saveSnap(fighters);
    prevSnap = loadSnap();
  }
  phase = "playing"; // the drop-in is part of the match flow (tick stays 0 until the island is built)
  sfx.start();
  sfx.ui();
  $("end").classList.add("hidden");
  // ?seed=N (tests, replays) always plays the local deterministic roster
  let start: StartResult | null = await social.forcedStart(); // challenge / daily: fixed config, no chain
  inTraining = false;
  if (start === null && wantTraining) {
    // training island: offline, easy bots against you, nothing recorded or settled
    start = localStart();
    start.cfg.training = true;
    inTraining = true;
    // rivalry: the bot you eliminated last time remembers you (decided before the match, never from its inputs)
    const r = rivalIdx(start.cfg);
    if (r !== null) start.cfg.rival = r;
  }
  wantTraining = false;
  inBig = false;
  if (start === null && wantBig && BIG_ISLAND_ENABLED) {
    // big island: offline (no stakes, never settled on chain), the bigger map with normal bots
    start = localStart();
    start.cfg.map = "big";
    inBig = true;
  }
  wantBig = false;
  const forced = start !== null;
  const c = start === null && SEED_PARAM === null && !OFFLINE ? await withTimeout(clientP, 3000) : null;
  // "chain_error" = a transient failure last time: the client tries the chain again (and says so if it still fails)
  const chainTry = !!c && (c.mode === "chain" || c.offlineReason === "chain_error");
  if (c && chainTry) {
    $("dropping").classList.remove("hidden");
    $("drop-sub").textContent = "sealing the match seed on NEAR…";
    start = await withTimeout(c.startMatch(), 50000); // includes one quiet retry after 1.5 s inside the client
  } else if (c) start = await withTimeout(c.startMatch(), 3000);
  const fellBack = chainTry && !forced && (!start || start.matchId.startsWith("local-"));
  current = start ?? localStart();
  $("dropping").classList.add("hidden");
  settleState = null;
  buildMatch(current.cfg);
  starting = false;
  phase = "playing";
  matchStartT = time;
  introT = INTRO;
  countShown = -1;
  myKillTimes = [];
  lastAmmo = -1;
  if (fellBack) toast("Couldn't reach the NEAR island — playing offline practice (not recorded)");
  if (inTraining) toast("Training island: the bots go easy on you. Nothing is recorded.");
  if (inBig) toast("Big Island: a 3x map, dense cover, a slow storm. Offline — nothing is staked.");
  coach.startMatch(!AUTOPLAY);
  gotChest = false;
  meBushSeen = false;
  const st = current;
  if (st.bountyIdx !== null && st.bountyValue > 0) hud.banner(`BOUNTY: ${fmt(st.bountyValue)} NOX ON ${displayId(current.cfg.fighters[st.bountyIdx].id, current.cfg.fighters[st.bountyIdx].name)}`, "gold");
  else hud.banner(inTraining ? "TRAINING ISLAND" : inBig ? "BIG ISLAND" : "READY…", "gold");
  $("title").classList.add("hidden");
  $("hud").classList.remove("hidden");
  $("pot-chip").classList.toggle("hidden", !(current.pot > 0));
  $("pot").textContent = fmt(current.pot);
  $("pot-chip").title = current.entries !== undefined ? `Pot: entries ${fmt(current.entries)} + House top-up ${fmt(Math.max(0, current.pot - current.entries))} = ${fmt(current.pot)} NOX, paid to the winner. ${PLAY_MONEY_NOTE}` : `Prize pot, paid to the winner. ${PLAY_MONEY_NOTE}`;
  hud.reset();
  controls.setEnabled(true);
  if (!AUTOPLAY) hud.showHints(touchy());
  canvas.focus();
}

function toLobby() {
  sfx.ui();
  coach.hide();
  menu?.forceClose();
  endOpen = false;
  phase = "title";
  $("end").classList.add("hidden");
  $("hud").classList.add("hidden");
  $("title").classList.remove("hidden");
  controls.setEnabled(false);
  for (const v of views) v.tag.style.transform = "translate(-9999px, 0px)";
  void refreshLobby();
  ($("play") as HTMLButtonElement).focus();
}

// ------------------------------------------------------------------ helpers
const _p = new THREE.Vector3();
const _scr = { x: 0, y: 0 };
function project(x: number, y: number, z: number) {
  _p.set(x, y, z).project(camera);
  if (_p.z > 1) return null;
  _scr.x = (_p.x * 0.5 + 0.5) * innerWidth;
  _scr.y = (-_p.y * 0.5 + 0.5) * innerHeight;
  return _scr;
}
function distVol(x: number, z: number) {
  const d = Math.hypot(x - camTarget.x, z - camTarget.z);
  return Math.max(0, 1 - d / 26);
}
function shake(a: number) {
  trauma = Math.min(1, trauma + a);
}
function nameOf(i: number | null) {
  if (i === null || !match) return null;
  return i === 0 ? "You" : displayId(match.cfg.fighters[i].id, match.state.fighters[i].name);
}

/** The bot's real chain sub-account (undefined offline and for the player). */
function acctOf(i: number | null): string | undefined {
  if (i === null || i === 0 || !match) return undefined;
  const a = match.cfg.fighters[i]?.id;
  return isChainAcct(a) ? a : undefined;
}

// ------------------------------------------------------------------ events
const _v3 = new THREE.Vector3();
/** true while the rest of a match is simulated instantly (the player left after dying): no sounds, banners or feed */
let silent = false;
/**
 * The player is out and leaves before the match ends: simulate the rest right now (bots only, deterministic,
 * the human input is idle), so a chain match still ends, records and settles instead of being abandoned.
 */
function finishInBackground() {
  if (!match || match.state.over || match.state.fighters[0].alive) return;
  silent = true;
  try {
    for (let n = 0; n < 20_000 && match && !match.state.over; n++) stepSim();
  } finally {
    silent = false;
  }
}

function onEvents(evs: SimEvent[]) {
  if (silent) return;
  if (!match) return;
  const st = match.state;
  for (const e of evs) {
    switch (e.t) {
      case "shot": {
        const v = views[e.who];
        v.shoot();
        const vis = e.who === 0 || canSeeNow(e.who);
        if (vis) {
          v.muzzle(_v3);
          fx.muzzle(_v3.x, _v3.y, _v3.z, e.weapon);
        }
        sfx.shot(e.weapon, e.who === 0 ? 1 : distVol(e.x * U, e.y * U) * 0.8);
        if (e.who === watch) shake(e.weapon === "shotgun" ? 0.18 : e.weapon === "sniper" ? 0.22 : 0.05);
        break;
      }
      case "hit": {
        const v = views[e.who];
        v.hit();
        const x = e.x * U, z = e.y * U;
        const storm = e.by < 0;
        const mine = e.by === 0, me = e.who === 0;
        if (storm) {
          fx.spark(x, z, PAL.stormHot);
          if (me || canSeeNow(e.who)) hud.floater(`-${Math.round(e.dmg)}`, v.pos.x, 3.1, v.pos.z, me ? "storm me" : "storm", e.who);
          if (me) { hud.hurtFlash(); shake(0.1); sfx.hurt(); }
          break;
        }
        fx.impact(x, 1.1, z, BOLT_COLOR[st.fighters[e.by]?.weapon ?? "popper"], e.crit);
        if (mine || me || canSeeNow(e.who)) hud.floater(String(Math.round(e.dmg)), v.pos.x, 3.1, v.pos.z, (e.crit ? "crit " : "") + (me ? "me" : ""), e.who);
        if (mine) {
          const p = project(v.pos.x, 1.2, v.pos.z);
          if (p) hud.hitMark(p.x, p.y, false);
        }
        if (me) {
          hud.hurtFlash();
          sfx.hurt();
          shake(0.28);
          const a = views[e.by];
          if (a) {
            // screen-space direction from me to the attacker
            const pm = project(v.pos.x, 1, v.pos.z);
            const mx = pm ? pm.x : innerWidth / 2, my = pm ? pm.y : innerHeight / 2;
            const pa = project(a.pos.x, 1, a.pos.z);
            if (pa) hud.damageDir(Math.atan2(pa.x - mx, -(pa.y - my)));
          }
        } else sfx.hit(e.crit, mine);
        break;
      }
      case "kill": {
        killerOf.set(e.who, e.by);
        const v = views[e.who];
        const f = st.fighters[e.who];
        v.die();
        fx.poof(v.pos.x, v.pos.z, v.color);
        sfx.poof(distVol(v.pos.x, v.pos.z));
        hud.feedItem(nameOf(e.by), nameOf(e.who)!, e.weapon, { me: e.by === 0 || e.who === 0, bounty: f.bounty, kAcct: acctOf(e.by), vAcct: acctOf(e.who) });
        if (e.by === 0) {
          rememberRival(st.fighters[e.who].name);
          sfx.kill(true);
          myKillTimes.push(time);
          const streak = myKillTimes.filter((t) => time - t < 5).length;
          const tag = streak >= 3 ? "TRIPLE! " : streak === 2 ? "DOUBLE! " : "";
          hud.banner(`${tag}ELIMINATED ${nameOf(e.who)!}`, streak >= 2 ? "gold" : "hot");
          const p = project(v.pos.x, 1.2, v.pos.z);
          if (p) hud.hitMark(p.x, p.y, true);
          slow(0.35, 0.5);
          shake(0.3);
        } else if (e.who !== 0) sfx.kill(false);
        if (e.who === 0) {
          meDeadAt = time;
          sfx.defeat();
          shake(0.6);
          slow(0.3, 0.8);
          hud.whiteFlash(0.35);
        }
        if (e.who === watch) {
          const k = e.by;
          setTimeout(() => {
            if (!match) return;
            watch = k !== null && st.fighters[k].alive ? k : nearestAlive(v.pos.x, v.pos.z);
          }, 1200);
        }
        break;
      }
      case "bounty": {
        if (e.by === 0) iClaimedBounty = true;
        const val = current && current.bountyValue > 0 ? `THE ${fmt(current.bountyValue)} NOX BOUNTY` : "THE BOUNTY";
        hud.banner(`${nameOf(e.by)!} CLAIMED ${val} ON ${nameOf(e.who)!}!`, "gold");
        {
          const bvNow = current?.bountyValue ?? 0;
          // only a wallet-paid player really collects; guests and offline runs earn 0 (say so, never fake a payout)
          const paid = !!current && current.playerPaid > 0 && !inTraining;
          const line = e.by === 0
            ? bvNow > 0 && paid ? `You took ${nameOf(e.who)}'s bounty: +${fmt(bvNow)} NOX` : `You took ${nameOf(e.who)}'s bounty${bvNow > 0 ? ` (${fmt(bvNow)} NOX — sign in and pay an entry to collect)` : ""}`
            : `${nameOf(e.by)} took ${nameOf(e.who)}'s bounty${bvNow > 0 ? `: +${fmt(bvNow)} NOX` : ""}`;
          hud.feedLine(line, e.by === 0);
        }
        if (e.by === 0) sfx.bounty();
        else sfx.chest();
        break;
      }
      case "chest":
        if (e.who === 0) {
          gotChest = true;
          coach.hide();
          hud.popup(`${WEAPON_LABEL[e.weapon]}!`);
          sfx.chest();
          shake(0.12);
        } else if (distVol(st.chests[e.chest]?.x * U, st.chests[e.chest]?.y * U) > 0.2) sfx.pickup();
        break;
      case "heal": {
        const v = views[e.who];
        if (e.who === 0) {
          hud.popup(`+${Math.round(e.amount)} HP`, "heal");
          sfx.heal();
        }
        if (e.who === 0 || canSeeNow(e.who)) hud.floater(`+${Math.round(e.amount)}`, v.pos.x, 3.1, v.pos.z, "heal");
        break;
      }
      case "explode": {
        const x = e.x * U, z = e.y * U;
        fx.explode(x, z, Math.max(1, e.r * U));
        const vol = distVol(x, z);
        sfx.explode(vol);
        shake(0.55 * vol + 0.05);
        break;
      }
      case "storm":
        hud.banner("THE STORM IS CLOSING IN", "storm");
        sfx.stormWarn();
        break;
      case "win": {
        if (e.who === 0) sfx.victory();
        slow(0.3, 1.0);
        const v = views[e.who];
        v.celebrate();
        fx.confetti(v.pos.x, v.pos.z);
        watch = e.who;
        break;
      }
    }
  }
}

function canSeeNow(i: number) {
  if (!match) return true;
  if (!match.state.fighters[0].alive) return true;
  return i === 0 || match.canSee(0, i);
}
function nearestAlive(x: number, z: number) {
  if (!match) return 0;
  let best = 0, bd = Infinity;
  for (const f of match.state.fighters) {
    if (!f.alive) continue;
    const d = (f.x * U - x) ** 2 + (f.y * U - z) ** 2;
    if (d < bd) { bd = d; best = f.idx; }
  }
  return best;
}
function slow(scale: number, dur: number) {
  timeScale = scale;
  slowT = dur;
}

// ------------------------------------------------------------------ simulation step
function stepSim() {
  if (!match || match.state.over) return;
  const st = match.state;
  const me = st.fighters[0];
  if (AUTOPLAY) {
    const b = botInput(match, 0);
    humanInput.mx = b.mx; humanInput.my = b.my; humanInput.aim = b.aim; humanInput.fire = b.fire;
  } else if (me.alive && controls.enabled) {
    const rangeW = WEAPONS[me.weapon].range / 1000;
    controls.touchRange = rangeW;
    // coaching only: visible enemies within weapon range (never ones hidden in bushes)
    let inRange = 0;
    let nearVisible = Infinity;
    for (const f of st.fighters) {
      if (f.idx === 0 || !f.alive || !match.canSee(0, f.idx)) continue;
      const tx = f.x * U, tz = f.y * U;
      const d = Math.hypot(tx - views[0].pos.x, tz - views[0].pos.z);
      if (d < nearVisible) nearVisible = d;
      if (d <= rangeW) inRange++;
    }
    controls.read(views[0].pos.x, views[0].pos.z, humanInput);
    // first-match coaching (HUD only): firing with nothing to hit
    if (coach.active && humanInput.fire && inRange === 0 && st.tick > SPAWN_PROTECT) {
      if (nearVisible < Infinity) coach.cue("range", "Out of range — move closer to shoot", time, { gapMs: 4000 });
      else coach.cue("notarget", "No target in range", time, { gapMs: 4000 });
    }
  } else {
    humanInput.mx = 0; humanInput.my = 0; humanInput.fire = false;
  }
  recorder.push(st.tick, 0, humanInput);
  inputs.set(0, humanInput);
  for (const v of views) { v.prev.copy(v.cur); v.prevAim = v.curAim; }
  const evs = match.step(inputs);
  for (const f of st.fighters) {
    const v = views[f.idx];
    v.cur.set(f.x * U, f.y * U);
    v.curAim = f.aim;
  }
  fx.syncProjectiles(st.projectiles);
  onEvents(evs);
  if (st.over && !record) {
    record = {
      version: 1,
      cfg: match.cfg,
      inputs: recorder.inputs,
      hash: match.hash(),
      winner: st.winner,
      placements: st.fighters.map((f) => f.placement),
    };
    phase = "over";
    {
      const me = st.fighters[0];
      // training island: no rewards of any kind (no XP either)
      const gained = inTraining ? 0 : xpForMatch(me.placement || 1, me.kills, iClaimedBounty);
      xpBefore = myXp;
      xpAfter = myXp + gained;
      myXp = xpAfter;
      if (!isT3(client)) setLocalXp(xpAfter); // with a T3 client, progress() is refreshed after settle
    }
    const rec = record;
    const cur = current;
    social.matchOver(rec);
    if (client && cur && !cur.matchId.startsWith("local-")) {
      settleState = "pending";
      client
        .settle(cur.matchId, rec)
        .then((r) => {
          if (current !== cur) return;
          settleState = r;
          if (r.verified) lastSettleLines = settleLines(r);
          void refreshAccount();
          if (endShown) drawLedger();
          void refreshLobby();
        })
        .catch(() => {
          settleState = null;
          if (endShown) drawLedger();
        });
    }
    setTimeout(() => showEnd(true), 1400);
  }
}

// ------------------------------------------------------------------ end / death card
let endGuardUntil = 0;
let endOpen = false;
function drawLedger() {
  if (!match) return;
  const st = match.state;
  const el = $("ledger");
  if (!st.over) {
    el.textContent = "";
    const n = document.createElement("p");
    n.className = "lg-note";
    n.textContent = inTraining ? `${st.alive} still fighting — training island: nothing is paid or recorded. Spectate to watch it end.` : `${st.alive} still fighting — the pot and the bounty are paid out when the last one stands. Spectate to watch it end.`;
    el.appendChild(n);
    return;
  }
  renderLedger(el, {
    names: st.fighters.map((f) => (f.idx === 0 ? "You" : displayId(match!.cfg.fighters[f.idx].id, f.name))),
    accounts: match.cfg.fighters.map((f) => f.id),
    placements: st.fighters.map((f) => f.placement),
    kills: st.fighters.map((f) => f.kills),
    winner: st.winner,
    start: current,
    settle: settleState,
    chain: !!client && client.mode === "chain",
    guest: !!client && client.mode === "chain" && client.isGuest(),
    portraits,
    explorerTx: (h) => client?.explorerTx(h) ?? "#",
    explorerAccount: (a) => client?.explorerAccount(a) ?? "#",
    onSignIn: () => void signIn().then(() => drawLedger()),
    onCoin: (i) => sfx.coin(i),
  });
}

function showEnd(force: boolean) {
  if (!match) return;
  const st = match.state;
  const me = st.fighters[0];
  if (!force && endShown) return;
  if (phase === "title") return;
  endShown = true;
  spectating = false;
  coach.hide();
  const el = $("end");
  const won = st.winner === 0;
  const place = me.placement || (me.alive ? 1 : FIGHTERS);
  el.classList.toggle("win", won);
  $("end-place").textContent = `#${place}`;
  $("end-title").textContent = won ? "LAST ONE STANDING" : "ELIMINATED";
  const killer = killerOf.get(0);
  const how = won ? "the island is yours" : killer != null ? `taken out by ${nameOf(killer)}` : killerOf.has(0) ? "lost to the storm" : "";
  const winnerLine = st.over ? (st.winner === null ? "no winner" : won ? "" : `${nameOf(st.winner)} won`) : `${st.alive} still fighting`;
  $("end-sub").textContent = [`of ${FIGHTERS}`, how, winnerLine].filter(Boolean).join(" — ");
  $("end-kills").textContent = String(me.kills);
  // a fast early exit in a real match: offer the training island
  const fast = !won && !inTraining && me.placement >= 7 && (match.state.tick < 70 * 20 || me.kills === 0);
  $("again-training").classList.toggle("hidden", !fast && !inTraining);
  // after training: the main button is a real match; the secondary one trains again
  $("again").textContent = inTraining ? "PLAY REAL MATCH" : inBig ? "BIG ISLAND AGAIN" : "PLAY AGAIN";
  $("again-training").textContent = inTraining ? "TRAIN AGAIN" : "TRY THE TRAINING ISLAND";
  $("end-dmg").textContent = String(Math.round(me.damageDealt));
  const surv = Math.round((me.alive ? st.tick : lastTickAlive) / TICK_HZ);
  $("end-time").textContent = `${Math.floor(surv / 60)}:${String(surv % 60).padStart(2, "0")}`;
  $("spectate").classList.toggle("hidden", st.over);
  $("to-lobby").classList.remove("hidden"); // MAIN MENU is always a way out (an unfinished match is finished in the background)
  social.endShown(st.over);
  drawLedger();
  const xb = $("xp-box");
  xb.classList.toggle("hidden", !st.over || inTraining || (SEED_PARAM !== null && AUTOPLAY));
  if (st.over) {
    renderXp(xb, xpBefore, xpAfter, (lvl, unlocks) => {
      sfx.levelUp();
      const lu = $("levelup");
      lu.textContent = `LEVEL ${lvl}!`;
      lu.classList.remove("show");
      void lu.offsetWidth;
      lu.classList.add("show");
      if (unlocks.length) toast(`Unlocked: ${unlocks[0]}`);
    });
    levelBadge($("lv-badge"), xpAfter);
    levelBadge($("lv-chip"), xpAfter);
  }
  $("hud").classList.add("hidden");
  el.classList.remove("hidden");
  endOpen = true;
  el.scrollTop = 0;
  controls.setEnabled(false);
  // a held trigger / stray click must not hit a button that just appeared under the cursor
  endGuardUntil = performance.now() + 700;
  ($("again") as HTMLButtonElement).focus({ preventScroll: true });
}
let lastTickAlive = 0;
const guarded = (fn: () => void) => (e: Event) => {
  if (performance.now() < endGuardUntil && (e as MouseEvent).detail > 0) return; // ignore pointer clicks, allow keyboard
  fn();
};

$("again").addEventListener("click", guarded(() => {
  if (inBig) wantBig = true; // big island: "again" stays on the big map
  finishInBackground(); // the previous match still ends and settles
  void startMatch();
}));
const toMainMenu = () => {
  spectating = false;
  $("spec").classList.add("hidden");
  finishInBackground();
  toLobby();
};
$("to-lobby").addEventListener("click", guarded(toMainMenu));
$("spec-menu").addEventListener("click", toMainMenu);
$("spectate").addEventListener("click", guarded(() => {
  sfx.ui();
  spectating = true;
  endOpen = false;
  $("end").classList.add("hidden");
  $("hud").classList.remove("hidden");
}));
$("spec-exit").addEventListener("click", () => showEnd(true));
addEventListener("keydown", (e) => {
  if (e.code === "Escape" && spectating && match) showEnd(true);
});
let bootDone = false;
let wantPlay = (window as unknown as { __brWantPlay?: boolean }).__brWantPlay === true;
/** Free guest spots used up (the relayer's small guest budget or today's cap) and no NEAR account: PLAY falls back to the free Training Island. */
const guestsClosed = () => !!client && client.mode !== "chain" && client.offlineReason === "guests_closed";
$("play").addEventListener("click", () => {
  if (!bootDone) {
    wantPlay = true; // pressed while loading: start as soon as the island is ready
    return;
  }
  if (guestsClosed()) {
    toast("Today's free guest spots are taken — enjoy the free Training Island, or sign in with NEAR to play for real");
    startTraining();
    return;
  }
  void startMatch();
});
const startTraining = () => {
  wantTraining = true;
  if (!bootDone) {
    wantPlay = true;
    return;
  }
  void startMatch();
};
$("training").addEventListener("click", startTraining);
const openAbout = () => {
  sfx.start();
  sfx.ui();
  pages.about();
};
$("nav-about").addEventListener("click", openAbout);
if (new URLSearchParams(location.search).has("about")) setTimeout(openAbout, 400);
{
  // BIG ISLAND entry (its own element in index.html); behind BIG_ISLAND_ENABLED (else a "coming soon" badge)
  const bigBtn = $("big-island") as HTMLButtonElement;
  if (!BIG_ISLAND_ENABLED) {
    bigBtn.setAttribute("aria-disabled", "true");
    bigBtn.classList.add("soon");
    bigBtn.querySelector("small")!.textContent = "coming soon";
  } else
    bigBtn.addEventListener("click", () => {
      wantBig = true;
      if (!bootDone) {
        wantPlay = true;
        return;
      }
      void startMatch();
    });
}
$("again-training").addEventListener("click", () => {
  $("end").classList.add("hidden");
  startTraining();
});
const muteBtn = $("mute");
let menuPaused = false;
const menu = new PauseMenu({
  canOpen: () => phase === "playing" && !!match && !match.state.over && !spectating && !endOpen && !starting && !AUTOPLAY && $("page").classList.contains("hidden"),
  offline: () => !client || client.mode !== "chain" || !!current?.matchId.startsWith("local-"),
  training: () => inTraining,
  muted: () => sfx.muted,
  toggleMute: () => toggleMute(),
  exit: () => {
    const chain = !current?.matchId.startsWith("local-") && !!client && client.mode === "chain";
    toLobby();
    toast(chain ? "You left — the match counts as a loss" : inTraining ? "You left the training island" : inBig ? "You left Big Island" : "You left the practice match"); // chain match: left unsettled (the contract's abandon/expiry rules handle it)
  },
  onChange: (open) => {
    controls.blocked = open;
    menuPaused = open && (!client || client.mode !== "chain" || !!current?.matchId.startsWith("local-"));
  },
  sfx: () => sfx.ui(),
});
menu.mount($("app"), $("hud"));
const MUTE_KEY = "noxara.muted";
function showMute(m: boolean) {
  for (const b of [muteBtn, $("title-mute")]) {
    b.classList.toggle("muted", m);
    b.setAttribute("aria-pressed", String(m));
  }
}
function toggleMute() {
  const m = sfx.toggleMute();
  showMute(m);
  try {
    localStorage.setItem(MUTE_KEY, m ? "1" : "0");
  } catch {
    /* storage blocked: mute lasts for this visit */
  }
}
try {
  if (localStorage.getItem(MUTE_KEY) === "1") sfx.toggleMute();
} catch {
  /* storage blocked */
}
showMute(sfx.muted);
muteBtn.addEventListener("click", toggleMute);
$("title-mute").addEventListener("click", (ev) => {
  ev.stopPropagation();
  toggleMute();
});
// the title theme: once per visit, on the first tap/click/key on the title screen (no autoplay)
const themeOnce = () => {
  if (phase !== "title") return;
  removeEventListener("pointerdown", themeOnce, true);
  removeEventListener("keydown", themeOnce, true);
  sfx.start();
  setTimeout(() => sfx.theme(), 60);
};
addEventListener("pointerdown", themeOnce, true);
addEventListener("keydown", themeOnce, true);
controls.onMute = toggleMute;

// ------------------------------------------------------------------ frame loop
let last = performance.now();
const fpsBuf = new Float32Array(60);
let fpsI = 0;
let fpsVal = 0;
let miniT = 0;
const shakeOff = new THREE.Vector3();
const visibleNow = (i: number) => canSeeNow(i);
const rustlers: THREE.Vector3[] = [];
const meBush = { x: 0, z: 0, inBush: false };

let cpuMs = 0, gpuMs = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  const t0 = performance.now();
  let rdt = (now - last) / 1000;
  last = now;
  if (rdt > 0.25) rdt = 0.25;
  fpsBuf[fpsI++ % 60] = rdt;
  const rawDt = rdt;
  if (menuPaused) rdt = 0; // offline practice: the menu really pauses the game
  if (fpsI % 15 === 0) {
    let s = 0;
    const n = Math.min(fpsI, 60);
    for (let i = 0; i < n; i++) s += fpsBuf[i];
    fpsVal = n / Math.max(1e-6, s);
  }
  if (slowT > 0) {
    slowT -= rdt;
    if (slowT <= 0) timeScale = 1;
  }
  const dt = rdt * timeScale;
  time += rdt;
  autoQuality(rawDt);

  if (introT > 0) {
    introT -= rdt;
    if (introT <= 0) matchStartT = time;
  }
  if (match && (phase === "playing" || phase === "over") && introT <= 0 && !starting) {
    acc += dt * SPEED;
    let n = 0;
    while (acc >= DT && n < 8 * SPEED) {
      stepSim();
      acc -= DT;
      n++;
    }
    if (n >= 8 * SPEED) acc = 0;
  }
  const alpha = Math.min(1, acc / DT);

  if (match && world) {
    const st = match.state;
    const me = st.fighters[0];
    if (me.alive) lastTickAlive = st.tick;
    if (me.alive && phase === "playing") {
      if (lastAmmo === 0 && me.ammo > 0) sfx.reload();
      lastAmmo = me.ammo;
    }
    if (meDeadAt >= 0 && !endShown && time - meDeadAt > 1.8 && !AUTOPLAY) showEnd(false);

    // spawn protection: shield bubbles + 3-2-1-GO aligned with the sim's SPAWN_PROTECT window
    const prot = st.tick <= SPAWN_PROTECT && phase === "playing" && !starting;
    if (phase === "playing" && !starting && introT <= 0) {
      const n = st.tick > SPAWN_PROTECT ? 0 : Math.max(1, Math.ceil((SPAWN_PROTECT - st.tick + 1) / TICK_HZ));
      if (n !== countShown) {
        if (countShown !== -1 || n > 0) {
          if (n > 0) { hud.popup(String(n), "count"); sfx.countTick(false); }
          else if (countShown > 0) {
            hud.popup("GO!");
            sfx.countTick(true);
            const r = match.cfg.rival;
            if (r !== undefined && st.fighters[r]) setTimeout(() => hud.banner(`${nameOf(r)} REMEMBERS YOU`, "hot"), 900);
          }
        }
        countShown = n;
      }
    }
    // "this is you": arrow + label for the first 10 s of the match
    views[0].setYouMarker(phase === "playing" && !starting && introT <= 0 && time - matchStartT < 10);
    if (coach.active && phase === "playing" && !starting && introT <= 0 && me.alive && !menuPaused) {
      if (me.inBush) meBushSeen = true;
      const secs = Math.max(0, st.tick - SPAWN_PROTECT) / TICK_HZ;
      if (!gotChest && st.tick > SPAWN_PROTECT && secs < 14) coach.cue("loot", "Grab a weapon from a gold beam", time, { ms: 6000, max: 1 });
      else if (!meBushSeen && secs > 22) coach.cueOnce("bush", "Hide in a bush to ambush — enemies can't see you until they're close", time);
    }
    // fighters
    const mobileHud = innerWidth <= 720 || controls.touchMode;
    const hudTop = mobileHud ? 140 : 92;
    const hudBottom = mobileHud ? 70 : 96;
    rustlers.length = 0;
    for (const f of st.fighters) {
      const v = views[f.idx];
      v.update(dt, alpha, f, st.tick);
      v.setShield(prot && f.alive, time);
      const vis = f.idx === 0 || !f.alive || canSeeNow(f.idx) || v.dead;
      v.root.visible = vis && !(v.dead && v.deadT > 1.9);
      if (!vis && f.alive && v.speed > 0.5) rustlers.push(v.pos);
      // footstep dust
      if (vis && f.alive && v.speed > 1.5) {
        v.dustT -= dt;
        if (v.dustT <= 0) { fx.dust(v.pos.x, v.pos.z); v.dustT = v.speed > 5 ? 0.16 : 0.26; }
      }
      // name tag
      const showTag = vis && f.alive && phase !== "title" && !starting && !endOpen;
      const p = showTag ? project(v.pos.x, f.bounty ? 3.3 : 2.5, v.pos.z) : null;
      // never draw a tag over the HUD bands (top chips, bottom panels, minimap corner)
      if (p && (p.y < hudTop || p.y > innerHeight - hudBottom || (p.x > innerWidth - 190 && (mobileHud ? p.y < 130 : p.y > innerHeight - 200)))) {
        if (v.tag.style.transform !== "translate(-9999px, 0px)") v.tag.style.transform = "translate(-9999px, 0px)";
      } else if (p) v.tag.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
      else if (v.tag.style.transform !== "translate(-9999px, 0px)") v.tag.style.transform = "translate(-9999px, 0px)";
    }
    // off-screen bounty marker
    updateBountyArrow(st.fighters.find((f) => f.bounty && f.alive && f.idx !== watch) ?? null);
    // local player in bush: semi-transparent self too
    meBush.x = views[0].pos.x; meBush.z = views[0].pos.z; meBush.inBush = me.inBush;
    world.update(dt, time, me.alive ? meBush : null, rustlers);

    // storm effects for the local player
    const dx = me.x - st.storm.cx, dy = me.y - st.storm.cy;
    const outside = me.alive && phase === "playing" && dx * dx + dy * dy > st.storm.r * st.storm.r;
    safeArrow.visible = outside && watch === 0;
    if (safeArrow.visible) {
      const ax = st.storm.cx * U - views[0].pos.x, az = st.storm.cy * U - views[0].pos.z;
      const yaw = Math.atan2(-ax, -az);
      safeArrow.rotation.y = yaw;
      const k = 2.2 + Math.sin(time * 8) * 0.25;
      const l = Math.hypot(ax, az) || 1;
      safeArrow.position.set(views[0].pos.x + (ax / l) * k, 0.2, views[0].pos.z + (az / l) * k);
      (safeArrow.material as THREE.MeshBasicMaterial).opacity = 0.65 + Math.sin(time * 8) * 0.3;
    }
    if (outside) {
      stormTickT -= dt;
      if (stormTickT <= 0) { sfx.stormTick(); stormTickT = 1; shake(0.06); }
    } else stormTickT = 0;

    // camera target
    const w = views[watch];
    const lookAhead = 2.4;
    let tx = w.pos.x, tz = w.pos.z;
    if (watch === 0 && me.alive) {
      const a = (w.curAim / 4096) * Math.PI * 2;
      tx += Math.cos(a) * lookAhead;
      tz += Math.sin(a) * lookAhead * 0.8;
    }
    const k = 1 - Math.exp(-rdt * 6);
    camTarget.x += (tx - camTarget.x) * k;
    camTarget.z += (tz - camTarget.z) * k;

    if (phase !== "title" && !starting) {
      hud.update(match, me, st.fighters[watch]);
      {
        const pv = controls.preview;
        const show = phase === "playing" && me.alive && controls.enabled && !controls.blocked && pv.active && !AUTOPLAY && introT <= 0;
        aimLine.update(show, views[0].pos.x, views[0].pos.z, pv.ang, pv.dist, me.weapon, rdt);
      }
      hud.updateHints(controls.used, time - matchStartT, touchy());
      miniT -= rdt;
      if (miniT <= 0) { hud.minimap(match, 0, visibleNow); miniT = 0.05; }
    }
  }

  // camera placement
  const portrait = camera.aspect < 1;
  let dist = CAM_DIST || (portrait ? 25 * Math.pow(1 / camera.aspect, 0.5) * 1.3 : 25);
  if (introT > 0) {
    const k = introT / INTRO;
    dist *= 1 + k * k * 1.8;
  }
  if (phase === "title" || starting) {
    const a = time * 0.06;
    dist = portrait ? 58 * Math.pow(1 / camera.aspect, 0.5) : 58;
    camTarget.set(Math.cos(a) * 4, 0, Math.sin(a) * 4);
    camera.position.set(Math.sin(a) * dist * 0.6, dist * 0.55, Math.cos(a) * dist * 0.6);
    camera.lookAt(0, -2, 0);
  } else {
    trauma = Math.max(0, trauma - rdt * 1.5);
    const s = trauma * trauma * 0.9;
    shakeOff.set(Math.sin(time * 47.3) * s, Math.sin(time * 39.1 + 1.3) * s * 0.6, Math.cos(time * 43.7) * s);
    camLook.copy(camTarget);
    camera.position.set(camTarget.x + shakeOff.x, Math.sin(PITCH) * dist + shakeOff.y, camTarget.z + Math.cos(PITCH) * dist + shakeOff.z);
    camera.lookAt(camLook.x + shakeOff.x * 0.5, 0, camLook.z + shakeOff.z * 0.5);
  }
  const fog = scene.fog as THREE.Fog;
  fog.near = Math.max(48, dist + 14);
  fog.far = fog.near + 70;
  sun.position.set(camTarget.x + 22, 17, camTarget.z + 12); // low dusk key light, long shadows
  sun.target.position.set(camTarget.x, 0, camTarget.z);

  water.uniforms.uTime.value = time;
  fx.update(dt, alpha, time);
  hud.updateFloaters(rdt, project);
  const t1 = performance.now();
  if (sceneReady) renderer.render(scene, camera);
  const t2 = performance.now();
  cpuMs += (t1 - t0 - cpuMs) * 0.05;
  gpuMs += (t2 - t1 - gpuMs) * 0.05;
}

const bountyEl = $("bounty-arrow");
const bountyTip = bountyEl.querySelector<HTMLElement>(".tip")!;
let bountyShown = false;
function updateBountyArrow(f: { idx: number } | null) {
  let show = false;
  if (f && phase === "playing") {
    const v = views[f.idx];
    _p.set(v.pos.x, 1, v.pos.z).project(camera);
    const off = _p.z > 1 || Math.abs(_p.x) > 0.95 || Math.abs(_p.y) > 0.92;
    if (off) {
      show = true;
      let x = _p.x, y = _p.y;
      if (_p.z > 1) { x = -x; y = -y; }
      const W = innerWidth, H = innerHeight, mob = W < 720;
      const cx = W / 2, cy = H / 2;
      const dx = x * cx, dy = -y * cy;
      const left = 34, right = W - (mob ? 34 : 34), top = mob ? 150 : 80, bot = H - (mob ? 240 : 110);
      let t = 1e9;
      if (dx > 0) t = Math.min(t, (right - cx) / dx);
      if (dx < 0) t = Math.min(t, (left - cx) / dx);
      if (dy > 0) t = Math.min(t, (bot - cy) / dy);
      if (dy < 0) t = Math.min(t, (top - cy) / dy);
      const sx = cx + dx * t, sy = cy + dy * t;
      bountyEl.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
      const ang = Math.atan2(x, y);
      bountyTip.style.transform = `translate(-50%, -100%) rotate(${ang.toFixed(3)}rad) translateY(-22px)`;
    }
  }
  if (show !== bountyShown) {
    bountyShown = show;
    bountyEl.classList.toggle("hidden", !show);
  }
}

// ------------------------------------------------------------------ boot
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
let sceneReady = false;
const mark = (n: string) => performance.mark(`br:${n}`);
async function boot() {
  mark("boot");
  lobbySkeleton($("roster"));
  void clientP.then(() => refreshLobby());
  const fill = $("loadfill");
  await loadAll((p) => (fill.style.width = `${Math.round(p * 100)}%`));
  mark("assets");
  await nextFrame();
  buildMatch(localStart().cfg, true);
  await nextFrame();
  await world?.finish();
  mark("world");
  await nextFrame();
  // compile shaders without blocking the main thread (KHR_parallel_shader_compile when available)
  if (renderer.extensions.has("KHR_parallel_shader_compile")) await renderer.compileAsync(scene, camera).catch(() => undefined);
  else renderer.compile(scene, camera);
  sceneReady = true;
  mark("compiled");
  await nextFrame();
  const play = $("play") as HTMLButtonElement;
  delete play.dataset.loading;
  play.textContent = "PLAY";
  $("loadfill").parentElement!.classList.add("done");
  bootDone = true;
  mark("ready");
  wantPlay ||= (window as unknown as { __brWantPlay?: boolean }).__brWantPlay === true;
  if (SKIP_TITLE || AUTOPLAY || wantPlay) void startMatch();
  // (no autofocus: Tab from the top of the page reaches PLAY first)
  // after first paint: HUD icons and portraits, one small chunk per frame
  hud.icons = await makeWeaponIcons(renderer);
  await nextFrame();
  portraits = await makePortraits(renderer);
  hud.portraits = portraits;
  if (fighters.length) {
    renderLobby($("roster"), fighters, portraits, prevSnap);
    fillSparks($("roster"), sparks);
    if (client) void loadSparks(client); // the first lobby render can come before the portraits: load the sparklines here too
  }
  rebuildPreview();
  await nextFrame();
  skinPortraits = await makePortraits(renderer, HUMAN_SKIN_IDS.map((id) => charFor(0, id)));
}

if (E2E) {
  (window as unknown as { __br: unknown }).__br = {
    phase: () => phase,
    tick: () => match?.state.tick ?? 0,
    alive: () => match?.state.alive ?? FIGHTERS,
    placement: () => {
      if (!match) return null;
      const p = match.state.fighters[0].placement;
      return p > 0 ? p : null;
    },
    fps: () => Math.round(fpsVal * 10) / 10,
    record: () => record,
    /** debug only: the live match object */
    match: () => match,
    /** debug only: draw calls / triangles of the last frame + auto-quality level */
    gl: () => ({ ...renderer.info.render, quality, updateMs: +cpuMs.toFixed(2), renderMs: +gpuMs.toFixed(2) }),
    tris: () => {
      const out: Record<string, number> = {};
      scene.traverseVisible((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.geometry) return;
        const g = m.geometry;
        const n = (g.index ? g.index.count : g.attributes.position.count) / 3;
        const k = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
        const key = (m.parent?.name || m.name || m.type).slice(0, 24) + (m.castShadow ? "*" : "");
        out[key] = (out[key] ?? 0) + Math.round(n * k);
      });
      return Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 15);
    },
  };
}

requestAnimationFrame(frame);
boot().catch((err) => {
  console.error(err);
  const play = $("play") as HTMLButtonElement;
  play.textContent = "FAILED TO LOAD";
});

