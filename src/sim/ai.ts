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
import type { FighterState, Input, Match, Personality } from "./types.ts";
import { FP, Rng, angDiff, dist2, iatan2, icos, isin, isqrt, mixSeed } from "./fixed.ts";
import { BULLET_R, FIGHTER_R, SPEED, STORM_PHASES, WEAPONS, type StormX } from "./rules.ts";
import { segHit } from "./geom.ts";

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

export const PERSONALITY: Record<Personality, Params> = {
  aggressive: { engage: 140, pref: 45, lowHp: 25, jitter: 140, react: 8, vision: 12 * FP, passive: false, camp: false, lootUntil: 0 },
  camper: { engage: 100, pref: 70, lowHp: 40, jitter: 115, react: 10, vision: 11 * FP, passive: false, camp: true, lootUntil: 0 },
  sniper: { engage: 110, pref: 80, lowHp: 40, jitter: 100, react: 12, vision: 15 * FP, passive: false, camp: false, lootUntil: 0 },
  looter: { engage: 100, pref: 70, lowHp: 45, jitter: 135, react: 10, vision: 11 * FP, passive: false, camp: false, lootUntil: 1500 },
  coward: { engage: 90, pref: 90, lowHp: 60, jitter: 150, react: 12, vision: 11 * FP, passive: true, camp: true, lootUntil: 0 },
  balanced: { engage: 110, pref: 70, lowHp: 40, jitter: 125, react: 9, vision: 12 * FP, passive: false, camp: false, lootUntil: 0 },
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
  wanderX: number;
  wanderY: number;
  wanderUntil: number;
  bush: number;
  lastMove: number;
  mode: string;
}

interface Mind {
  tick: number;
  px: number[];
  py: number[];
  vx: number[];
  vy: number[];
  brains: Brain[];
}

const minds = new WeakMap<Match, Mind>();
/** campers hold still in their bush while the target is farther than this */
const BUSH_HOLD = 2800;
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
      brains: fs.map((f, i) => {
        const rng = new Rng(mixSeed(match.cfg.seed, 0xa1000 + i));
        const p = PERSONALITY[f.personality] ?? PERSONALITY.balanced;
        return {
          rng,
          jitter: Math.max(40, Math.min(170, p.jitter + rng.range(-15, 15) - 8 * match.cfg.fighters[i].upgrades.weaponTier)),
          leadPct: rng.range(35, 85) + (f.personality === "sniper" ? 15 : 0),
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
          wanderX: 0,
          wanderY: 0,
          wanderUntil: 0,
          bush: -1,
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
    }
    m.tick = match.state.tick;
  }
  return m;
}

/** Debug: what each bot is doing (for overlays/tests). */
export function botMode(match: Match, idx: number): string {
  return minds.get(match)?.brains[idx]?.mode ?? "";
}

function lineClear(match: Match, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  for (const o of match.map.obstacles) if (segHit(x0, y0, dx, dy, o.x, o.y, o.r + BULLET_R + 50) >= 0) return false;
  return true;
}

function blockedAt(match: Match, x: number, y: number, pad: number): boolean {
  for (const o of match.map.obstacles) if (dist2(o.x, o.y, x, y) < sq(o.r + FIGHTER_R + pad)) return true;
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

export function botInput(match: Match, idx: number): Input {
  const s = match.state;
  const me = s.fighters[idx];
  const m = mind(match);
  const b = m.brains[idx];
  const t = s.tick;
  if (!me.alive || s.over) return { mx: 0, my: 0, aim: me.aim, fire: false };
  const P = PERSONALITY[me.personality] ?? PERSONALITY.balanced;
  const w = WEAPONS[me.weapon];
  const st = s.storm as StormX;
  const armed = me.weapon !== "popper";
  const hurtRecently = t - me.lastHurtTick <= 40;

  // ---- 1. Target selection (only enemies we can legitimately see, within vision).
  const vision = me.weapon === "sniper" ? P.vision + 3 * FP : P.vision;
  let tgt = -1, tgtScore = 1e18, nearest = 1e18, nearIdx = -1;
  let threatX = 0, threatY = 0, threats = 0;
  for (const f of s.fighters) {
    if (f.idx === idx || !f.alive || !match.canSee(idx, f.idx)) continue;
    const d2 = dist2(me.x, me.y, f.x, f.y);
    if (d2 > vision * vision) continue;
    const d = isqrt(d2);
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
    let score = d + f.hp * 40 - (f.idx === b.target ? 3 * FP : 0);
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
  const phase = STORM_PHASES[Math.max(0, st.phase - 1)];
  const toShrink = phase ? phase.shrinkEnd - t : 9999;
  const needT = dTarget - Math.max(0, st.targetR - 1500);
  const ticksToWalk = Math.trunc(Math.max(0, needT) / SPEED);
  const stormUrgent = dStorm > st.r - 700;
  const stormSoon =
    needT > 0 &&
    st.phase > 0 &&
    (toShrink < ticksToWalk * 2 + 120 || (P.passive && t > 200) || (st.targetR <= 4500 && needT > 0));
  const provoked = hurtRecently || (dT < 3500 && t >= 300) || s.alive <= 3;
  const earlyLoot = t < 300 || (!armed && t < 700 && me.personality !== "aggressive");
  const willFight =
    T !== null &&
    (!P.passive || provoked) &&
    !(earlyLoot && !provoked) &&
    // non-aggressive bots only take fair fights unless cornered
    (me.personality === "aggressive" || provoked || me.hp >= 55 || me.hp >= T.hp) && !(me.personality === "looter" && t < P.lootUntil && !provoked && !armed);
  const engageR = Math.min(vision, Math.trunc((w.range * P.engage) / 100));

  const angleTo = (x: number, y: number) => iatan2(y - me.y, x - me.x);
  const insideTarget = (x: number, y: number, pad: number) =>
    dist2(x, y, st.tx, st.ty) <= sq(Math.max(st.targetR - pad, 0)) || st.phase === 0;

  // nearest heal (safe-ish)
  let heal = -1, healD = 1e18;
  for (const h of s.heals) {
    if (h.taken || !insideTarget(h.x, h.y, 500)) continue;
    const d = isqrt(dist2(me.x, me.y, h.x, h.y));
    if (d < healD) {
      healD = d;
      heal = h.id;
    }
  }

  if (stormUrgent || stormSoon) {
    mode = "storm";
    goalA = needT > 0 ? angleTo(st.tx, st.ty) : angleTo(st.cx, st.cy);
    avoidStorm = false;
  } else if (me.hp < P.lowHp && heal >= 0 && healD < 20 * FP) {
    mode = "heal";
    goalA = angleTo(s.heals[heal].x, s.heals[heal].y);
  } else if (me.hp < P.lowHp && threats > 0 && s.alive > 2) {
    mode = "flee";
    const ax = Math.trunc(threatX / threats), ay = Math.trunc(threatY / threats);
    let a = iatan2(me.y - ay, me.x - ax);
    // bias toward the safe centre so fleeing doesn't run into the storm
    const toC = angleTo(st.tx, st.ty);
    if (Math.abs(angDiff(a, toC)) > 1300) a = a + (angDiff(toC, a) > 0 ? 600 : -600);
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
    } else if (dT > pref + 1000) goalA = at + b.strafe * 350;
    else if (dT < pref - 1000) goalA = at + 2048 - b.strafe * 350;
    else goalA = at + b.strafe * 1024;
  } else if (!armed || (t < P.lootUntil) || (me.personality === "sniper" && me.weapon !== "sniper" && t < 1400)) {
    // ---- chest run (prefer uncontested chests)
    let best = -1, bestCost = 1e18;
    for (const c of s.chests) {
      if (c.open || !insideTarget(c.x, c.y, 1000)) continue;
      const d = isqrt(dist2(me.x, me.y, c.x, c.y));
      if (d > 30 * FP) continue;
      let cost = d;
      for (const f of s.fighters) {
        if (f.idx === idx || !f.alive || !match.canSee(idx, f.idx)) continue;
        if (dist2(f.x, f.y, c.x, c.y) < sq(d - 1500)) cost += 6 * FP;
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

  if (mode === "roam" && T && willFight && t >= 300 && (me.personality === "aggressive" || (!P.camp && me.hp >= T.hp + 20))) {
    // chase visible targets beyond engage range
    mode = "chase";
    goalA = angleTo(T.x, T.y);
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
    // wander inside the next safe circle; passive bots also keep away from visible enemies
    if (t >= b.wanderUntil || dist2(me.x, me.y, b.wanderX, b.wanderY) < sq(2 * FP) || !insideTarget(b.wanderX, b.wanderY, 1000)) {
      // local wander (a few units from here), pulled inside the next safe circle
      const a = b.rng.below(4096);
      const rr = b.rng.range(4 * FP, me.personality === "aggressive" ? 10 * FP : 7 * FP);
      let wx = me.x + Math.trunc((icos(a) * rr) / 1024);
      let wy = me.y + Math.trunc((isin(a) * rr) / 1024);
      const lim = Math.max(1000, Math.trunc((st.targetR * 8) / 10));
      const dd = isqrt(dist2(wx, wy, st.tx, st.ty));
      if (dd > lim) {
        wx = st.tx + Math.trunc(((wx - st.tx) * lim) / dd);
        wy = st.ty + Math.trunc(((wy - st.ty) * lim) / dd);
      }
      b.wanderX = wx;
      b.wanderY = wy;
      b.wanderUntil = t + b.rng.range(80, 200);
    }
    goalA = angleTo(b.wanderX, b.wanderY);
    if (dist2(me.x, me.y, b.wanderX, b.wanderY) < sq(1500)) goalA = -1;
  }

  // Passive bots that are not fighting steer away from nearby visible enemies.
  if (P.passive && threats > 0 && mode !== "fight" && mode !== "storm" && mode !== "flee" && nearIdx >= 0 && nearest < 8 * FP) {
    const n = s.fighters[nearIdx];
    const away = iatan2(me.y - n.y, me.x - n.x);
    goalA = goalA < 0 ? away : goalA + Math.trunc(angDiff(away, goalA) / 2);
    mode += "+avoid";
  }

  // ---- 3. Stuck detection -> detour sideways for a moment.
  if (t - b.checkTick >= 20) {
    const moved = dist2(me.x, me.y, b.checkX, b.checkY);
    if (goalA >= 0 && moved < sq(1500) && b.detourUntil < t) {
      b.detourUntil = t + b.rng.range(15, 30);
      b.detourSide = b.rng.chance(50) ? 1 : -1;
      b.strafe = -b.strafe;
    }
    b.checkTick = t;
    b.checkX = me.x;
    b.checkY = me.y;
  }
  let mx = 0, my = 0;
  if (goalA >= 0) {
    let want = goalA & 4095;
    if (t < b.detourUntil) want = (want + b.detourSide * 1024) & 4095;
    const a = steer(match, me, b, want, avoidStorm);
    mx = Math.trunc((icos(a) * 1000) / 1024);
    my = Math.trunc((isin(a) * 1000) / 1024);
  }

  // ---- 4. Aim + fire.
  let aim = me.aim;
  let fire = false;
  if (t >= b.aimErrUntil) {
    const j = b.jitter;
    b.aimErr = b.rng.range(-j, j);
    b.aimErrUntil = t + b.rng.range(6, 12);
  }
  if (T) {
    const sp = Math.max(1, w.speed);
    const lead = Math.min(40, Math.trunc(dT / sp));
    const ex = T.x + Math.trunc((m.vx[T.idx] * lead * b.leadPct) / 100);
    const ey = T.y + Math.trunc((m.vy[T.idx] * lead * b.leadPct) / 100);
    const want = (iatan2(ey - me.y, ex - me.x) + b.aimErr) & 4095;
    const diff = angDiff(want, aim);
    const turn = 380;
    aim = (aim + Math.max(-turn, Math.min(turn, diff))) & 4095;
    const aimed = Math.abs(angDiff(want, aim)) <= 60;
    let maxR = w.range;
    if (me.weapon === "shotgun") maxR = w.range - 800;
    if (me.weapon === "grenade") maxR = w.range + 800;
    const ambushR = P.camp && me.inBush ? Math.trunc((w.range * 85) / 100) : maxR;
    const clear = me.weapon === "grenade" || lineClear(match, me.x, me.y, T.x, T.y);
    const allowed = willFight || (mode === "flee" && provoked);
    fire = allowed && aimed && clear && dT <= Math.min(maxR, ambushR) && t - b.targetSince >= P.react && t >= me.readyTick;
    if (me.ammo === 0) fire = false;
  } else if (goalA >= 0) {
    const d = angDiff(iatan2(my, mx), aim);
    aim = (aim + Math.max(-200, Math.min(200, d))) & 4095;
  }

  b.mode = mode;
  return { mx, my, aim, fire };
}
