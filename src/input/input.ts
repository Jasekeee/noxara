// Keyboard + mouse and twin-stick touch input -> sim Input (mx/my in -1000..1000, aim 0..4095).
// sim x = three.js x, sim y = three.js z. The camera looks toward -z, so "up" on screen is -y in the sim.
import * as THREE from "three";
import type { Input } from "../sim/types";

const TAU = Math.PI * 2;

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
  /** current manual aim for the preview: radians + world distance, only while aiming */
  readonly preview = { active: false, ang: 0, dist: 0 };
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

  /** Build this tick's input for a fighter at world position (px, pz). */
  read(px: number, pz: number, out: Input): Input {
    if (this.blocked) {
      out.mx = 0; out.my = 0; out.fire = false;
      this.preview.active = false;
      return out;
    }
    const pv = this.preview;
    pv.active = false;
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
    return out;
  }
}
