// Pooled effects: particles, bolts + trails, grenades, muzzle flashes, explosions, point-light pool.
// No allocations in the per-frame paths.
import * as THREE from "three";
import type { Projectile, WeaponKind } from "../sim/types";
import { BOLT_COLOR } from "./palette";
import { model, WEAPON_MODEL } from "./assets";
import { glowTex } from "./world";

const U = 1 / 1000;
const MAX_P = 700;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _e = new THREE.Euler();

export class Particles {
  readonly mesh: THREE.InstancedMesh;
  private px = new Float32Array(MAX_P);
  private py = new Float32Array(MAX_P);
  private pz = new Float32Array(MAX_P);
  private vx = new Float32Array(MAX_P);
  private vy = new Float32Array(MAX_P);
  private vz = new Float32Array(MAX_P);
  private life = new Float32Array(MAX_P);
  private max = new Float32Array(MAX_P);
  private size = new Float32Array(MAX_P);
  private grav = new Float32Array(MAX_P);
  private drag = new Float32Array(MAX_P);
  private rot = new Float32Array(MAX_P);
  private next = 0;

  constructor() {
    const geo = new THREE.IcosahedronGeometry(0.5, 0);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_P);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = MAX_P;
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < MAX_P; i++) {
      this.mesh.setMatrixAt(i, _m);
      this.mesh.setColorAt(i, _c.set(0xffffff));
    }
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, color: number, grav = 0, drag = 2) {
    const i = this.next;
    this.next = (this.next + 1) % MAX_P;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life; this.max[i] = life; this.size[i] = size; this.grav[i] = grav; this.drag[i] = drag;
    this.rot[i] = Math.random() * 6;
    this.mesh.setColorAt(i, _c.set(color));
    this.mesh.instanceColor!.needsUpdate = true;
  }

  burst(x: number, y: number, z: number, n: number, speed: number, up: number, life: number, size: number, color: number, grav = -12, drag = 1.5) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.emit(x, y, z, Math.cos(a) * s, up * (0.5 + Math.random() * 0.8), Math.sin(a) * s, life * (0.6 + Math.random() * 0.6), size * (0.6 + Math.random() * 0.7), color, grav, drag);
    }
  }

  update(dt: number) {
    for (let i = 0; i < MAX_P; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        _m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _m);
        continue;
      }
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= dr; this.vz[i] *= dr; this.vy[i] = this.vy[i] * dr + this.grav[i] * dt;
      this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
      if (this.py[i] < 0.05) { this.py[i] = 0.05; this.vy[i] *= -0.3; }
      const k = this.life[i] / this.max[i];
      const s = this.size[i] * (k < 0.7 ? k / 0.7 : 1);
      this.rot[i] += dt * 3;
      _q.setFromEuler(_e.set(this.rot[i], this.rot[i] * 0.7, 0));
      _m.compose(_v.set(this.px[i], this.py[i], this.pz[i]), _q, _s.set(s, s, s));
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** A small pool of point lights that always exist (so the shader light count never changes). */
export class LightPool {
  readonly lights: THREE.PointLight[] = [];
  private t: number[] = [];
  private dur: number[] = [];
  private peak: number[] = [];
  private i = 0;
  constructor(scene: THREE.Scene, n = 3) {
    for (let k = 0; k < n; k++) {
      const l = new THREE.PointLight(0xffffff, 0, 7, 1.6);
      l.castShadow = false;
      scene.add(l);
      this.lights.push(l);
      this.t.push(0);
      this.dur.push(1);
      this.peak.push(0);
    }
  }
  flash(x: number, y: number, z: number, color: number, intensity: number, dist: number, dur: number) {
    const k = this.i;
    this.i = (this.i + 1) % this.lights.length;
    const l = this.lights[k];
    l.position.set(x, y, z);
    l.color.set(color);
    l.distance = dist;
    this.t[k] = dur;
    this.dur[k] = dur;
    this.peak[k] = intensity;
  }
  update(dt: number) {
    for (let k = 0; k < this.lights.length; k++) {
      if (this.t[k] > 0) {
        this.t[k] = Math.max(0, this.t[k] - dt);
        this.lights[k].intensity = this.peak[k] * (this.t[k] / this.dur[k]);
      } else this.lights[k].intensity = 0;
    }
  }
}

interface Spr { s: THREE.Sprite; t: number; dur: number; size: number; grow: number }
class SpritePool {
  private items: Spr[] = [];
  private i = 0;
  constructor(scene: THREE.Scene, n: number, tex: THREE.Texture) {
    for (let k = 0; k < n; k++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      s.visible = false;
      s.renderOrder = 10;
      scene.add(s);
      this.items.push({ s, t: 0, dur: 1, size: 1, grow: 0 });
    }
  }
  spawn(x: number, y: number, z: number, color: number, size: number, dur: number, grow = 0, rot = 0) {
    const it = this.items[this.i];
    this.i = (this.i + 1) % this.items.length;
    it.s.position.set(x, y, z);
    (it.s.material as THREE.SpriteMaterial).color.set(color);
    (it.s.material as THREE.SpriteMaterial).rotation = rot;
    it.t = dur; it.dur = dur; it.size = size; it.grow = grow;
    it.s.visible = true;
  }
  update(dt: number) {
    for (const it of this.items) {
      if (!it.s.visible) continue;
      it.t -= dt;
      if (it.t <= 0) { it.s.visible = false; continue; }
      const k = it.t / it.dur;
      it.s.scale.setScalar(it.size * (1 + (1 - k) * it.grow));
      (it.s.material as THREE.SpriteMaterial).opacity = k;
    }
  }
}

const starTex = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,.8)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g;
  x.beginPath();
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2, r = k % 2 ? 11 : 32;
    x.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
  }
  x.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

interface Ring { m: THREE.Mesh; t: number; dur: number; r: number }

interface BoltView {
  g: THREE.Group;
  core: THREE.Mesh;
  trail: THREE.Mesh;
  grenade: THREE.Object3D | null;
  kind: WeaponKind | null;
  id: number;
  seen: number;
  px: number; pz: number; cx: number; cz: number;
  ttl0: number; ttlPrev: number; ttlCur: number;
}

const boltGeo = new THREE.SphereGeometry(0.2, 8, 6).scale(1, 1, 2.4);
const trailGeo = (() => {
  const g = new THREE.CylinderGeometry(0.13, 0.0, 1, 6, 1, true);
  g.translate(0, -0.5, 0);
  g.rotateX(Math.PI / 2);
  return g;
})();

export class Fx {
  readonly particles = new Particles();
  readonly lights: LightPool;
  private flashes: SpritePool;
  private glows: SpritePool;
  private rings: Ring[] = [];
  private ringI = 0;
  private bolts: BoltView[] = [];
  private byId = new Map<number, BoltView>();
  private frame = 0;
  private boltGlow = new Map<WeaponKind, THREE.SpriteMaterial>();
  private boltMats = new Map<WeaponKind, { core: THREE.MeshBasicMaterial; trail: THREE.MeshBasicMaterial }>();

  constructor(private scene: THREE.Scene) {
    scene.add(this.particles.mesh);
    this.lights = new LightPool(scene, 3);
    this.flashes = new SpritePool(scene, 16, starTex);
    this.glows = new SpritePool(scene, 10, glowTex);
    const ringGeo = new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2);
    for (let k = 0; k < 6; k++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      m.visible = false;
      m.position.y = 0.12;
      scene.add(m);
      this.rings.push({ m, t: 0, dur: 1, r: 1 });
    }
    for (const k of ["popper", "blaster", "shotgun", "sniper", "grenade"] as WeaponKind[]) {
      this.boltGlow.set(k, new THREE.SpriteMaterial({ map: glowTex, color: BOLT_COLOR[k], transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
      this.boltMats.set(k, {
        core: new THREE.MeshBasicMaterial({ color: new THREE.Color(BOLT_COLOR[k]).multiplyScalar(1.6), toneMapped: false }),
        trail: new THREE.MeshBasicMaterial({ color: BOLT_COLOR[k], transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false }),
      });
    }
  }

  // ---------------------------------------------------------------- one-shots
  muzzle(x: number, y: number, z: number, kind: WeaponKind) {
    const c = BOLT_COLOR[kind];
    const big = kind === "shotgun" || kind === "sniper";
    this.flashes.spawn(x, y, z, c, big ? 1.5 : 1.05, 0.07, 0.6, Math.random() * 6);
    this.flashes.spawn(x, y, z, 0xffffff, big ? 0.7 : 0.5, 0.05, 0.3, Math.random() * 6);
    this.lights.flash(x, y + 0.3, z, c, big ? 30 : 18, 7, 0.08);
    for (let k = 0; k < 3; k++) this.particles.emit(x, y, z, (Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3, 0.18, 0.12, c, 0, 4);
  }

  impact(x: number, y: number, z: number, color: number, crit: boolean) {
    this.flashes.spawn(x, y, z, 0xffffff, crit ? 1.4 : 0.9, 0.08, 0.5, Math.random() * 6);
    this.particles.burst(x, y, z, crit ? 12 : 7, 5, 4, 0.35, 0.16, color, -10, 2);
  }

  spark(x: number, z: number, color: number) {
    this.particles.burst(x, 1, z, 4, 3, 2, 0.25, 0.1, color, -8, 2);
  }

  explode(x: number, z: number, r: number) {
    this.lights.flash(x, 1.5, z, 0xffa040, 120, r * 3.5, 0.35);
    this.glows.spawn(x, 1, z, 0xffd27a, r * 2.4, 0.3, 0.5);
    this.flashes.spawn(x, 1.2, z, 0xffffff, r * 2.2, 0.12, 0.4, Math.random() * 6);
    this.ring(x, z, r, 0xffb04a, 0.45);
    this.ring(x, z, r * 0.6, 0xffffff, 0.25);
    this.particles.burst(x, 0.6, z, 26, r * 5, 9, 0.8, 0.32, 0xff8a2a, -16, 1.2);
    this.particles.burst(x, 0.6, z, 14, r * 3, 5, 0.9, 0.28, 0xffe07a, -12, 1.5);
    for (let k = 0; k < 12; k++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * r * 0.7;
      this.particles.emit(x + Math.cos(a) * d, 0.5, z + Math.sin(a) * d, Math.cos(a) * 1.5, 2.2 + Math.random(), Math.sin(a) * 1.5, 1.3, 0.7 + Math.random() * 0.4, 0xcfc8da, 0.6, 1.8);
    }
  }

  ring(x: number, z: number, r: number, color: number, dur: number) {
    const it = this.rings[this.ringI];
    this.ringI = (this.ringI + 1) % this.rings.length;
    it.m.position.x = x;
    it.m.position.z = z;
    (it.m.material as THREE.MeshBasicMaterial).color.set(color);
    it.t = dur; it.dur = dur; it.r = r;
    it.m.visible = true;
  }

  poof(x: number, z: number, color: number) {
    this.particles.burst(x, 0.8, z, 16, 3.5, 4, 0.9, 0.45, 0xf4f1ff, -2, 2.5);
    this.particles.burst(x, 1, z, 10, 5, 6, 0.6, 0.18, color, -14, 1);
    this.ring(x, z, 1.6, color, 0.35);
  }

  dust(x: number, z: number) {
    this.particles.emit(x + (Math.random() - 0.5) * 0.3, 0.12, z + (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.8, 0.7 + Math.random() * 0.5, (Math.random() - 0.5) * 0.8, 0.45, 0.22 + Math.random() * 0.1, 0xe9dcc0, -0.5, 2.5);
  }

  chestBurst(x: number, z: number) {
    this.particles.burst(x, 0.8, z, 22, 4.5, 9, 0.9, 0.18, 0xffc93c, -16, 1);
    this.particles.burst(x, 0.6, z, 10, 2.5, 4, 0.7, 0.3, 0xa58358, -14, 1.5);
    this.flashes.spawn(x, 1, z, 0xffe7a0, 2.6, 0.25, 0.6, 0);
    this.ring(x, z, 2, 0xffc93c, 0.4);
    this.lights.flash(x, 1.5, z, 0xffc93c, 40, 8, 0.3);
  }

  confetti(x: number, z: number) {
    const cols = [0xffc93c, 0x3df2ff, 0xff4d6d, 0x9be15d, 0xb46cff, 0xffffff];
    for (let k = 0; k < 90; k++) {
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 5;
      this.particles.emit(x, 2, z, Math.cos(a) * s, 6 + Math.random() * 8, Math.sin(a) * s, 2.2 + Math.random(), 0.14 + Math.random() * 0.08, cols[k % cols.length], -7, 1.2);
    }
    this.ring(x, z, 4, 0xffc93c, 0.8);
    this.lights.flash(x, 2, z, 0xffc93c, 60, 10, 1);
  }

  healBurst(x: number, z: number) {
    this.particles.burst(x, 0.8, z, 14, 2.5, 6, 0.8, 0.16, 0x6dff8a, -4, 1.5);
    this.ring(x, z, 1.4, 0x6dff8a, 0.4);
  }

  // ---------------------------------------------------------------- projectiles
  /** Called after every sim step with the new projectile list. */
  syncProjectiles(list: readonly Projectile[]) {
    this.frame++;
    for (const p of list) {
      let v = this.byId.get(p.id);
      const x = p.x * U, z = p.y * U;
      if (!v) {
        v = this.alloc(p.weapon);
        v.id = p.id;
        v.px = x - p.vx * U;
        v.pz = z - p.vy * U;
        v.ttl0 = p.ttl + 1;
        v.ttlPrev = p.ttl + 1;
        this.byId.set(p.id, v);
      } else {
        v.px = v.cx;
        v.pz = v.cz;
        v.ttlPrev = v.ttlCur;
      }
      v.cx = x;
      v.cz = z;
      v.ttlCur = p.ttl;
      v.seen = this.frame;
      const ang = Math.atan2(p.vx, p.vy);
      v.g.rotation.y = ang;
      const sp = Math.hypot(p.vx, p.vy) * U;
      v.trail.scale.set(1, 1, Math.min(4, sp * 1.6));
    }
    for (const v of this.bolts) {
      if (v.id >= 0 && v.seen !== this.frame) {
        // expired: small spark where it ended (grenades explode via the explode event)
        if (v.kind !== "grenade") this.spark(v.cx, v.cz, BOLT_COLOR[v.kind ?? "popper"]);
        this.byId.delete(v.id);
        v.id = -1;
        v.g.visible = false;
      }
    }
  }

  private alloc(kind: WeaponKind): BoltView {
    let v = this.bolts.find((b) => b.id < 0 && b.kind === kind);
    if (!v) {
      const g = new THREE.Group();
      const mats = this.boltMats.get(kind)!;
      const core = new THREE.Mesh(boltGeo, mats.core);
      const trail = new THREE.Mesh(trailGeo, mats.trail);
      const glow = new THREE.Sprite(this.boltGlow.get(kind)!);
      glow.scale.setScalar(kind === "sniper" ? 1.3 : 0.95);
      g.add(core, trail, glow);
      let grenade: THREE.Object3D | null = null;
      if (kind === "grenade") {
        grenade = model(WEAPON_MODEL.grenade);
        grenade.scale.setScalar(1.6);
        core.visible = false;
        trail.visible = false;
        glow.visible = false;
        g.add(grenade);
      }
      this.scene.add(g);
      v = { g, core, trail, grenade, kind, id: -1, seen: 0, px: 0, pz: 0, cx: 0, cz: 0, ttl0: 1, ttlPrev: 1, ttlCur: 1 };
      this.bolts.push(v);
    }
    v.g.visible = true;
    return v;
  }

  update(dt: number, alpha: number, time: number) {
    for (const v of this.bolts) {
      if (v.id < 0) continue;
      const x = v.px + (v.cx - v.px) * alpha, z = v.pz + (v.cz - v.pz) * alpha;
      let y = 1.0;
      if (v.grenade) {
        const ttl = v.ttlPrev + (v.ttlCur - v.ttlPrev) * alpha;
        const t = 1 - ttl / Math.max(1, v.ttl0);
        y = 0.6 + 4 * 3.2 * t * (1 - t);
        v.grenade.rotation.x = time * 12;
        if (Math.random() < 0.5) this.particles.emit(x, y, z, 0, 0.3, 0, 0.35, 0.16, 0xd9d4e8, 0, 2);
      }
      v.g.position.set(x, y, z);
    }
    this.particles.update(dt);
    this.lights.update(dt);
    this.flashes.update(dt);
    this.glows.update(dt);
    for (const it of this.rings) {
      if (!it.m.visible) continue;
      it.t -= dt;
      if (it.t <= 0) { it.m.visible = false; continue; }
      const k = 1 - it.t / it.dur;
      const r = it.r * (0.2 + 0.8 * (1 - (1 - k) * (1 - k)));
      it.m.scale.set(r, 1, r);
      (it.m.material as THREE.MeshBasicMaterial).opacity = 1 - k;
    }
  }

  clear() {
    for (const v of this.bolts) { v.id = -1; v.g.visible = false; }
    this.byId.clear();
  }
}
