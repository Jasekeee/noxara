// Dev-only trailer camera: `?trailer[=mode]` (+ `&nohud`, `&ts=<timescale>`).
// Camera + time scale only — the simulation, rules and UI logic are untouched.
// Shots: game (the normal camera), fly (island fly-over), hero (low angle on the watched fighter),
// wanted (push-in on the bounty carrier), orbit (circles the last fighters), wide (high follow).
// Driven from the URL or at runtime through window.__trailer (for scripted captures).
import * as THREE from "three";

const q = new URLSearchParams(location.search);
export const TRAILER = q.has("trailer");

export type TrailerMode = "game" | "fly" | "hero" | "wanted" | "orbit" | "wide";
const MODES: TrailerMode[] = ["game", "fly", "hero", "wanted", "orbit", "wide"];
const asMode = (s: string | null): TrailerMode => (MODES.includes(s as TrailerMode) ? (s as TrailerMode) : "game");

let mode: TrailerMode = asMode(q.get("trailer"));
let modeT = 0;
let focus: number | null = null;
let baseScale = Math.max(0.05, Math.min(1, Number(q.get("ts") ?? 1) || 1));
let slowScale = 1;
let slowLeft = 0;
let spin = 1;

export interface TrailerFighter { x: number; z: number; alive: boolean; bounty: boolean }

if (TRAILER) {
  const root = document.documentElement;
  root.classList.add("trailer");
  if (q.has("nohud")) root.classList.add("trailer-nohud");
  const st = document.createElement("style");
  st.textContent =
    ".trailer, .trailer * { cursor: none !important; }" +
    ".trailer-nohud #hud, .trailer-nohud #tags, .trailer-nohud #floaters, .trailer-nohud #bounty-arrow, .trailer-nohud #touch { display: none !important; }";
  document.head.append(st);
  (window as unknown as { __trailer: unknown }).__trailer = {
    /** switch shot (restarts its move); dir = orbit/fly direction (1 or -1) */
    mode: (m: string, dir = 1) => { mode = asMode(m); modeT = 0; spin = dir < 0 ? -1 : 1; },
    /** time scale for `dur` real seconds (dur <= 0: until changed) */
    slow: (scale: number, dur = 0) => {
      const s = Math.max(0.05, Math.min(1, scale));
      if (dur > 0) { slowScale = s; slowLeft = dur; } else { baseScale = s; slowLeft = 0; slowScale = 1; }
    },
    /** fighter index the hero/orbit shots follow (null: the watched one) */
    focus: (i: number | null) => { focus = i; },
    hud: (on: boolean) => root.classList.toggle("trailer-nohud", !on),
    state: () => ({ mode, t: modeT, scale: currentScale() }),
  };
}

const currentScale = () => baseScale * (slowLeft > 0 ? slowScale : 1);

/** Multiplier for the game's time step (1 without ?trailer). */
export function trailerTimeScale(rdt: number): number {
  if (!TRAILER) return 1;
  if (slowLeft > 0) slowLeft -= rdt;
  return currentScale();
}

const look = new THREE.Vector3();
const sm = new THREE.Vector3();
/** smoothed subject point (no jumps when the followed fighter changes); snaps when a shot starts */
function follow(x: number, z: number, rdt: number, rate = 3): THREE.Vector3 {
  if (modeT <= rdt + 1e-6) sm.set(x, 0, z);
  else { const k = 1 - Math.exp(-rdt * rate); sm.x += (x - sm.x) * k; sm.z += (z - sm.z) * k; }
  return sm;
}
const ease = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

/**
 * Places the camera for the current trailer shot. Returns the distance + look point
 * (for fog / the shadow light), or null to leave the game's own camera in charge.
 */
export function trailerCamera(cam: THREE.PerspectiveCamera, rdt: number, fighters: TrailerFighter[], watch: number): { dist: number; look: THREE.Vector3 } | null {
  if (!TRAILER || mode === "game") return null;
  modeT += rdt;
  const t = modeT;
  const alive = fighters.filter((f) => f.alive);
  const pick = (i: number | null) => (i !== null && fighters[i] ? fighters[i] : null);
  const subject = pick(focus) ?? pick(watch) ?? alive[0] ?? null;
  let px = 0, py = 0, pz = 0;
  switch (mode) {
    case "fly": {
      // a slow descending arc across the island
      const a = 0.9 + spin * t * 0.07;
      const k = ease(t / 10);
      const r = 44 - k * 14, h = 30 - k * 12;
      look.set(Math.cos(a + 0.5 * spin) * 6, 0, Math.sin(a + 0.5 * spin) * 6);
      px = Math.cos(a) * r; py = h; pz = Math.sin(a) * r;
      break;
    }
    case "hero": {
      if (!subject) return null;
      const c = follow(subject.x, subject.z, rdt, 6);
      const a = 2.2 + spin * t * 0.18;
      look.set(c.x, 1.1, c.z);
      px = c.x + Math.cos(a) * 7; py = 2.0; pz = c.z + Math.sin(a) * 7;
      break;
    }
    case "wanted": {
      const b = fighters.find((f) => f.bounty && f.alive) ?? subject;
      if (!b) return null;
      const k = ease(t / 4.5);
      const d = 22 - k * 15;
      const c = follow(b.x, b.z, rdt, 6);
      look.set(c.x, 1.2 + k * 0.6, c.z);
      px = c.x + d * 0.35; py = 1.5 + d * 0.62; pz = c.z + d * 0.72;
      break;
    }
    case "orbit": {
      const g = alive.length <= 3 && alive.length > 0 ? alive : subject ? [subject] : [];
      if (!g.length) return null;
      let cx = 0, cz = 0;
      for (const f of g) { cx += f.x; cz += f.z; }
      cx /= g.length; cz /= g.length;
      let spread = 0;
      const raw = { x: cx, z: cz };
      for (const f of g) spread = Math.max(spread, Math.hypot(f.x - cx, f.z - cz));
      const c = follow(raw.x, raw.z, rdt, 2);
      cx = c.x; cz = c.z;
      const r = Math.max(9, spread * 1.4 + 7);
      const a = spin * t * 0.32;
      look.set(cx, 0.8, cz);
      px = cx + Math.cos(a) * r; py = r * 0.5; pz = cz + Math.sin(a) * r;
      break;
    }
    case "wide": {
      if (!subject) return null;
      const c = follow(subject.x, subject.z, rdt, 4);
      look.set(c.x, 0, c.z);
      px = c.x; py = 34; pz = c.z + 22;
      break;
    }
  }
  cam.position.set(px, py, pz);
  cam.lookAt(look);
  return { dist: cam.position.distanceTo(look), look };
}
