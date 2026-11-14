// Deterministic bot brain (agent B). Same match state + same per-bot memory -> same Input.
// Uses only match.state, match.map, match.canSee and a per-bot Rng derived from cfg.seed.
// Per-bot memory lives in a WeakMap keyed by the Match, so each match starts fresh.
// NOTE: call botInput(match, idx) only for fighters you actually drive (the sim calls it for every
// non-human fighter; the client may call it for idx 0 in ?autoplay). Extra calls for a bot idx would
// advance that bot's memory/Rng and break determinism.
//
// Design: every tick the bot (1) picks a target among enemies it can see, (2) picks a movement goal by
// priority/utility (storm > heal/flee > fight > chest > camp > roam), (3) steers around obstacles by
// sampling 16 directions, (4) aims with lead + skill jitter and fires when aimed, in range and with a
// clear line. Personalities change thresholds, ranges, aim skill and goals.
// Fairness: enemies count only if canSee() (bushes), within vision (10–15 u) and noticed (view cone
// ±88°, heard shooting, or alerted by damage). Bots fire in bursts, lead imperfectly, dodge some
// bullets/grenades, disengage when losing and regen in bushes, and shoot back while retreating.
// Personalities: aggressive (early fights, chases, short range, better aim), camper (holds a bush
// near the next safe zone, ambushes), sniper (hunts a sniper, long preferred range, wide vision),
// looter (opens chests until ~55 s, avoids early fights), coward (avoids fights unless cornered,
// moves into the next circle early, hides), balanced.
// Pacing: an opening phase (GRACE, 32 s) where bots loot/rotate and only fight back; afterwards
// non-aggressive bots pick only favourable fights, roam at a walk and lurk in bushes. Storm
// discipline is imperfect on purpose (per-bot reaction delay, keep fighting in a weak storm, flee
// through it) — that is where storm deaths come from. An idle, never-shooting human is ignored for
// the first 10 s (onboarding). Bots lob grenades with aimDist = predicted target distance.
import type { FighterState, Input, Match, Obstacle, Personality } from "./types";
import { FP, Rng, angDiff, dist2, iatan2, icos, isin, isqrt, mixSeed } from "./fixed";
import { BULLET_R, FIGHTER_R, SPAWN_PROTECT, SPEED, WEAPONS, isBig, stormPhasesFor, type StormX } from "./rules";
import { obstaclesNear } from "./grid";
import { segHit } from "./geom";

interface Params {
  /** engage when target within weapon range × engage */
  engage: number; // ×100
  /** preferred fighting distance, × weapon range */
  pref: number; // ×100
  /** hp under which the bot heals / flees */
  lowHp: number;
  /** aim error amplitude (angle units) */
  jitter: number;
  /** reaction ticks before the first shot at a new target */
  react: number;
  /** vision range (FP) */
  vision: number;
  /** avoids fights unless provoked/cornered */
  passive: boolean;
  /** sits in bushes once armed */
  camp: boolean;
  /** keeps opening chests until this tick even when armed */
  lootUntil: number;
}

/** vision ranges (u): short / normal (the sniper personality uses 15 u; +3 u while holding a sniper) */
const V1 = 9, V2 = 10;
export const PERSONALITY: Record<Personality, Params> = {
  aggressive: { engage: 140, pref: 45, lowHp: 40, jitter: 100, react: 6, vision: V2 * FP, passive: false, camp: false, lootUntil: 0 },
  camper: { engage: 100, pref: 70, lowHp: 55, jitter: 125, react: 10, vision: V1 * FP, passive: false, camp: true, lootUntil: 0 },
  sniper: { engage: 105, pref: 80, lowHp: 55, jitter: 85, react: 12, vision: 13 * FP, passive: false, camp: false, lootUntil: 0 },
  looter: { engage: 100, pref: 70, lowHp: 60, jitter: 110, react: 8, vision: V1 * FP, passive: false, camp: false, lootUntil: 1100 },
  coward: { engage: 90, pref: 90, lowHp: 70, jitter: 120, react: 9, vision: V1 * FP, passive: true, camp: true, lootUntil: 0 },
  balanced: { engage: 100, pref: 70, lowHp: 55, jitter: 125, react: 9, vision: V2 * FP, passive: false, camp: false, lootUntil: 0 },
};

interface Brain {
  rng: Rng;
  jitter: number;
  /** how well it leads moving targets, % */
  leadPct: number;
  strafe: number;
  strafeUntil: number;
  aimErr: number;
  aimErrUntil: number;
  target: number;
  targetSince: number;
  checkTick: number;
  checkX: number;
  checkY: number;
  detourUntil: number;
  detourSide: number;
  /** Big Island: consecutive stuck detours (wall following) and the tick of the last one */
  stuckN: number;
  lastStuck: number;
  /** Big Island: walking through a ruin opening: waypoint 1 (this side of the wall), then 2 (the far side) */
  doorX: number;
  doorY: number;
  door2X: number;
  door2Y: number;
  doorStage: number;
  doorUntil: number;
  wanderX: number;
  wanderY: number;
  wanderUntil: number;
  bush: number;
  outsideSince: number;
  stormDelay: number;
  shotFromX: number;
  shotFromY: number;
  shotFromT: number;
  /** % chance to react to an incoming bullet */
  dodge: number;
  dodgeUntil: number;
  dodgeA: number;
  wanderBush: boolean;
  burstLeft: number;
  burstPause: number;
  /** awareness of each other fighter (ticks noticed) */
  aw: number[];
  fleeUntil: number;
  fleeX: number;
  fleeY: number;
  lastMove: number;
  mode: string;
}

interface Mind {
  tick: number;
  px: number[];
  py: number[];
  vx: number[];
  vy: number[];
  /** has this fighter ever moved (for the human onboarding grace) */
  moved: boolean[];
  brains: Brain[];
}

const minds = new WeakMap<Match, Mind>();
/** campers hold still in their bush while the target is farther than this */
const BUSH_HOLD = 2800;
/** opening phase (ticks): bots loot and rotate, and only fight back when shot or touched */
const GRACE = 640;
/** ticks during which an idle, never-shooting human is ignored */
const HUMAN_GRACE = 200;
/** a bot keeps fighting outside the safe zone while its hp is above this */
const STORM_TOLERANCE: Record<Personality, number> = { aggressive: 20, camper: 55, sniper: 40, looter: 40, coward: 90, balanced: 30 };
/** base % chance to dodge an incoming bullet (checked once per dodge window) */
const DODGE: Record<Personality, number> = { aggressive: 30, camper: 25, sniper: 30, looter: 30, coward: 45, balanced: 35 };
/** chance (%) that a roaming bot heads for a nearby bush and lurks there */
const BUSH_PCT: Record<Personality, number> = { aggressive: 25, camper: 85, sniper: 60, looter: 45, coward: 85, balanced: 60 };
const ROAM_PACE = 550;
/** Big Island: roam faster and farther, lurk shorter (the map is 3.3x larger; keeps encounters coming) */
const BIG_ROAM_PACE = 800;
/** Big Island: roaming bots walk toward gunfire heard within this distance */
const HEAR_BIG = 22 * FP;
/** ...from this tick on (the opening stays a loot-and-rotate phase; the middle of the match gets busier) */
const HEAR_BIG_FROM = 640;
const BURST_MIN = 2, BURST_MAX = 4, PAUSE_MIN = 10, PAUSE_MAX = 22;
const sq = (v: number) => v * v;

function mind(match: Match): Mind {
  let m = minds.get(match);
  const fs = match.state.fighters;
  if (!m) {
    m = {
      tick: match.state.tick,
      px: fs.map((f) => f.x),
      py: fs.map((f) => f.y),
      vx: fs.map(() => 0),
      vy: fs.map(() => 0),
      moved: fs.map(() => false),
      brains: fs.map((f, i) => {
        const rng = new Rng(mixSeed(match.cfg.seed, 0xa1000 + i));
        const p = PERSONALITY[f.personality] ?? PERSONALITY.balanced;
        return {
          rng,
          jitter: Math.max(40, Math.min(220, p.jitter + 40 + rng.range(-15, 15) - 8 * match.cfg.fighters[i].upgrades.weaponTier)),
          leadPct: rng.range(20, 70) + (f.personality === "sniper" ? 15 : 0),
          strafe: rng.chance(50) ? 1 : -1,
          strafeUntil: 0,
          aimErr: 0,
          aimErrUntil: 0,
          target: -1,
          targetSince: 0,
          checkTick: 0,
          checkX: f.x,
          checkY: f.y,
          detourUntil: 0,
          detourSide: 1,
          stuckN: 0,
          lastStuck: -999,
          doorX: 0,
          doorY: 0,
          door2X: 0,
          door2Y: 0,
          doorStage: 0,
          doorUntil: -1,
          wanderX: 0,
          wanderY: 0,
          wanderUntil: 0,
          bush: -1,
          outsideSince: -1,
          stormDelay: f.personality === "coward" ? 0 : rng.range(40, 170),
          shotFromX: 0,
          shotFromY: 0,
          shotFromT: -999,
          dodge: DODGE[f.personality] + rng.range(-8, 8),
          dodgeUntil: -1,
          dodgeA: 0,
          wanderBush: false,
          burstLeft: 3,
          burstPause: 0,
          aw: fs.map(() => 0),
          fleeUntil: 0,
          fleeX: 0,
          fleeY: 0,
          lastMove: -1,
          mode: "",
        };
      }),
    };
    minds.set(match, m);
  }
  if (m.tick !== match.state.tick) {
    for (let i = 0; i < fs.length; i++) {
      m.vx[i] = fs[i].x - m.px[i];
      m.vy[i] = fs[i].y - m.py[i];
      m.px[i] = fs[i].x;
      m.py[i] = fs[i].y;
      if (m.vx[i] !== 0 || m.vy[i] !== 0) m.moved[i] = true;
    }
    m.tick = match.state.tick;
  }
  return m;
}

/** Debug only: a bot's internal memory (read-only use; tools/tests). */
export function botBrain(match: Match, idx: number): Readonly<Record<string, unknown>> | undefined {
  return minds.get(match)?.brains[idx] as unknown as Record<string, unknown> | undefined;
}

/** Debug: what each bot is doing (for overlays/tests). */
export function botMode(match: Match, idx: number): string {
  return minds.get(match)?.brains[idx]?.mode ?? "";
}

const lineBuf: Obstacle[] = [];
const blockBuf: Obstacle[] = [];

function lineClear(match: Match, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  for (const o of obstaclesNear(match.map, x0, y0, x1, y1, BULLET_R + 50, lineBuf)) if (segHit(x0, y0, dx, dy, o.x, o.y, o.r + BULLET_R + 50) >= 0) return false;
  return true;
}

function blockedAt(match: Match, x: number, y: number, pad: number): boolean {
  for (const o of obstaclesNear(match.map, x, y, x, y, FIGHTER_R + pad, blockBuf)) if (dist2(o.x, o.y, x, y) < sq(o.r + FIGHTER_R + pad)) return true;
  return false;
}

/** Pick a movement angle near `want` that avoids obstacles / water / (optionally) the storm. */
function steer(match: Match, me: FighterState, b: Brain, want: number, avoidStorm: boolean): number {
  const st = match.state.storm;
  const lim = match.map.radius - FIGHTER_R - 300;
  const inside = dist2(me.x, me.y, st.cx, st.cy) <= st.r * st.r;
  let best = want, bestScore = -1e9;
  for (let k = 0; k < 16; k++) {
    const a = k * 256;
    let score = icos(angDiff(a, want)) * 2;
    for (const step of [700, 1500, 2600]) {
      const x = me.x + Math.trunc((icos(a) * step) / 1024);
      const y = me.y + Math.trunc((isin(a) * step) / 1024);
      if (blockedAt(match, x, y, 100)) score -= step === 700 ? 4000 : step === 1500 ? 1500 : 500;
      if (x * x + y * y > lim * lim) score -= 3000;
      if (avoidStorm && inside && step === 1500 && dist2(x, y, st.cx, st.cy) > st.r * st.r) score -= 900;
    }
    if (a === b.lastMove) score += 120;
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  // If the direct heading is clear, use it exactly (smoother than 16-way).
  const x = me.x + Math.trunc((icos(want) * 900) / 1024);
  const y = me.y + Math.trunc((isin(want) * 900) / 1024);
  if (Math.abs(angDiff(best, want)) <= 256 && !blockedAt(match, x, y, 100) && x * x + y * y <= lim * lim) {
    b.lastMove = best;
    return want;
  }
  b.lastMove = best;
  return best;
}

/** training island (cfg.training): extra aim error (angle units) and reaction ticks against the human */
const TRAINING_JITTER = 260;
const TRAINING_REACT = 24;

export function botInput(match: Match, idx: number): Input {
  const s = match.state;
  const me = s.fighters[idx];
  const m = mind(match);
  const b = m.brains[idx];
  const t = s.tick;
  if (!me.alive || s.over) return { mx: 0, my: 0, aim: me.aim, fire: false };
  const P = PERSONALITY[me.personality] ?? PERSONALITY.balanced;
  const big = isBig(match.cfg);
  const w = WEAPONS[me.weapon];
  const st = s.storm as StormX;
  const armed = me.weapon !== "popper";
  const hurtRecently = t - me.lastHurtTick <= 40;
  const isRival = match.cfg.rival === idx;

  // ---- 1. Target selection (only enemies we can legitimately see, within vision).
  const vision = me.weapon === "sniper" ? P.vision + 3 * FP : P.vision;
  let tgt = -1, tgtScore = 1e18, nearest = 1e18, nearIdx = -1;
  let threatX = 0, threatY = 0, threats = 0;
  const alerted = t - me.lastHurtTick <= 30;
  for (const f of s.fighters) {
    if (f.idx === idx) continue;
    const d2 = dist2(me.x, me.y, f.x, f.y);
    if (!f.alive || d2 > vision * vision || !match.canSee(idx, f.idx)) {
      b.aw[f.idx] = Math.max(0, b.aw[f.idx] - 2);
      continue;
    }
    const d = isqrt(d2);
    // Onboarding grace: ignore a human who hasn't moved or shot yet during the first 10 s
    // (unless they're right next to us). Deterministic: uses only the human's state.
    if (f.human && t < HUMAN_GRACE && f.lastShotTick < 0 && m.vx[f.idx] === 0 && m.vy[f.idx] === 0 && !m.moved[f.idx] && d > 3 * FP) {
      b.aw[f.idx] = 0;
      continue;
    }
    // Awareness: an enemy must be noticed before it counts (view cone, hearing shots, being shot at).
    const need = 3 + Math.trunc(d / 700);
    if (b.aw[f.idx] < need) {
      const attended =
        alerted ||
        d < 4 * FP ||
        (t - f.lastShotTick <= 20 && d < 14 * FP) ||
        Math.abs(angDiff(iatan2(f.y - me.y, f.x - me.x), me.aim)) < 1000;
      if (attended) b.aw[f.idx]++;
      if (b.aw[f.idx] < need) continue;
    } else b.aw[f.idx] = Math.min(b.aw[f.idx] + 1, 60);
    if (d < nearest) {
      nearest = d;
      nearIdx = f.idx;
    }
    if (d < 10 * FP) {
      threatX += f.x;
      threatY += f.y;
      threats++;
    }
    // Weak + close targets first (third-party), keep the current one unless clearly worse.
    let score = d + f.hp * 40 - (f.idx === b.target ? 3 * FP : 0) - (f.bounty ? 2 * FP : 0);
    if (isRival && f.human) score -= 6 * FP; // the rival wants YOU
    if (!lineClear(match, me.x, me.y, f.x, f.y) && me.weapon !== "grenade") score += 6 * FP;
    if (score < tgtScore) {
      tgtScore = score;
      tgt = f.idx;
    }
  }
  if (tgt !== b.target) {
    b.target = tgt;
    b.targetSince = t;
  }
  const T = tgt >= 0 ? s.fighters[tgt] : null;
  const dT = T ? isqrt(dist2(me.x, me.y, T.x, T.y)) : 1e9;

  // ---- 2. Movement goal.
  let goalA = -1; // movement angle, -1 = stand still
  let avoidStorm = true;
  let mode = "roam";
  const dStorm = isqrt(dist2(me.x, me.y, st.cx, st.cy));
  const dTarget = isqrt(dist2(me.x, me.y, st.tx, st.ty));
  const phase = stormPhasesFor(match.cfg)[Math.max(0, st.phase - 1)];
  const toShrink = phase ? phase.shrinkEnd - t : 9999;
  const needT = dTarget - Math.max(0, st.targetR - 1500);
  const ticksToWalk = Math.trunc(Math.max(0, needT) / SPEED);
  // Storm discipline: bots notice they're outside only after a personal delay (cowards at once).
  const outside = dStorm > st.r - 300;
  if (!outside) b.outsideSince = -1;
  else if (b.outsideSince < 0) b.outsideSince = t;
  const stormUrgent = outside && t - b.outsideSince >= b.stormDelay;
  const stormSoon =
    needT > 0 &&
    st.phase > 0 &&
    (toShrink < ticksToWalk + (P.passive ? 200 : 30) || (P.passive && t > 200) || (st.targetR <= 2500 && needT > 0));
  const provoked = hurtRecently || (dT < 3500 && t >= GRACE) || s.alive <= 3;
  const earlyLoot = t < GRACE || (!armed && t < 900 && me.personality !== "aggressive");
  const willFight =
    T !== null &&
    (!P.passive || provoked || (T.hp <= 35 && dT <= w.range)) && // passive bots still steal finishing blows
    !(earlyLoot && !provoked) &&
    // non-aggressive bots only take fair fights unless cornered
    // non-aggressive bots pick fights only when they look favourable (or they're cornered)
    (me.personality === "aggressive" ||
      provoked ||
      T.hp <= 50 ||
      me.hp >= T.hp + 25 ||
      dT < 5 * FP ||
      (P.camp && me.inBush) ||
      (me.personality === "sniper" && me.weapon === "sniper") ||
      s.alive <= 4) && !(me.personality === "looter" && t < P.lootUntil && !provoked && !armed);
  const engageR = Math.min(vision, Math.trunc((w.range * P.engage) / 100));

  const angleTo = (x: number, y: number) => iatan2(y - me.y, x - me.x);
  // Disengage when losing (not aggressive bots, not in the endgame) or low; keep it up for a while.
  const losing = T !== null && me.personality !== "aggressive" && s.alive > 3 && me.hp < 75 && T.hp > me.hp + 15;
  if ((me.hp < P.lowHp || losing) && threats > 0 && s.alive > 2) b.fleeUntil = t + 50;
  // Shot by someone we can't see (long range / hidden): break line of fire, head for cover.
  if (T === null && t - me.lastHurtTick <= 10 && t - b.shotFromT <= 30 && s.alive > 2 && b.fleeUntil < t) {
    b.fleeUntil = t + 40;
    b.fleeX = b.shotFromX;
    b.fleeY = b.shotFromY;
  }
  if (me.hp >= Math.min(95, P.lowHp + 35) && threats === 0) b.fleeUntil = 0;
  const fleeing = t < b.fleeUntil && s.alive > 2;
  const insideTarget = (x: number, y: number, pad: number) =>
    dist2(x, y, st.tx, st.ty) <= sq(Math.max(st.targetR - pad, 0)) || st.phase === 0;

  // nearest heal (safe-ish)
  let heal = -1, healD = 1e18;
  for (const h of s.heals) {
    if (h.taken || !insideTarget(h.x, h.y, 500)) continue;
    const d = isqrt(dist2(me.x, me.y, h.x, h.y));
    // don't race a visible enemy to the same heal
    let contested = false;
    for (const f of s.fighters) {
      if (f.idx === idx || !f.alive || b.aw[f.idx] < 3 || !match.canSee(idx, f.idx)) continue;
      if (dist2(f.x, f.y, h.x, h.y) < sq(d + 2000)) contested = true;
    }
    if (contested) continue;
    if (d < healD) {
      healD = d;
      heal = h.id;
    }
  }

  let healSafe = true;
  if (heal >= 0 && threats > 0) {
    const ha = angleTo(s.heals[heal].x, s.heals[heal].y);
    healSafe = Math.abs(angDiff(ha, iatan2(Math.trunc(threatY / threats) - me.y, Math.trunc(threatX / threats) - me.x))) > 1200;
  }
  // Busy fighting a visible enemy? Many bots tank some storm damage rather than turn their back
  // (personality hp threshold) — this is where storm deaths come from.
  const busy = T !== null && willFight && dT <= engageR + 1000 && me.hp > STORM_TOLERANCE[me.personality];
  if ((stormUrgent || stormSoon) && !(busy && st.dps <= 15)) {
    mode = "storm";
    goalA = needT > 0 ? angleTo(st.tx, st.ty) : angleTo(st.cx, st.cy);
    avoidStorm = false;
  } else if (me.hp < P.lowHp && heal >= 0 && healD < 20 * FP && (threats === 0 || healSafe)) {
    mode = "heal";
    goalA = angleTo(s.heals[heal].x, s.heals[heal].y);
  } else if (fleeing) {
    mode = "flee";
    avoidStorm = st.dps >= 14; // running from a fight, bots will cut through a weak storm
    let ax = st.tx, ay = st.ty;
    if (threats > 0) {
      ax = Math.trunc(threatX / threats);
      ay = Math.trunc(threatY / threats);
      b.fleeX = ax;
      b.fleeY = ay;
    } else {
      ax = b.fleeX;
      ay = b.fleeY;
    }
    let a = iatan2(me.y - ay, me.x - ax);
    // prefer a nearby bush that is not toward the threat (hide + regen)
    let bestBush = -1, bestCost = 1e18;
    match.map.bushes.forEach((bu, i) => {
      const d = isqrt(dist2(me.x, me.y, bu.x, bu.y));
      if (d > 10 * FP || !insideTarget(bu.x, bu.y, 500)) return;
      const toward = Math.abs(angDiff(angleTo(bu.x, bu.y), iatan2(ay - me.y, ax - me.x)));
      if (toward < 1100 && d > 1500) return;
      const cost = d - isqrt(dist2(ax, ay, bu.x, bu.y));
      if (cost < bestCost) {
        bestCost = cost;
        bestBush = i;
      }
    });
    if (bestBush >= 0) {
      const bu = match.map.bushes[bestBush];
      a = dist2(me.x, me.y, bu.x, bu.y) > sq(800) ? angleTo(bu.x, bu.y) : -1;
      if (a < 0) mode = "hide";
    } else {
      // bias toward the safe centre so fleeing doesn't run into the storm
      const toC = angleTo(st.tx, st.ty);
      if (Math.abs(angDiff(a, toC)) > 1300) a = a + (angDiff(toC, a) > 0 ? 600 : -600);
    }
    // zig-zag while running so pursuers' leads miss
    if (a >= 0 && threats > 0) a += ((t >> 3) & 1 ? 1 : -1) * 450;
    goalA = a;
  } else if (me.hp <= me.maxHp - 35 && heal >= 0 && healD < 7 * FP) {
    mode = "heal";
    goalA = angleTo(s.heals[heal].x, s.heals[heal].y);
  } else if (T && willFight && dT <= engageR) {
    mode = "fight";
    let pref = Math.trunc((w.range * P.pref) / 100);
    if (me.weapon === "shotgun") pref = me.personality === "aggressive" ? 2000 : 3000;
    if (me.weapon === "grenade") pref = 6500;
    if (me.weapon === "popper" && me.personality === "aggressive") pref = 3500;
    pref = Math.min(pref, vision - 2 * FP);
    if (t >= b.strafeUntil) {
      b.strafe = -b.strafe;
      b.strafeUntil = t + b.rng.range(15, 30);
    }
    const at = angleTo(T.x, T.y);
    if (P.camp && me.inBush && dT > BUSH_HOLD) {
      goalA = -1; // ambush: hold still in the bush
      mode = "ambush";
    } else if (dT > pref + 1000) {
      // don't run after a retreating target unless aggressive or it is nearly dead
      const vx = m.vx[T.idx], vy = m.vy[T.idx];
      const away = vx * (T.x - me.x) + vy * (T.y - me.y) > 0 && vx * vx + vy * vy > 150 * 150;
      goalA = away && me.personality !== "aggressive" && T.hp > 30 ? at + b.strafe * 1024 : at + b.strafe * 350;
    }
    else if (dT < pref - 1000) goalA = at + 2048 - b.strafe * 350;
    else goalA = at + b.strafe * 1024;
  } else if (!armed || (t < P.lootUntil) || (me.personality === "sniper" && me.weapon !== "sniper" && t < 900)) {
    // ---- chest run (prefer uncontested chests)
    let best = -1, bestCost = 1e18;
    for (const c of s.chests) {
      if (c.open || !insideTarget(c.x, c.y, 1000)) continue;
      const d = isqrt(dist2(me.x, me.y, c.x, c.y));
      if (d > (t < 200 ? 30 : 16) * FP) continue;
      let cost = d;
      for (const f of s.fighters) {
        if (f.idx === idx || !f.alive || !match.canSee(idx, f.idx)) continue;
        if (dist2(f.x, f.y, c.x, c.y) < sq(d + 1500)) cost += 10 * FP;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = c.id;
      }
    }
    if (best >= 0) {
      mode = "chest";
      goalA = angleTo(s.chests[best].x, s.chests[best].y);
    }
  }

  if (mode === "roam" && T && willFight && t >= GRACE && (me.personality === "aggressive" || (!P.camp && me.hp >= T.hp + 30) || (isRival && s.fighters[T.idx].human))) {
    // chase visible targets beyond engage range
    mode = "chase";
    goalA = angleTo(T.x, T.y);
  }

  if (mode === "roam" && isRival && t >= GRACE && (armed || t >= 2 * GRACE)) {
    // the rival hunts you: walk toward the human (storm avoidance above still wins)
    const H = s.fighters.find((f) => f.human && f.alive);
    if (H && dist2(me.x, me.y, H.x, H.y) > sq(5 * FP)) {
      mode = "hunt";
      goalA = angleTo(H.x, H.y);
    }
  }

  if (mode === "roam" && P.camp && (armed || t > 600)) {
    // ---- pick / hold a bush inside the next safe circle
    const bush = b.bush >= 0 ? match.map.bushes[b.bush] : null;
    if (!bush || !insideTarget(bush.x, bush.y, 1000)) {
      b.bush = -1;
      let bestCost = 1e18;
      match.map.bushes.forEach((bu, i) => {
        if (!insideTarget(bu.x, bu.y, 1500)) return;
        let cost = isqrt(dist2(me.x, me.y, bu.x, bu.y));
        if (me.personality === "camper") cost += Math.trunc(isqrt(dist2(bu.x, bu.y, st.tx, st.ty)) / 2);
        for (const f of s.fighters) {
          if (f.idx !== idx && f.alive && match.canSee(idx, f.idx) && dist2(f.x, f.y, bu.x, bu.y) < sq(6 * FP)) cost += 8 * FP;
        }
        if (cost < bestCost) {
          bestCost = cost;
          b.bush = i;
        }
      });
    }
    if (b.bush >= 0) {
      const bu = match.map.bushes[b.bush];
      const d = isqrt(dist2(me.x, me.y, bu.x, bu.y));
      mode = "camp";
      goalA = d > Math.max(400, bu.r - 1200) ? angleTo(bu.x, bu.y) : -1;
    }
  }

  if (mode === "roam") {
    // Wander a few units at a time inside the safe area; often stop in a bush for a while (lurk).
    // roam the current circle until the shrink is nearly over (Big Island: passive bots, who head into the
    // next circle early, roam that one — else they dither on its edge between "storm" and "roam")
    const shrinking = phase !== undefined && (t >= phase.shrinkEnd - 60 || (big && P.passive && st.phase > 0));
    const cx = shrinking ? st.tx : st.cx, cy = shrinking ? st.ty : st.cy;
    const limR = shrinking ? st.targetR : st.r;
    const lim = Math.max(1000, big ? Math.min(Math.trunc((limR * 8) / 10), limR - 2000) : Math.trunc((limR * 8) / 10));
    const reached = dist2(me.x, me.y, b.wanderX, b.wanderY) < sq(1200);
    const outside = dist2(b.wanderX, b.wanderY, cx, cy) > sq(lim + 1500);
    if (big && me.personality === "aggressive" && t >= HEAR_BIG_FROM) {
      // Big Island: investigate gunfire heard nearby (third parties join fights; the map stays lively)
      let hd = sq(HEAR_BIG);
      for (const f of s.fighters) {
        if (f.idx === idx || !f.alive || t - f.lastShotTick > 30) continue;
        const d2 = dist2(f.x, f.y, me.x, me.y);
        if (d2 < hd && d2 > sq(6 * FP) && dist2(f.x, f.y, cx, cy) < sq(lim + 1000)) {
          hd = d2;
          b.wanderX = f.x;
          b.wanderY = f.y;
          b.wanderBush = false;
          b.wanderUntil = t + 160;
        }
      }
    }
    if (t >= b.wanderUntil || (reached && !b.wanderBush) || outside) {
      b.wanderBush = false;
      if (b.rng.chance(BUSH_PCT[me.personality])) {
        const cands: number[] = [];
        match.map.bushes.forEach((bu, i) => {
          if (dist2(bu.x, bu.y, me.x, me.y) < sq(11 * FP) && dist2(bu.x, bu.y, cx, cy) < sq(lim) && dist2(bu.x, bu.y, me.x, me.y) > sq(2 * FP))
            cands.push(i);
        });
        if (cands.length > 0) {
          const bu = match.map.bushes[cands[b.rng.below(cands.length)]];
          b.wanderX = bu.x;
          b.wanderY = bu.y;
          b.wanderBush = true;
          b.wanderUntil = t + Math.trunc(isqrt(dist2(bu.x, bu.y, me.x, me.y)) / SPEED) + (big ? b.rng.range(40, 100) : b.rng.range(60, 160));
        }
      }
      if (!b.wanderBush) {
        const a = b.rng.below(4096);
        const rr = big
          ? b.rng.range(6 * FP, me.personality === "aggressive" ? 14 * FP : 10 * FP)
          : b.rng.range(4 * FP, me.personality === "aggressive" ? 10 * FP : 7 * FP);
        let wx = me.x + Math.trunc((icos(a) * rr) / 1024);
        let wy = me.y + Math.trunc((isin(a) * rr) / 1024);
        const dd = isqrt(dist2(wx, wy, cx, cy));
        if (dd > lim) {
          wx = cx + Math.trunc(((wx - cx) * lim) / dd);
          wy = cy + Math.trunc(((wy - cy) * lim) / dd);
        }
        b.wanderX = wx;
        b.wanderY = wy;
        b.wanderUntil = t + b.rng.range(80, 200);
      }
    }
    if (reached) {
      goalA = -1;
      mode = b.wanderBush ? "lurk" : "roam";
    } else goalA = angleTo(b.wanderX, b.wanderY);
  }

  // Passive bots that are not fighting steer away from nearby visible enemies.
  if (P.passive && threats > 0 && mode !== "fight" && mode !== "storm" && mode !== "flee" && nearIdx >= 0 && nearest < 8 * FP) {
    const n = s.fighters[nearIdx];
    const away = iatan2(me.y - n.y, me.x - n.x);
    goalA = goalA < 0 ? away : goalA + Math.trunc(angDiff(away, goalA) / 2);
    mode += "+avoid";
  }

  // Dodge: sidestep an incoming bullet that would hit within ~8 ticks (skill-based reaction).
  if (!stormUrgent && b.dodgeUntil < t) {
    for (const p of s.projectiles) {
      if (p.owner === idx) continue;
      if (p.weapon === "grenade") {
        // run from where it will land (or from the grenade itself if it is close)
        const lx = p.x + p.vx * p.ttl, ly = p.y + p.vy * p.ttl;
        const nearLand = dist2(lx, ly, me.x, me.y) < sq(3500);
        if (!nearLand && segHit(p.x, p.y, p.vx * p.ttl, p.vy * p.ttl, me.x, me.y, 1200) < 0) continue;
        if (!b.rng.chance(b.dodge + 20)) break;
        b.dodgeA = nearLand ? iatan2(me.y - ly, me.x - lx) : (iatan2(p.vy, p.vx) + ((me.x - p.x) * p.vy - (me.y - p.y) * p.vx > 0 ? -1024 : 1024)) & 4095;
        b.dodgeUntil = t + 8;
        break;
      }
      if (segHit(p.x, p.y, p.vx * 8, p.vy * 8, me.x, me.y, FIGHTER_R + 500) < 0) continue;
      b.shotFromX = p.x - p.vx * 12;
      b.shotFromY = p.y - p.vy * 12;
      b.shotFromT = t;
      if (!b.rng.chance(b.dodge)) break;
      // move perpendicular to the bullet, away from its line
      const side = (me.x - p.x) * p.vy - (me.y - p.y) * p.vx > 0 ? -1 : 1;
      b.dodgeA = (iatan2(p.vy, p.vx) + side * 1024) & 4095;
      b.dodgeUntil = t + 6;
      break;
    }
  }
  if (t < b.dodgeUntil && !stormUrgent) {
    goalA = b.dodgeA;
    mode += "+dodge";
  }

  // ---- 3. Stuck detection -> detour sideways for a moment.
  if (t - b.checkTick >= 20) {
    const moved = dist2(me.x, me.y, b.checkX, b.checkY);
    if (goalA >= 0 && moved < sq(1500) && b.detourUntil < t) {
      b.detourUntil = t + b.rng.range(15, 30);
      const side = b.rng.chance(50) ? 1 : -1;
      if (big && t - b.lastStuck < 80) {
        // stuck again right after a detour (a long ruin wall): keep following it, longer each time,
        // and turn around if that doesn't work either
        b.stuckN++;
        if (b.stuckN >= 4) {
          b.stuckN = 1;
          b.detourSide = -b.detourSide;
        }
        b.detourUntil += 20 * b.stuckN;
      } else {
        b.detourSide = side;
        b.stuckN = 0;
      }
      b.lastStuck = t;
      b.strafe = -b.strafe;
      // Big Island: a roam goal behind a ruin wall can't be walked to directly — pick another one
      if (big && mode === "roam") b.wanderUntil = t;
    }
    b.checkTick = t;
    b.checkX = me.x;
    b.checkY = me.y;
  }
  // Big Island: stuck against a ruin wall -> walk through an opening (inside: the one facing the goal;
  // outside: the nearest, preferring the goal side), aiming 1.5 u past the wall line
  if (big && goalA >= 0 && match.map.ruins) {
    if (t - b.lastStuck < 40 && b.doorUntil + 60 < t) {
      // only when the way toward the goal really runs into a ruin wall within 2.5 u
      const gx = Math.trunc((icos(goalA & 4095) * 2500) / 1024), gy = Math.trunc((isin(goalA & 4095) * 2500) / 1024);
      for (const ru of match.map.ruins) {
        if (Math.abs(me.x - ru.x) > ru.h + 2500 || Math.abs(me.y - ru.y) > ru.h + 2500 || ru.openings.length === 0) continue;
        let walled = false;
        for (const o of obstaclesNear(match.map, me.x, me.y, me.x + gx, me.y + gy, FIGHTER_R, lineBuf)) {
          if (o.kind === "wall" && segHit(me.x, me.y, gx, gy, o.x, o.y, o.r + FIGHTER_R) >= 0) {
            walled = true;
            break;
          }
        }
        if (!walled) break;
        const inside = Math.abs(me.x - ru.x) < ru.h && Math.abs(me.y - ru.y) < ru.h;
        let best = ru.openings[0], bestCost = 1e18;
        for (const o of ru.openings) {
          const d = isqrt(dist2(me.x, me.y, o.x, o.y));
          const off = Math.abs(angDiff(iatan2(o.y - me.y, o.x - me.x), goalA & 4095));
          const cost = inside ? off * 4 + d : d + off;
          if (cost < bestCost) {
            bestCost = cost;
            best = o;
          }
        }
        const ox = best.x - ru.x, oy = best.y - ru.y;
        // points 1.6 u in front of / behind the opening along its side's normal
        let nx = 0, ny = 0;
        if (Math.abs(ox) > Math.abs(oy)) nx = ox > 0 ? 1600 : -1600;
        else ny = oy > 0 ? 1600 : -1600;
        const s1 = inside ? -1 : 1; // first waypoint on our side of the wall
        b.doorX = best.x + s1 * nx;
        b.doorY = best.y + s1 * ny;
        b.door2X = best.x - s1 * nx;
        b.door2Y = best.y - s1 * ny;
        b.doorStage = 1;
        b.doorUntil = t + 160;
        break;
      }
    }
    if (t < b.doorUntil) {
      if (b.doorStage === 1 && dist2(me.x, me.y, b.doorX, b.doorY) < sq(700)) {
        b.doorStage = 2;
        b.doorX = b.door2X;
        b.doorY = b.door2Y;
        b.detourUntil = 0;
      }
      if (b.doorStage === 2 && dist2(me.x, me.y, b.doorX, b.doorY) < sq(700)) b.doorUntil = t;
      else {
        goalA = angleTo(b.doorX, b.doorY);
        mode += "+door";
      }
    }
  }
  let mx = 0, my = 0;
  if (goalA >= 0) {
    let want = goalA & 4095;
    if (t < b.detourUntil) want = (want + b.detourSide * 1024) & 4095;
    const a = steer(match, me, b, want, avoidStorm);
    // cautious walk while roaming (fewer blind encounters); full speed otherwise
    const pace = mode === "roam" && t >= GRACE ? (big ? BIG_ROAM_PACE : ROAM_PACE) : 1000;
    mx = Math.trunc((icos(a) * pace) / 1024);
    my = Math.trunc((isin(a) * pace) / 1024);
  }

  // ---- 4. Aim + fire.
  let aim = me.aim;
  let aimDist: number | undefined;
  let fire = false;
  // training island: against the human, bots aim much worse and take longer to open fire
  const trainingVsHuman = match.cfg.training === true && T !== null && match.cfg.fighters[T.idx].human;
  if (t >= b.aimErrUntil) {
    const j = trainingVsHuman ? b.jitter + TRAINING_JITTER : b.jitter;
    b.aimErr = b.rng.range(-j, j);
    b.aimErrUntil = t + b.rng.range(6, 12);
  }
  if (T) {
    const sp = Math.max(1, w.speed);
    const lead = me.weapon === "grenade" ? w.fuse : Math.min(40, Math.trunc(dT / sp));
    const ex = T.x + Math.trunc((m.vx[T.idx] * lead * b.leadPct) / 100);
    const ey = T.y + Math.trunc((m.vy[T.idx] * lead * b.leadPct) / 100);
    if (me.weapon === "grenade") aimDist = isqrt(dist2(me.x, me.y, ex, ey)) + b.rng.range(-400, 400);
    const want = (iatan2(ey - me.y, ex - me.x) + b.aimErr) & 4095;
    const diff = angDiff(want, aim);
    const turn = 380;
    aim = (aim + Math.max(-turn, Math.min(turn, diff))) & 4095;
    const aimed = Math.abs(angDiff(want, aim)) <= 60;
    let maxR = w.range;
    if (me.weapon === "shotgun") maxR = w.range - 800;
    if (me.weapon === "grenade") maxR = w.range + 500;
    if (me.weapon === "grenade" && dT < 3 * FP) maxR = 0;
    const ambushR = P.camp && me.inBush ? Math.trunc((w.range * 85) / 100) : maxR;
    const clear = me.weapon === "grenade" || lineClear(match, me.x, me.y, T.x, T.y);
    const allowed = (willFight && !mode.startsWith("flee")) || ((mode.startsWith("flee") || mode.startsWith("hide")) && (hurtRecently || dT < 4 * FP));
    fire = allowed && aimed && clear && dT <= Math.min(maxR, ambushR) && t - b.targetSince >= P.react + (trainingVsHuman ? TRAINING_REACT : 0) && t >= me.readyTick;
    if (me.ammo === 0 || t < SPAWN_PROTECT) fire = false; // no point shooting protected fighters
    // Human-like bursts: a few shots, then a short pause to re-aim / move.
    if (fire && t < b.burstPause) fire = false;
    if (fire && --b.burstLeft <= 0) {
      b.burstLeft = b.rng.range(BURST_MIN, BURST_MAX);
      b.burstPause = t + b.rng.range(PAUSE_MIN, PAUSE_MAX);
    }
  } else if (goalA >= 0) {
    const d = angDiff(iatan2(my, mx), aim);
    aim = (aim + Math.max(-200, Math.min(200, d))) & 4095;
  }

  b.mode = mode;
  const out: Input = { mx, my, aim, fire };
  if (aimDist !== undefined) out.aimDist = Math.max(0, aimDist);
  return out;
}
