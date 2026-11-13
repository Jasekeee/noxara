// BOUNTY ROYALE client: fixed-step simulation (TICK_HZ) + interpolated Three.js rendering + juice.
import * as THREE from "three";
import { FIGHTERS, TICK_HZ, type Input, type Match, type MatchRecord, type SimEvent } from "./sim/types";
import { createMatch } from "./sim/match";
import { botInput } from "./sim/ai";
import { Recorder } from "./sim/record";
import { t1Roster } from "./sim/roster";
import { loadAll } from "./render/assets";
import { makeWater, World } from "./render/world";
import { FighterView } from "./render/fighters";
import { Fx } from "./render/fx";
import { makeWeaponIcons } from "./render/icons";
import { BOLT_COLOR, PAL, WEAPON_LABEL } from "./render/palette";
import { Controls } from "./input/input";
import { Hud } from "./ui/hud";
import { sfx } from "./audio/sfx";

const U = 1 / 1000;
const DT = 1 / TICK_HZ;
const params = new URLSearchParams(location.search);
const E2E = params.has("e2e");
const AUTOPLAY = params.has("autoplay");
const SKIP_TITLE = params.get("bots") === "1";
const SPEED = Math.max(0.25, Math.min(16, Number(params.get("speed") ?? 1) || 1));
const $ = (id: string) => document.getElementById(id)!;

// ------------------------------------------------------------------ renderer + scene
const canvas = $("view") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(PAL.sky);
scene.fog = new THREE.Fog(PAL.fog, 48, 115);

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.5, 300);
const hemi = new THREE.HemisphereLight(PAL.hemiSky, PAL.hemiGround, 1.25);
scene.add(hemi);
const sun = new THREE.DirectionalLight(PAL.sun, 2.1);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -22; sc.right = 22; sc.top = 22; sc.bottom = -22; sc.near = 1; sc.far = 80;
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

const water = makeWater();
scene.add(water.mesh);
const fx = new Fx(scene);
const hud = new Hud();
const controls = new Controls(canvas, camera);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

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
const humanInput: Input = { mx: 0, my: 0, aim: 0, fire: false };
const inputs = new Map<number, Input>();
const killerOf = new Map<number, number | null>();

// camera rig
const camTarget = new THREE.Vector3();
const camLook = new THREE.Vector3();
let trauma = 0;
const PITCH = THREE.MathUtils.degToRad(52);

function seedFromUrl(): number {
  const s = params.get("seed");
  if (s !== null && /^\d+$/.test(s)) return Number(s) >>> 0;
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}

function buildMatch(seed: number) {
  if (world) world.dispose();
  for (const v of views) v.dispose();
  fx.clear();
  match = createMatch({ seed, fighters: t1Roster() });
  world = new World(match);
  world.onBurst = (x, z, kind) => (kind === "chest" ? fx.chestBurst(x, z) : fx.healBurst(x, z));
  scene.add(world.group);
  water.uniforms.uR.value = world.radius;
  const tags = $("tags");
  views = match.state.fighters.map((f, i) => {
    const v = new FighterView(i, f, tags);
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

function startMatch() {
  sfx.start();
  sfx.ui();
  buildMatch(seedFromUrl());
  phase = "playing";
  matchStartT = time;
  $("title").classList.add("hidden");
  $("end").classList.add("hidden");
  $("hud").classList.remove("hidden");
  hud.reset();
  controls.setEnabled(true);
  if (!AUTOPLAY) hud.showHints(controls.touchMode);
  canvas.focus();
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
  return i === 0 ? "You" : match.state.fighters[i].name;
}

// ------------------------------------------------------------------ events
const _v3 = new THREE.Vector3();
function onEvents(evs: SimEvent[]) {
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
        fx.impact(x, 1.1, z, BOLT_COLOR[st.fighters[e.by]?.weapon ?? "popper"], e.crit);
        const mine = e.by === 0, me = e.who === 0;
        if (mine || me || canSeeNow(e.who)) hud.floater(String(Math.round(e.dmg)), v.pos.x, 3.1, v.pos.z, (e.crit ? "crit " : "") + (me ? "me" : ""));
        if (mine) {
          const p = project(v.pos.x, 1.2, v.pos.z);
          if (p) hud.hitMark(p.x, p.y, false);
        }
        if (me) {
          hud.hurtFlash();
          sfx.hurt();
          shake(0.28);
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
        hud.feedItem(nameOf(e.by), nameOf(e.who)!, e.weapon, { me: e.by === 0 || e.who === 0, bounty: f.bounty });
        if (e.by === 0) {
          sfx.kill(true);
          hud.banner(`ELIMINATED ${f.name.toUpperCase()}`, "hot");
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
      case "bounty":
        hud.banner(`${nameOf(e.by)!.toUpperCase()} CLAIMED THE BOUNTY!`, "gold");
        sfx.chest();
        break;
      case "chest":
        if (e.who === 0) {
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
      case "win":
        if (e.who === 0) sfx.victory();
        slow(0.3, 1.0);
        break;
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
    controls.read(views[0].pos.x, views[0].pos.z, humanInput);
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
    setTimeout(() => showEnd(true), 1400);
  }
}

// ------------------------------------------------------------------ end / death card
function showEnd(final: boolean) {
  if (!match) return;
  const me = match.state.fighters[0];
  if (!final && endShown) return;
  endShown = true;
  const el = $("end");
  const won = match.state.winner === 0 || (me.alive && match.state.over);
  const place = me.placement || (me.alive ? 1 : FIGHTERS);
  el.classList.toggle("win", won);
  $("end-place").textContent = `#${place}`;
  $("end-title").textContent = won ? "LAST ONE STANDING" : "ELIMINATED";
  const killer = killerOf.get(0);
  $("end-sub").textContent = won ? `of ${FIGHTERS} — the bounty is yours` : killer != null ? `of ${FIGHTERS} — taken out by ${nameOf(killer)}` : killerOf.has(0) ? `of ${FIGHTERS} — lost to the storm` : `of ${FIGHTERS}`;
  $("end-kills").textContent = String(me.kills);
  $("end-dmg").textContent = String(Math.round(me.damageDealt));
  const surv = Math.round(((me.alive ? match.state.tick : lastTickAlive) / TICK_HZ));
  $("end-time").textContent = `${Math.floor(surv / 60)}:${String(surv % 60).padStart(2, "0")}`;
  $("spectate").classList.toggle("hidden", match.state.over);
  el.classList.remove("hidden");
  controls.setEnabled(false);
  ($("again") as HTMLButtonElement).focus();
}
let lastTickAlive = 0;

$("again").addEventListener("click", () => startMatch());
$("spectate").addEventListener("click", () => {
  sfx.ui();
  spectating = true;
  $("end").classList.add("hidden");
});
$("play").addEventListener("click", () => startMatch());
const muteBtn = $("mute");
function toggleMute() {
  const m = sfx.toggleMute();
  muteBtn.classList.toggle("muted", m);
  muteBtn.setAttribute("aria-pressed", String(m));
}
muteBtn.addEventListener("click", toggleMute);
controls.onMute = toggleMute;

// ------------------------------------------------------------------ frame loop
let last = performance.now();
const fpsBuf = new Float32Array(60);
let fpsI = 0;
let fpsVal = 0;
let miniT = 0;
const shakeOff = new THREE.Vector3();
const visibleNow = (i: number) => canSeeNow(i);

function frame(now: number) {
  requestAnimationFrame(frame);
  let rdt = (now - last) / 1000;
  last = now;
  if (rdt > 0.25) rdt = 0.25;
  fpsBuf[fpsI++ % 60] = rdt;
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

  if (match && (phase === "playing" || phase === "over")) {
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
    if (meDeadAt >= 0 && !endShown && time - meDeadAt > 1.8 && !AUTOPLAY) showEnd(false);

    // fighters
    const rustlers: { x: number; z: number }[] = [];
    for (const f of st.fighters) {
      const v = views[f.idx];
      v.update(dt, alpha, f);
      const vis = f.idx === 0 || !f.alive || canSeeNow(f.idx) || v.dead;
      v.root.visible = vis && !(v.dead && v.deadT > 1.9);
      if (!vis && f.alive && v.speed > 0.5) rustlers.push({ x: v.pos.x, z: v.pos.z });
      // footstep dust
      if (vis && f.alive && v.speed > 1.5) {
        v.dustT -= dt;
        if (v.dustT <= 0) { fx.dust(v.pos.x, v.pos.z); v.dustT = v.speed > 5 ? 0.16 : 0.26; }
      }
      // name tag
      const showTag = vis && f.alive && phase !== "title";
      const p = showTag ? project(v.pos.x, 2.5, v.pos.z) : null;
      if (p) v.tag.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
      else if (v.tag.style.transform !== "translate(-9999px, 0px)") v.tag.style.transform = "translate(-9999px, 0px)";
    }
    // local player in bush: semi-transparent self too
    world.update(dt, time, me.alive ? { x: views[0].pos.x, z: views[0].pos.z, inBush: me.inBush } : null, rustlers);

    // storm effects for the local player
    const dx = me.x - st.storm.cx, dy = me.y - st.storm.cy;
    if (me.alive && phase === "playing" && dx * dx + dy * dy > st.storm.r * st.storm.r) {
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

    if (phase !== "title") {
      hud.update(match, me, st.fighters[watch]);
      hud.updateHints(controls.used, time - matchStartT);
      miniT -= rdt;
      if (miniT <= 0) { hud.minimap(match, 0, visibleNow); miniT = 0.1; }
    }
  }

  // camera placement
  const portrait = camera.aspect < 1;
  let dist = portrait ? 34 + (1 - camera.aspect) * 14 : 30;
  if (phase === "title") {
    const a = time * 0.06;
    dist = 46;
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
  sun.position.set(camTarget.x + 12, 30, camTarget.z + 8);
  sun.target.position.set(camTarget.x, 0, camTarget.z);

  water.uniforms.uTime.value = time;
  fx.update(dt, alpha, time);
  hud.updateFloaters(rdt, project);
  renderer.render(scene, camera);
}

// ------------------------------------------------------------------ boot
async function boot() {
  const fill = $("loadfill");
  await loadAll((p) => (fill.style.width = `${Math.round(p * 100)}%`));
  hud.icons = makeWeaponIcons(renderer);
  buildMatch(seedFromUrl());
  const play = $("play") as HTMLButtonElement;
  play.disabled = false;
  play.textContent = "PLAY";
  $("loadfill").parentElement!.classList.add("done");
  if (SKIP_TITLE || AUTOPLAY) startMatch();
  else play.focus();
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
  };
}

requestAnimationFrame(frame);
boot().catch((err) => {
  console.error(err);
  const play = $("play") as HTMLButtonElement;
  play.textContent = "FAILED TO LOAD";
});

