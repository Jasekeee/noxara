// Keyboard + mouse and twin-stick touch input -> sim Input (mx/my in -1000..1000, aim 0..4095).
// sim x = three.js x, sim y = three.js z. The camera looks toward -z, so "up" on screen is -y in the sim.
import * as THREE from "three";
import type { Input } from "../sim/types";

const TAU = Math.PI * 2;
const ASSIST_RAD = (8 * Math.PI) / 180; // manual aim within +-8 deg of a visible target snaps to it
const AUTO_IDLE_MS = 250; // click/space held with the mouse this still for this long = auto-aim
const MOUSE_MOVE_PX = 4;
const TAP_MS = 280; // a touch shorter than this that did not drag is a tap
const TAP_MAX_PX = 14;
const TAP_FIRE_MS = 160;
const ASSIST_KEY = "noxara.aimassist";

export interface AimTarget { x: number; z: number }

export function loadAimAssist(): boolean {
  try { return localStorage.getItem(ASSIST_KEY) !== "0"; } catch { return true; }
}
export function saveAimAssist(on: boolean) {
  try { localStorage.setItem(ASSIST_KEY, on ? "1" : "0"); } catch { /* private mode: keep in memory */ }
}

export class Controls {
  private keys = new Set<string>();
  private mouseNdc = new THREE.Vector2(0, 0);
  private mouseSeen = false;
  private mouseDown = false;
  private ray = new THREE.Raycaster();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1.0);
  private hitP = new THREE.Vector3();
  readonly aimWorld = new THREE.Vector3();
  touchMode = false;
  private stickL = { id: -1, ox: 0, oy: 0, dx: 0, dy: 0, t0: 0, maxd: 0 };
  private stickR = { id: -1, ox: 0, oy: 0, dx: 0, dy: 0, t0: 0, maxd: 0 };
  private lastAim = 0;
  private lastDist = 9000;
  /** world units a full right-stick deflection maps to (set per weapon by the game) */
  touchRange = 9;
  /** what the player has done so far (for the teach-by-playing hints) */
  readonly used = { move: false, aim: false, fire: false };
  enabled = false;
  /** menu open: ignore the player's controls (the match keeps running underneath) */
  blocked = false;
  /** Brawl-Stars-style aim help (input layer only: the sim still just receives an aim angle) */
  aimAssist = loadAimAssist();
  /** visible enemies within the current weapon's range, in world coords (filled by the game each tick) */
  targets: AimTarget[] = [];
  /** last aim used, for the preview line: radians, world distance, whether a target is locked */
  readonly preview = { active: false, ang: 0, dist: 0, locked: false, tx: 0, tz: 0 };
  private moveT = 0;
  private moveX = 0;
  private moveY = 0;
  private curX = 0;
  private curY = 0;
  private tapFireT = 0;
  private elL: HTMLElement;
  private elR: HTMLElement;
  private touchEl: HTMLElement;
  onMute: () => void = () => {};

  constructor(private canvas: HTMLCanvasElement, private camera: THREE.Camera) {
    this.touchEl = document.getElementById("touch")!;
    this.elL = document.getElementById("stick-l")!;
    this.elR = document.getElementById("stick-r")!;
    addEventListener("keydown", (e) => {
      if (e.code === "KeyM" && !e.repeat) this.onMute();
      if (!this.enabled) return;
      if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) {
        this.keys.add(e.code);
        e.preventDefault();
      }
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => { this.keys.clear(); this.mouseDown = false; });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    const app = document.getElementById("app")!;
    app.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse") {
        this.setMouse(e.clientX, e.clientY);
      } else this.touchMove(e);
    });
    app.addEventListener("pointerdown", (e) => {
      if (!this.enabled || this.blocked) return;
      if ((e.target as HTMLElement).closest("button")) return;
      if (e.pointerType === "mouse") {
        this.setTouchMode(false);
        this.setMouse(e.clientX, e.clientY);
        if (e.button === 0) { this.mouseDown = true; this.used.fire = true; }
      } else {
        this.setTouchMode(true);
        e.preventDefault();
        const left = e.clientX < innerWidth / 2;
        const s = left ? this.stickL : this.stickR;
        if (s.id !== -1) return;
        s.id = e.pointerId; s.ox = e.clientX; s.oy = e.clientY; s.dx = 0; s.dy = 0;
        if (!left) { this.stickR.t0 = performance.now(); this.stickR.maxd = 0; }
        const el = left ? this.elL : this.elR;
        el.style.left = `${e.clientX}px`;
        el.style.top = `${e.clientY}px`;
        el.classList.remove("idle");
        try { app.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
    });
    const up = (e: PointerEvent) => {
      if (e.pointerType === "mouse") { if (e.button === 0) this.mouseDown = false; return; }
      for (const [s, el] of [[this.stickL, this.elL], [this.stickR, this.elR]] as const) {
        if (s.id === e.pointerId) {
          if (s === this.stickR && e.type === "pointerup" && performance.now() - this.stickR.t0 < TAP_MS && this.stickR.maxd < TAP_MAX_PX) {
            this.tapFireT = performance.now() + TAP_FIRE_MS; // short tap = auto-aim shot
            this.used.fire = true;
          }
          s.id = -1; s.dx = 0; s.dy = 0;
          el.style.left = "";
          el.style.top = "";
          el.classList.add("idle");
          (el.firstElementChild as HTMLElement).style.transform = "";
        }
      }
    };
    app.addEventListener("pointerup", up);
    app.addEventListener("pointercancel", up);
    if (matchMedia("(pointer: coarse)").matches) this.setTouchMode(true);
  }

  private setTouchMode(on: boolean) {
    if (this.touchMode === on) return;
    this.touchMode = on;
    this.touchEl.classList.toggle("hidden", !on || !this.enabled);
  }
  setEnabled(on: boolean) {
    this.enabled = on;
    this.touchEl.classList.toggle("hidden", !on || !this.touchMode);
    if (!on) { this.keys.clear(); this.mouseDown = false; this.stickL.id = this.stickR.id = -1; }
  }

  private setMouse(x: number, y: number) {
    this.mouseNdc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    this.curX = x; this.curY = y;
    if (Math.hypot(x - this.moveX, y - this.moveY) > MOUSE_MOVE_PX) {
      this.moveX = x; this.moveY = y;
      this.moveT = performance.now();
    }
    if (this.mouseSeen) this.used.aim = true;
    this.mouseSeen = true;
  }

  private touchMove(e: PointerEvent) {
    for (const [s, el] of [[this.stickL, this.elL], [this.stickR, this.elR]] as const) {
      if (s.id !== e.pointerId) continue;
      let dx = e.clientX - s.ox, dy = e.clientY - s.oy;
      const max = 56, len = Math.hypot(dx, dy);
      if (s === this.stickR && len > s.maxd) s.maxd = len;
      if (len > max) { dx *= max / len; dy *= max / len; }
      s.dx = dx / max; s.dy = dy / max;
      (el.firstElementChild as HTMLElement).style.transform = `translate(${dx}px, ${dy}px)`;
    }
  }

  /** mouse position on the ground plane (y = gun height) */
  mouseGround(): THREE.Vector3 | null {
    this.ray.setFromCamera(this.mouseNdc, this.camera);
    return this.ray.ray.intersectPlane(this.ground, this.hitP);
  }

  /** nearest visible target to (px,pz), or null */
  private nearest(px: number, pz: number): { t: AimTarget; d: number } | null {
    let best: AimTarget | null = null, bd = Infinity;
    for (const t of this.targets) {
      const d = Math.hypot(t.x - px, t.z - pz);
      if (d < bd) { bd = d; best = t; }
    }
    return best ? { t: best, d: bd } : null;
  }

  /** the visible target whose bearing is closest to `ang` (within the assist cone), or null */
  private snapTarget(px: number, pz: number, ang: number): { t: AimTarget; d: number; a: number } | null {
    let best: { t: AimTarget; d: number; a: number } | null = null, bs = ASSIST_RAD;
    for (const t of this.targets) {
      const a = Math.atan2(t.z - pz, t.x - px);
      let diff = Math.abs(a - ang) % TAU;
      if (diff > Math.PI) diff = TAU - diff;
      if (diff <= bs) { bs = diff; best = { t, d: Math.hypot(t.x - px, t.z - pz), a }; }
    }
    return best;
  }

  /** Build this tick's input for a fighter at world position (px, pz). */
  read(px: number, pz: number, out: Input): Input {
    if (this.blocked) {
      out.mx = 0; out.my = 0; out.fire = false;
      this.preview.active = false;
      return out;
    }
    const now = performance.now();
    const pv = this.preview;
    pv.active = false; pv.locked = false;
    const lock = (t: AimTarget, ang: number, d: number) => {
      pv.locked = true; pv.tx = t.x; pv.tz = t.z; pv.ang = ang; pv.dist = d;
    };
    let mx = 0, my = 0;
    const k = this.keys;
    if (k.has("KeyA") || k.has("ArrowLeft")) mx -= 1000;
    if (k.has("KeyD") || k.has("ArrowRight")) mx += 1000;
    if (k.has("KeyW") || k.has("ArrowUp")) my -= 1000;
    if (k.has("KeyS") || k.has("ArrowDown")) my += 1000;
    let fire = this.mouseDown || k.has("Space");
    let aim = this.lastAim;
    let aimDist = this.lastDist;

    if (this.touchMode) {
      if (this.stickL.id !== -1 && Math.hypot(this.stickL.dx, this.stickL.dy) > 0.15) {
        mx = Math.round(this.stickL.dx * 1000);
        my = Math.round(this.stickL.dy * 1000);
      }
      const r = this.stickR;
      const rl = Math.hypot(r.dx, r.dy);
      if (r.id !== -1 && rl > 0.25) {
        aim = Math.round((Math.atan2(r.dy, r.dx) / TAU) * 4096) & 4095;
        aimDist = Math.round(Math.min(1, rl) * this.touchRange * 1000);
        fire = true;
        this.used.aim = this.used.fire = true;
        pv.active = true; pv.ang = Math.atan2(r.dy, r.dx); pv.dist = aimDist / 1000;
        if (this.aimAssist) {
          const sn = this.snapTarget(px, pz, pv.ang);
          if (sn) { aim = Math.round((sn.a / TAU) * 4096) & 4095; aimDist = Math.round(sn.d * 1000); lock(sn.t, sn.a, sn.d); }
        }
      } else if (now < this.tapFireT) {
        // short tap on the fire side: auto-aim at the nearest visible enemy in range
        fire = true;
        const n = this.nearest(px, pz);
        if (this.aimAssist && n) {
          const a = Math.atan2(n.t.z - pz, n.t.x - px);
          aim = Math.round((a / TAU) * 4096) & 4095; aimDist = Math.round(n.d * 1000);
          lock(n.t, a, n.d);
          pv.active = true; pv.ang = a; pv.dist = n.d;
        }
      } else if (mx !== 0 || my !== 0) {
        aim = Math.round((Math.atan2(my, mx) / TAU) * 4096) & 4095;
      }
    } else if (this.mouseSeen) {
      const g = this.mouseGround();
      if (g) {
        this.aimWorld.copy(g);
        const dx = g.x - px, dz = g.z - pz;
        if (dx * dx + dz * dz > 0.04) aim = Math.round((Math.atan2(dz, dx) / TAU) * 4096) & 4095;
        aimDist = Math.round(Math.hypot(dx, dz) * 1000);
        pv.active = true; pv.ang = Math.atan2(dz, dx); pv.dist = Math.hypot(dx, dz);
        if (this.aimAssist && fire) {
          if (now - this.moveT > AUTO_IDLE_MS) {
            // trigger held, mouse at rest: auto-aim the nearest visible enemy in range
            const n = this.nearest(px, pz);
            if (n) {
              const a = Math.atan2(n.t.z - pz, n.t.x - px);
              aim = Math.round((a / TAU) * 4096) & 4095; aimDist = Math.round(n.d * 1000);
              lock(n.t, a, n.d);
            }
          } else {
            const sn = this.snapTarget(px, pz, pv.ang);
            if (sn) { aim = Math.round((sn.a / TAU) * 4096) & 4095; aimDist = Math.round(sn.d * 1000); lock(sn.t, sn.a, sn.d); }
          }
        } else if (this.aimAssist && !this.touchMode) {
          // not firing: show where a shot would snap
          const sn = this.snapTarget(px, pz, pv.ang);
          if (sn) lock(sn.t, sn.a, sn.d);
        }
      }
    }
    if (mx !== 0 || my !== 0) this.used.move = true;
    this.lastAim = aim;
    this.lastDist = aimDist;
    out.aimDist = aimDist;
    out.mx = Math.max(-1000, Math.min(1000, mx));
    out.my = Math.max(-1000, Math.min(1000, my));
    out.aim = aim;
    out.fire = fire;
    if (pv.locked) { pv.ang = (aim / 4096) * TAU; pv.dist = out.aimDist ? out.aimDist / 1000 : pv.dist; }
    return out;
  }
}
