// BOUNTY ROYALE deterministic match simulation (agent B). Pure TS, no DOM, integer math only.
//
// T1 tuning (tables live in rules.ts):
//  - 20 Hz, 3600 ticks max. Island radius 32 u, spawns on a 24 u ring (±1.5 u, ±60 angle jitter).
//  - 18 obstacles (rock r1.0–1.6 / tree r0.6–0.8 / crate r0.8, ≥1.4 u walkable gaps), 14–18 bushes
//    (r1.6–2.4), 9 chests (1 central + 8 on a 14–21 u ring between spawns;
//    blaster 38 / shotgun 27 / sniper 15 / grenade 20 %), 6 heals (+35 hp).
//  - Fighter: 100 hp, r 0.5 u, 5 u/s (250 FP/tick), soft fighter-fighter separation.
//    A closed chest opens when the fighter centre is within 1.4 u of it; heals likewise (only if hurt).
//  - Weapons: popper 12dmg cd6 9u 0.9u/t 6 shots rl30 · blaster 16 cd4 11u 1.0u/t 10 rl36 ·
//    shotgun 5×9 ±150 cd16 6u 4 rl40 · sniper 55 cd30 22u 2.5u/t 3 rl50 ·
//    grenade 45 (→50 % at edge) r2.5u, lobbed 9 u over obstacles, fuse 16 t (or impact on an enemy),
//    3 shots cd20 rl50; owners are immune to their own grenades.
//    Crit 8 % ×1.5. Weapon tier +10 % dmg, armor −2 per level (min 1).
//  - Grenade proximity fuse: explodes on touching an enemy (0.65 u) or after the fuse.
//  - Regen: after 3 s without being hurt or shooting, +4 hp every 0.5 s (8 hp/s).
//  - Bush stealth: hidden unless viewer ≤2.5 u, target shot ≤20 ticks ago, or was hurt ≤10 ticks ago.
//  - Storm: 6 phases (rules.ts STORM_PHASES): 32 → 22 → 14 → 8 → 4.5 → 2.5 → 0 u, dps 4/6/9/12/16/20
//    (applied every 10 ticks as ceil(dps/2), ignores armor). Storm hits emit "hit" with by = -1.
//    Shrinks (s): 20–35, 50–65, 80–95, 108–123, 140–165 (2.5 u), 169–177 (closed). Each phase is
//    announced (event "storm") ~13–17 s before it shrinks; the new centre drifts ≤70 % of the slack.
//    state.storm also carries tx/ty = the centre of the circle it is shrinking toward (StormX).
//  - Time out at 3600 ticks: highest hp wins (tiebreak lowest idx). If every remaining fighter would
//    die on the same tick, the one with the most hp left survives with 1 hp.
//
// Input/tick convention: step(inputs) advances state.tick from t to t+1 using `inputs` as the controls
// for that step. A Recorder must be fed `match.state.tick` read BEFORE calling step().
// Fighters with human: true and no entry in the map stand still.
import {
  FIGHTERS,
  MATCH_TICKS,
  type Chest,
  type FighterState,
  type Heal,
  type Input,
  type Match,
  type MatchConfig,
  type MatchState,
  type Projectile,
  type SimEvent,
  type WeaponKind,
} from "./types";
import { Rng, dist2, iatan2, icos, isin, isqrt, mixSeed } from "./fixed";
import {
  BULLET_R,
  BUSH_REVEAL_DIST,
  BUSH_REVEAL_HURT,
  BUSH_REVEAL_SHOT,
  CHEST_R,
  CRIT_DEN,
  CRIT_NUM,
  CRIT_PCT,
  FIGHTER_R,
  HEAL_R,
  MAX_HP,
  REGEN_DELAY,
  REGEN_EVERY,
  REGEN_HP,
  SPEED,
  STORM_EVERY,
  STORM_PHASES,
  WEAPONS,
  WEAPON_ORDER,
  armored,
  scaledDamage,
  type StormX,
} from "./rules";
import { generateWorld } from "./mapgen";
import { segHit } from "./geom";
import { botInput } from "./ai";

export { WEAPONS, STORM_PHASES, type StormX, type WeaponStats } from "./rules";

const IDLE: Input = { mx: 0, my: 0, aim: 0, fire: false };
const sq = (v: number) => v * v;

export function createMatch(cfg: MatchConfig): Match {
  const world = generateWorld(cfg.seed);
  const map = world.map;
  const rng = new Rng(mixSeed(cfg.seed, 0xb0b));

  const fighters: FighterState[] = cfg.fighters.map((f, idx) => ({
    idx,
    id: f.id,
    name: f.name,
    human: f.human,
    personality: f.personality,
    x: map.spawns[idx].x,
    y: map.spawns[idx].y,
    aim: iatan2(-map.spawns[idx].y, -map.spawns[idx].x),
    hp: MAX_HP,
    maxHp: MAX_HP,
    armor: f.upgrades.armor,
    weapon: "popper",
    ammo: WEAPONS.popper.mag,
    readyTick: 0,
    alive: true,
    inBush: false,
    lastShotTick: -999,
    lastHurtTick: -999,
    kills: 0,
    damageDealt: 0,
    placement: 0,
    bounty: f.bounty,
  }));

  const storm: StormX = { cx: 0, cy: 0, r: map.radius, targetR: map.radius, phase: 0, dps: 0, tx: 0, ty: 0 };
  const state: MatchState = {
    tick: 0,
    fighters,
    projectiles: [],
    chests: world.chests,
    heals: world.heals,
    storm,
    alive: FIGHTERS,
    over: false,
    winner: null,
  };

  // Internal state (included in hash()).
  let nextProj = 1;
  const lastBy: number[] = new Array(FIGHTERS).fill(-1); // last damager idx (-2 = storm)
  const lastWeapon: WeaponKind[] = new Array(FIGHTERS).fill("popper");
  const tiers: number[] = cfg.fighters.map((f) => f.upgrades.weaponTier);
  let fromCx = 0, fromCy = 0, fromR = map.radius;

  const inBushAt = (x: number, y: number) => map.bushes.some((b) => dist2(b.x, b.y, x, y) < b.r * b.r);

  function canSee(viewer: number, target: number): boolean {
    const t = fighters[target];
    if (!t || !t.alive) return false;
    if (viewer === target || !t.inBush) return true;
    const v = fighters[viewer];
    if (v && dist2(v.x, v.y, t.x, t.y) <= sq(BUSH_REVEAL_DIST)) return true;
    if (state.tick - t.lastShotTick <= BUSH_REVEAL_SHOT) return true;
    if (state.tick - t.lastHurtTick <= BUSH_REVEAL_HURT) return true;
    return false;
  }

  function damage(target: FighterState, amount: number, by: number, weapon: WeaponKind, crit: boolean, ev: SimEvent[]) {
    if (!target.alive || target.hp <= 0) return;
    const dmg = armored(amount, target.armor);
    const dealt = Math.min(dmg, target.hp);
    target.hp -= dmg;
    target.lastHurtTick = state.tick;
    lastBy[target.idx] = by;
    lastWeapon[target.idx] = weapon;
    fighters[by].damageDealt += dealt;
    ev.push({ t: "hit", who: target.idx, by, dmg, crit, x: target.x, y: target.y });
  }

  function rollDamage(base: number, owner: number): [number, boolean] {
    let d = scaledDamage(base, tiers[owner]);
    const crit = rng.chance(CRIT_PCT);
    if (crit) d = Math.trunc((d * CRIT_NUM) / CRIT_DEN);
    return [d, crit];
  }

  function explode(p: Projectile, ev: SimEvent[]) {
    const w = WEAPONS.grenade;
    ev.push({ t: "explode", x: p.x, y: p.y, r: w.blast, by: p.owner });
    for (const f of fighters) {
      if (!f.alive || f.idx === p.owner) continue;
      const reach = w.blast + FIGHTER_R;
      const d2 = dist2(f.x, f.y, p.x, p.y);
      if (d2 > reach * reach) continue;
      const d = Math.min(isqrt(d2), reach);
      const [base, crit] = rollDamage(p.dmg, p.owner);
      const amt = Math.max(1, Math.trunc((base * (2 * reach - d)) / (2 * reach)));
      damage(f, amt, p.owner, "grenade", crit, ev);
    }
  }

  function moveFighter(f: FighterState, inp: Input) {
    let mx = Math.trunc(inp.mx) || 0, my = Math.trunc(inp.my) || 0;
    mx = Math.max(-1000, Math.min(1000, mx));
    my = Math.max(-1000, Math.min(1000, my));
    const len = isqrt(mx * mx + my * my);
    if (len > 1000) {
      mx = Math.trunc((mx * 1000) / len);
      my = Math.trunc((my * 1000) / len);
    }
    f.x += Math.trunc((mx * SPEED) / 1000);
    f.y += Math.trunc((my * SPEED) / 1000);
  }

  function collide(f: FighterState) {
    for (let pass = 0; pass < 2; pass++) {
      for (const o of map.obstacles) {
        const min = o.r + FIGHTER_R;
        const d2 = dist2(f.x, f.y, o.x, o.y);
        if (d2 >= min * min) continue;
        const d = isqrt(d2);
        if (d === 0) {
          f.x = o.x + min + 1;
          continue;
        }
        f.x = o.x + Math.trunc(((f.x - o.x) * (min + 2)) / d);
        f.y = o.y + Math.trunc(((f.y - o.y) * (min + 2)) / d);
      }
    }
    const lim = map.radius - FIGHTER_R;
    const d2 = f.x * f.x + f.y * f.y;
    if (d2 > lim * lim) {
      const d = isqrt(d2);
      f.x = Math.trunc((f.x * lim) / d);
      f.y = Math.trunc((f.y * lim) / d);
    }
  }

  function separate() {
    const min = 2 * FIGHTER_R;
    for (let i = 0; i < FIGHTERS; i++) {
      const a = fighters[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < FIGHTERS; j++) {
        const b = fighters[j];
        if (!b.alive) continue;
        const d2 = dist2(a.x, a.y, b.x, b.y);
        if (d2 >= min * min) continue;
        const d = isqrt(d2);
        const push = Math.trunc((min - d) / 2) + 1;
        let nx = 1000, ny = 0;
        if (d > 0) {
          nx = Math.trunc(((b.x - a.x) * 1000) / d);
          ny = Math.trunc(((b.y - a.y) * 1000) / d);
        } else if ((i + j) & 1) {
          nx = 0;
          ny = 1000;
        }
        a.x -= Math.trunc((nx * push) / 1000);
        a.y -= Math.trunc((ny * push) / 1000);
        b.x += Math.trunc((nx * push) / 1000);
        b.y += Math.trunc((ny * push) / 1000);
      }
    }
  }

  function fire(f: FighterState, aim: number, ev: SimEvent[]) {
    const w = WEAPONS[f.weapon];
    const t = state.tick;
    const mx = f.x + Math.trunc((icos(aim) * (FIGHTER_R + 100)) / 1024);
    const my = f.y + Math.trunc((isin(aim) * (FIGHTER_R + 100)) / 1024);
    const ttl = f.weapon === "grenade" ? w.fuse : Math.trunc((w.range + w.speed - 1) / w.speed);
    for (let k = 0; k < w.pellets; k++) {
      let a = aim;
      if (w.pellets > 1) a = aim - w.spread + Math.trunc((2 * w.spread * k) / (w.pellets - 1)) + rng.range(-20, 20);
      state.projectiles.push({
        id: nextProj++,
        owner: f.idx,
        weapon: f.weapon,
        x: mx,
        y: my,
        vx: Math.trunc((icos(a) * w.speed) / 1024),
        vy: Math.trunc((isin(a) * w.speed) / 1024),
        ttl,
        dmg: w.dmg,
      });
    }
    ev.push({ t: "shot", who: f.idx, weapon: f.weapon, x: mx, y: my, aim });
    f.ammo--;
    f.lastShotTick = t;
    if (f.ammo <= 0) {
      f.ammo = 0;
      f.readyTick = t + w.reload;
    } else f.readyTick = t + w.cd;
  }

  function stepProjectiles(ev: SimEvent[]) {
    const keep: Projectile[] = [];
    for (const p of state.projectiles) {
      const dx = p.vx, dy = p.vy;
      if (p.weapon === "grenade") {
        p.x += dx;
        p.y += dy;
        p.ttl--;
        let boom = p.ttl <= 0;
        if (!boom) {
          for (const f of fighters) {
            if (f.alive && f.idx !== p.owner && dist2(f.x, f.y, p.x, p.y) <= sq(FIGHTER_R + 150)) {
              boom = true;
              break;
            }
          }
        }
        if (boom) explode(p, ev);
        else keep.push(p);
        continue;
      }
      // Bullet: the first thing touched along this tick's segment.
      let bestT = 2000, hitF = -1;
      for (const o of map.obstacles) {
        const t = segHit(p.x, p.y, dx, dy, o.x, o.y, o.r + BULLET_R);
        if (t >= 0 && t < bestT) {
          bestT = t;
          hitF = -1;
        }
      }
      for (const f of fighters) {
        if (!f.alive || f.idx === p.owner) continue;
        const t = segHit(p.x, p.y, dx, dy, f.x, f.y, FIGHTER_R + BULLET_R);
        if (t >= 0 && t < bestT) {
          bestT = t;
          hitF = f.idx;
        }
      }
      if (bestT < 2000) {
        if (hitF >= 0) {
          const [d, crit] = rollDamage(p.dmg, p.owner);
          damage(fighters[hitF], d, p.owner, p.weapon, crit, ev);
        }
        continue;
      }
      p.x += dx;
      p.y += dy;
      p.ttl--;
      if (p.ttl > 0) keep.push(p);
    }
    state.projectiles = keep;
  }

  function stepStorm(ev: SimEvent[]) {
    const t = state.tick;
    const next = STORM_PHASES[storm.phase];
    if (next && t >= next.announce) {
      // New phase: pick the target circle inside the current one.
      fromCx = storm.cx;
      fromCy = storm.cy;
      fromR = storm.r;
      const slack = Math.max(0, storm.r - next.r);
      const a = rng.below(4096);
      const d = Math.trunc((slack * rng.range(0, 700)) / 1000);
      storm.tx = storm.cx + Math.trunc((icos(a) * d) / 1024);
      storm.ty = storm.cy + Math.trunc((isin(a) * d) / 1024);
      storm.targetR = next.r;
      storm.dps = next.dps;
      storm.phase++;
      ev.push({ t: "storm", phase: storm.phase, targetR: next.r });
    }
    const cur = STORM_PHASES[storm.phase - 1];
    if (cur && t >= cur.shrinkStart) {
      const dur = cur.shrinkEnd - cur.shrinkStart;
      const k = Math.min(dur, t - cur.shrinkStart);
      storm.r = fromR + Math.trunc(((cur.r - fromR) * k) / dur);
      storm.cx = fromCx + Math.trunc(((storm.tx - fromCx) * k) / dur);
      storm.cy = fromCy + Math.trunc(((storm.ty - fromCy) * k) / dur);
    }
    if (t % STORM_EVERY === 0 && storm.dps > 0) {
      const amt = Math.trunc((storm.dps + 1) / 2);
      for (const f of fighters) {
        if (!f.alive) continue;
        if (dist2(f.x, f.y, storm.cx, storm.cy) > storm.r * storm.r) {
          f.hp -= amt;
          f.lastHurtTick = t;
          ev.push({ t: "hit", who: f.idx, by: -1, dmg: amt, crit: false, x: f.x, y: f.y });
          if (f.hp <= 0) lastBy[f.idx] = -2; // storm kill
        }
      }
    }
  }

  function finish(winner: number, ev: SimEvent[]) {
    state.over = true;
    state.winner = winner;
    fighters[winner].placement = 1;
    ev.push({ t: "win", who: winner });
  }

  function resolveDeaths(ev: SimEvent[]) {
    const dying = fighters.filter((f) => f.alive && f.hp <= 0);
    if (dying.length === 0) return;
    // Worst first (lowest hp, then highest idx) so placements are deterministic.
    dying.sort((a, b) => a.hp - b.hp || b.idx - a.idx);
    if (dying.length >= state.alive) dying.pop()!.hp = 1;
    for (const f of dying) {
      f.alive = false;
      f.hp = 0;
      f.placement = state.alive;
      state.alive--;
      const by = lastBy[f.idx];
      if (by >= 0 && by !== f.idx) {
        fighters[by].kills++;
        ev.push({ t: "kill", who: f.idx, by, weapon: lastWeapon[f.idx] });
        if (f.bounty) ev.push({ t: "bounty", who: f.idx, by });
      } else {
        ev.push({ t: "kill", who: f.idx, by: null, weapon: "storm" });
      }
    }
    if (state.alive === 1) finish(fighters.find((f) => f.alive)!.idx, ev);
  }

  function timeOut(ev: SimEvent[]) {
    const alive = fighters.filter((f) => f.alive).sort((a, b) => b.hp - a.hp || a.idx - b.idx);
    for (let i = alive.length - 1; i >= 1; i--) {
      const f = alive[i];
      f.alive = false;
      f.placement = i + 1;
      state.alive--;
    }
    finish(alive[0].idx, ev);
  }

  function openChest(f: FighterState, c: Chest, ev: SimEvent[]) {
    c.open = true;
    f.weapon = c.weapon;
    f.ammo = WEAPONS[c.weapon].mag;
    f.readyTick = Math.min(f.readyTick, state.tick + 4);
    ev.push({ t: "chest", who: f.idx, chest: c.id, weapon: c.weapon });
  }

  function takeHeal(f: FighterState, h: Heal, ev: SimEvent[]) {
    h.taken = true;
    const amt = Math.min(h.amount, f.maxHp - f.hp);
    f.hp += amt;
    ev.push({ t: "heal", who: f.idx, amount: amt });
  }

  function step(human: Map<number, Input>): SimEvent[] {
    if (state.over) return [];
    const ev: SimEvent[] = [];
    // 1. Controls, all decided from the same pre-step state.
    const inputs: Input[] = [];
    for (const f of fighters) {
      if (!f.alive) inputs.push(IDLE);
      else if (f.human) inputs.push(human.get(f.idx) ?? IDLE);
      else inputs.push(botInput(match, f.idx));
    }
    state.tick++;
    const t = state.tick;
    stepStorm(ev);
    // 2. Movement, collisions, pickups.
    for (const f of fighters) {
      if (!f.alive) continue;
      const inp = inputs[f.idx];
      moveFighter(f, inp);
      f.aim = (((Math.trunc(inp.aim) || 0) % 4096) + 4096) % 4096;
    }
    separate();
    for (const f of fighters) {
      if (!f.alive) continue;
      collide(f);
      for (const c of state.chests) {
        if (!c.open && dist2(f.x, f.y, c.x, c.y) <= sq(CHEST_R + FIGHTER_R)) openChest(f, c, ev);
      }
      if (f.hp < f.maxHp) {
        for (const h of state.heals) {
          if (!h.taken && f.hp < f.maxHp && dist2(f.x, f.y, h.x, h.y) <= sq(HEAL_R + FIGHTER_R)) takeHeal(f, h, ev);
        }
      }
      f.inBush = inBushAt(f.x, f.y);
    }
    // 3. Weapons (auto reload when empty).
    for (const f of fighters) {
      if (!f.alive) continue;
      if (f.ammo === 0 && t >= f.readyTick) f.ammo = WEAPONS[f.weapon].mag;
      if (inputs[f.idx].fire && t >= f.readyTick && f.ammo > 0) fire(f, f.aim, ev);
    }
    stepProjectiles(ev);
    if (t % REGEN_EVERY === 0) {
      for (const f of fighters) {
        if (f.alive && f.hp > 0 && f.hp < f.maxHp && t - f.lastHurtTick >= REGEN_DELAY && t - f.lastShotTick >= REGEN_DELAY)
          f.hp = Math.min(f.maxHp, f.hp + REGEN_HP);
      }
    }
    resolveDeaths(ev);
    if (!state.over && t >= MATCH_TICKS) timeOut(ev);
    return ev;
  }

  function hash(): string {
    let h1 = 0x811c9dc5, h2 = 0x050c5d1f;
    const put = (v: number) => {
      v = v | 0;
      for (let k = 0; k < 32; k += 8) {
        const b = (v >>> k) & 255;
        h1 = Math.imul(h1 ^ b, 16777619) >>> 0;
        h2 = Math.imul(h2 ^ (b ^ 0x5a), 16777619) >>> 0;
      }
    };
    const bool = (b: boolean) => put(b ? 1 : 0);
    put(state.tick);
    for (const f of fighters) {
      put(f.idx); put(f.x); put(f.y); put(f.aim); put(f.hp); put(f.maxHp); put(f.armor);
      put(WEAPON_ORDER.indexOf(f.weapon)); put(f.ammo); put(f.readyTick); bool(f.alive); bool(f.inBush);
      put(f.lastShotTick); put(f.lastHurtTick); put(f.kills); put(f.damageDealt); put(f.placement); bool(f.bounty);
    }
    put(state.projectiles.length);
    for (const p of state.projectiles) {
      put(p.id); put(p.owner); put(WEAPON_ORDER.indexOf(p.weapon)); put(p.x); put(p.y); put(p.vx); put(p.vy); put(p.ttl); put(p.dmg);
    }
    for (const c of state.chests) { put(c.id); bool(c.open); put(WEAPON_ORDER.indexOf(c.weapon)); }
    for (const hl of state.heals) { put(hl.id); bool(hl.taken); put(hl.amount); }
    put(storm.cx); put(storm.cy); put(storm.r); put(storm.targetR); put(storm.phase); put(storm.dps); put(storm.tx); put(storm.ty);
    put(fromCx); put(fromCy); put(fromR);
    put(state.alive); bool(state.over); put(state.winner ?? -1);
    put(rng.s); put(nextProj);
    for (let i = 0; i < FIGHTERS; i++) put(lastBy[i]);
    return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }

  const match: Match = { cfg, map, state, step, canSee, hash };
  return match;
}
