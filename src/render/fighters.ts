// Fighter views: skinned Kenney characters with blended animations, held weapon, ring, crown, name tag.
import * as THREE from "three";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import type { FighterState, WeaponKind } from "../sim/types";
import { WEAPON_MODEL, charFor, gltf, model } from "./assets";
import { FIGHTER_COLORS, PAL } from "./palette";
import { WEAPONS } from "../sim/rules";
import { reloadProgress } from "../ui/hud";

export const CHAR_SCALE = 2.8;

// cool fresnel rim (dusk lighting): one shared uniform + one shared program for every fighter material, no extra lights
const RIM = { value: new THREE.Color(PAL.rim).multiplyScalar(0.38) };
const rimCompile = (sh: THREE.WebGLProgramParametersWithUniforms) => {
  sh.uniforms.uRim = RIM;
  sh.fragmentShader = sh.fragmentShader
    .replace("#include <common>", "#include <common>\nuniform vec3 uRim;")
    .replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n  totalEmissiveRadiance += uRim * pow(1.0 - saturate(dot(normalize(vViewPosition), normal)), 3.5);",
    );
};
const rimKey = () => "fighter-rim";

interface ClipSet {
  idle: THREE.AnimationClip;
  walk: THREE.AnimationClip;
  sprint: THREE.AnimationClip;
  die: THREE.AnimationClip;
  hold: THREE.AnimationClip;
  shoot: THREE.AnimationClip;
  emote: THREE.AnimationClip;
}
const clipCache = new Map<string, ClipSet>();

function clipsFor(charName: string): ClipSet {
  let c = clipCache.get(charName);
  if (c) return c;
  const anims = gltf(`chars/${charName}`).animations;
  const get = (n: string) => anims.find((a) => a.name === n) ?? anims[0];
  const isArm = (t: THREE.KeyframeTrack) => t.name.startsWith("arm-right.");
  const without = (clip: THREE.AnimationClip) => new THREE.AnimationClip(clip.name + "-body", clip.duration, clip.tracks.filter((t) => !isArm(t)));
  const only = (clip: THREE.AnimationClip) => new THREE.AnimationClip(clip.name + "-arm", clip.duration, clip.tracks.filter(isArm));
  c = {
    idle: without(get("idle")),
    walk: without(get("walk")),
    sprint: without(get("sprint")),
    die: get("die"),
    hold: only(get("holding-right")),
    shoot: only(get("holding-right-shoot")),
    emote: get("emote-yes"),
  };
  clipCache.set(charName, c);
  return c;
}

const ringGeo = new THREE.RingGeometry(0.66, 0.74, 48).rotateX(-Math.PI / 2);
const ringFill = new THREE.CircleGeometry(0.62, 36).rotateX(-Math.PI / 2);
const crownGeo = (() => {
  const g = new THREE.CylinderGeometry(0.34, 0.28, 0.26, 5, 1, true);
  return g;
})();
const crownMat = new THREE.MeshStandardMaterial({ color: PAL.gold, emissive: 0xb07000, emissiveIntensity: 0.6, metalness: 0.2, roughness: 0.35, side: THREE.DoubleSide });
const gemGeo = new THREE.OctahedronGeometry(0.09, 0);
const gemMat = new THREE.MeshBasicMaterial({ color: 0xff3d6e });

// "this is you" markers: pulsing ground ring + a bobbing arrow above the head (first seconds of a match)
const youRingGeo = new THREE.RingGeometry(0.9, 1.05, 48).rotateX(-Math.PI / 2);
const youArrowGeo = (() => {
  const g = new THREE.ConeGeometry(0.34, 0.6, 4);
  g.rotateX(Math.PI); // tip down
  return g;
})();

type Loco = "idle" | "walk" | "sprint";

export class FighterView {
  readonly root = new THREE.Group();
  private body: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private acts: Record<keyof ClipSet, THREE.AnimationAction>;
  private loco: Loco = "idle";
  private hand: THREE.Object3D | null = null;
  private weaponObj: THREE.Object3D | null = null;
  private weaponKind: WeaponKind | null = null;
  private mats: THREE.MeshStandardMaterial[] = [];
  private flash = 0;
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  readonly crown: THREE.Group;
  dead = false;
  deadT = 0;
  shootT = 0;
  private yaw = 0;
  readonly color: number;
  /** interpolated world position (updated by the renderer) */
  readonly pos = new THREE.Vector3();
  readonly prev = new THREE.Vector2();
  readonly cur = new THREE.Vector2();
  prevAim = 0;
  curAim = 0;
  speed = 0;
  dustT = 0;
  tag: HTMLDivElement;
  tagHp: HTMLElement;
  tagAmmo: HTMLElement | null = null;
  private lastHpFrac = -1;
  private tagHidden: HTMLElement | null = null;
  private tagRl!: HTMLElement;
  private tagBv: HTMLElement | null = null;
  private wasRl = false;
  /** screen-space tag position, set by the game loop */
  tagX = -9999;
  tagY = 0;
  private wasHidden = false;
  private holdQ = new THREE.Quaternion();
  private youRing: THREE.Mesh | null = null;
  private youArrow: THREE.Mesh | null = null;
  private youTag: HTMLElement | null = null;
  private youShown = false;
  private youT = 0;

  constructor(readonly idx: number, f: FighterState, tagsEl: HTMLElement, skin = 0) {
    const charName = charFor(idx, skin);
    const src = gltf(`chars/${charName}`).scene;
    this.body = SkeletonUtils.clone(src);
    this.body.scale.setScalar(CHAR_SCALE);
    this.body.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        mat.emissive = new THREE.Color(0xffffff);
        mat.emissiveIntensity = 0;
        mat.onBeforeCompile = rimCompile;
        mat.customProgramCacheKey = rimKey;
        m.material = mat;
        this.mats.push(mat);
        m.castShadow = true;
        m.receiveShadow = false;
        m.frustumCulled = false; // skinned bounds are unreliable; 10 fighters only
      }
      if (o.name === "arm-right") this.hand = o;
    });
    this.root.add(this.body);

    const clips = clipsFor(charName);
    this.mixer = new THREE.AnimationMixer(this.body);
    this.acts = {
      idle: this.mixer.clipAction(clips.idle),
      walk: this.mixer.clipAction(clips.walk),
      sprint: this.mixer.clipAction(clips.sprint),
      die: this.mixer.clipAction(clips.die),
      hold: this.mixer.clipAction(clips.hold),
      shoot: this.mixer.clipAction(clips.shoot),
      emote: this.mixer.clipAction(clips.emote),
    };
    const ht = clips.hold.tracks.find((t) => t.name === "arm-right.quaternion");
    if (ht) this.holdQ.fromArray(ht.values as unknown as number[], 0);
    this.acts.die.setLoop(THREE.LoopOnce, 1);
    this.acts.die.clampWhenFinished = true;
    this.acts.shoot.setLoop(THREE.LoopOnce, 1);
    this.acts.idle.play();
    this.acts.hold.play();
    this.mixer.update(Math.random() * 2);

    this.color = idx === 0 ? PAL.me : FIGHTER_COLORS[idx % FIGHTER_COLORS.length];
    this.ringMat = new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: idx === 0 ? 0.55 : 0.8, depthWrite: false });
    this.ring = new THREE.Mesh(ringGeo, this.ringMat);
    this.ring.position.y = 0.13;
    this.ring.renderOrder = 2;
    this.root.add(this.ring);
    const fill = new THREE.Mesh(ringFill, new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: idx === 0 ? 0.05 : 0.18, depthWrite: false }));
    fill.position.y = 0.125;
    fill.renderOrder = 2;
    this.root.add(fill);

    if (idx === 0) {
      const ym = new THREE.MeshBasicMaterial({ color: PAL.me, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending });
      this.youRing = new THREE.Mesh(youRingGeo, ym);
      this.youRing.position.y = 0.15;
      this.youRing.renderOrder = 3;
      this.root.add(this.youRing);
      this.youArrow = new THREE.Mesh(youArrowGeo, new THREE.MeshBasicMaterial({ color: PAL.me, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false }));
      this.youArrow.renderOrder = 8;
      this.youArrow.position.y = 3.3;
      this.youArrow.visible = false;
      this.root.add(this.youArrow);
    }

    // bounty crown
    this.crown = new THREE.Group();
    const band = new THREE.Mesh(crownGeo, crownMat);
    this.crown.add(band);
    for (let k = 0; k < 5; k++) {
      const spike = new THREE.Mesh(gemGeo, crownMat);
      const a = (k / 5) * Math.PI * 2;
      spike.position.set(Math.cos(a) * 0.32, 0.2, Math.sin(a) * 0.32);
      spike.scale.set(0.9, 1.8, 0.9);
      this.crown.add(spike);
    }
    const gem = new THREE.Mesh(gemGeo, gemMat);
    gem.position.set(0, 0, 0.3);
    this.crown.add(gem);
    this.crown.position.y = 2.95;
    this.crown.visible = f.bounty;
    this.root.add(this.crown);

    this.setWeapon(f.weapon);

    // DOM tag
    this.tag = document.createElement("div");
    this.tag.className = "tag3d" + (idx === 0 ? " me" : "") + (f.bounty ? " bounty" : "");
    if (idx !== 0) {
      const nm = document.createElement("div");
      nm.className = "nm";
      nm.textContent = f.name;
      this.tag.appendChild(nm);
    }
    if (idx === 0) {
      this.youTag = document.createElement("div");
      this.youTag.className = "you";
      this.youTag.textContent = "YOU";
      this.youTag.style.display = "none";
      this.tag.appendChild(this.youTag);
      this.tagHidden = document.createElement("div");
      this.tagHidden.className = "hid";
      this.tagHidden.textContent = "HIDDEN";
      this.tag.appendChild(this.tagHidden);
    }
    const hpb = document.createElement("div");
    hpb.className = "hpb";
    this.tagHp = document.createElement("i");
    hpb.appendChild(this.tagHp);
    this.tag.appendChild(hpb);
    const rl = document.createElement("div");
    rl.className = "rl";
    this.tagRl = document.createElement("i");
    rl.appendChild(this.tagRl);
    this.tag.appendChild(rl);
    if (f.bounty) {
      this.tagBv = document.createElement("div");
      this.tagBv.className = "bv";
      this.tagBv.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/></svg><span></span>';
      this.tag.insertBefore(this.tagBv, this.tag.firstChild);
    }
    tagsEl.appendChild(this.tag);

    this.cur.set(f.x / 1000, f.y / 1000);
    this.prev.copy(this.cur);
    this.curAim = this.prevAim = f.aim;
    this.yaw = this.aimYaw(f.aim);
  }

  private aimYaw(aim: number) {
    const a = (aim / 4096) * Math.PI * 2;
    return Math.atan2(Math.cos(a), Math.sin(a));
  }

  setWeapon(kind: WeaponKind) {
    if (kind === this.weaponKind) return;
    this.weaponKind = kind;
    if (this.weaponObj) this.weaponObj.removeFromParent();
    if (!this.hand) return;
    const w = model(WEAPON_MODEL[kind]);
    // The arm bone points along -X; in the "holding-right" pose it is rotated toward the front.
    // Cancel that pose rotation so the weapon points along the character's forward (+Z).
    const inv = this.holdQ.clone().invert();
    if (kind === "grenade") {
      w.scale.setScalar(0.5);
      w.position.set(-0.16, -0.04, 0);
      w.quaternion.copy(inv);
    } else {
      w.scale.setScalar(0.36);
      w.position.set(-0.15, 0.0, 0.0);
      w.quaternion.copy(inv).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)); // barrels point -Z
      w.position.add(new THREE.Vector3(0, -0.02, 0.07).applyQuaternion(inv));
    }
    w.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = true;
    });
    this.hand.add(w);
    this.weaponObj = w;
  }

  /** world position of the muzzle (approx.) */
  muzzle(out: THREE.Vector3): THREE.Vector3 {
    const a = (this.curAim / 4096) * Math.PI * 2;
    return out.set(this.pos.x + Math.cos(a) * 0.95, 1.05, this.pos.z + Math.sin(a) * 0.95);
  }

  hit() {
    this.flash = 1;
  }

  shoot() {
    this.shootT = 0.25;
    const s = this.acts.shoot;
    s.reset();
    s.setEffectiveWeight(1);
    s.play();
    this.acts.hold.crossFadeTo(s, 0.04, false);
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.deadT = 0;
    for (const k of ["idle", "walk", "sprint", "hold", "shoot"] as const) this.acts[k].fadeOut(0.15);
    this.acts.die.reset().fadeIn(0.1).play();
    this.crown.visible = false;
  }

  celebrate() {
    if (this.dead) return;
    this.dead = true; // freezes locomotion; we keep the body visible
    this.deadT = -999;
    for (const k of ["idle", "walk", "sprint", "hold", "shoot"] as const) this.acts[k].fadeOut(0.2);
    this.acts.emote.reset().fadeIn(0.2).play();
    if (this.weaponObj) this.weaponObj.visible = false;
  }

  private setLoco(l: Loco) {
    if (l === this.loco || this.dead) return;
    const from = this.acts[this.loco], to = this.acts[l];
    to.reset().play();
    from.crossFadeTo(to, 0.18, true);
    this.loco = l;
  }

  private protFlicker = false;
  /** spawn protection: a faint ring flicker on bots (no bubble; the player gets no extra marker) */
  setShield(on: boolean, time: number) {
    const was = this.protFlicker;
    this.protFlicker = on && this.idx !== 0;
    if (was && !this.protFlicker && !this.dead) this.ringMat.opacity = 0.8;
    if (!this.protFlicker || this.dead) return;
    this.ringMat.opacity = 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(time * 14 + this.idx));
  }

  /** First seconds of a match: arrow above the head + "YOU" label (elapsed < 0 or > 10 hides them). */
  setYouMarker(on: boolean) {
    on = on && !this.dead;
    if (on === this.youShown) return;
    this.youShown = on;
    if (this.youArrow) this.youArrow.visible = on;
    if (this.youTag) this.youTag.style.display = on ? "block" : "none";
  }

  setBountyValue(v: number) {
    if (!this.tagBv) return;
    const sp = this.tagBv.querySelector("span")!;
    sp.textContent = v > 0 ? `WANTED · +${Math.round(v * 100) / 100} NOX` : "WANTED";
  }

  update(dt: number, alpha: number, f: FighterState, tick = 0) {
    const x = this.prev.x + (this.cur.x - this.prev.x) * alpha;
    const z = this.prev.y + (this.cur.y - this.prev.y) * alpha;
    const ox = this.pos.x, oz = this.pos.z;
    this.pos.set(x, 0, z);
    this.root.position.copy(this.pos);
    const sp = dt > 0 ? Math.hypot(x - ox, z - oz) / dt : 0;
    this.speed += (sp - this.speed) * Math.min(1, dt * 12);

    // aim: shortest-arc interpolation
    let d = this.curAim - this.prevAim;
    if (d > 2048) d -= 4096;
    if (d < -2048) d += 4096;
    const aim = this.prevAim + d * alpha;
    const targetYaw = this.aimYaw(aim);
    let dy = targetYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    if (!this.dead) this.yaw += dy * Math.min(1, dt * 22);
    this.body.rotation.y = this.yaw;

    if (!this.dead) {
      this.setLoco(this.speed < 0.4 ? "idle" : this.speed < 5.2 ? "walk" : "sprint");
      if (this.loco === "walk") this.acts.walk.timeScale = THREE.MathUtils.clamp(this.speed / 3, 0.7, 1.6);
      if (this.loco === "sprint") this.acts.sprint.timeScale = THREE.MathUtils.clamp(this.speed / 6, 0.8, 1.4);
      if (this.shootT > 0) {
        this.shootT -= dt;
        if (this.shootT <= 0) this.acts.shoot.crossFadeTo(this.acts.hold.reset().play(), 0.12, false);
      }
      this.setWeapon(f.weapon);
    } else {
      this.deadT += dt;
      if (this.deadT > 1.3) {
        const k = Math.min(1, (this.deadT - 1.3) / 0.6);
        this.body.position.y = -k * 1.2;
        this.ringMat.opacity = 0.8 * (1 - k);
        if (k >= 1) this.root.visible = false;
      }
    }
    this.mixer.update(dt);

    if (this.youRing) {
      this.youT += dt;
      const k = (this.youT * 0.9) % 1; // expanding ping every ~1.1 s
      const hot = this.youShown;
      this.youRing.scale.setScalar(0.85 + k * (hot ? 1.1 : 0.6));
      (this.youRing.material as THREE.MeshBasicMaterial).opacity = (hot ? 0.85 : 0) * (1 - k * k) * (this.dead ? 0 : 1);
      if (this.youArrow?.visible) this.youArrow.position.y = 3.3 + Math.sin(this.youT * 6) * 0.15;
    }

    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 7);
      for (const m of this.mats) m.emissiveIntensity = this.flash * 1.6;
    }
    if (f.bounty && !this.dead) {
      this.crown.visible = true;
      this.crown.rotation.y += dt * 1.5;
      this.crown.position.y = 2.95 + Math.sin(performance.now() * 0.004) * 0.08;
    }
    if (this.tagHidden) {
      const h = f.alive && f.inBush;
      if (h !== this.wasHidden) {
        this.wasHidden = h;
        this.tagHidden.style.visibility = h ? "visible" : "hidden";
      }
    }
    const rp = f.alive ? reloadProgress(f, tick) : null;
    const isRl = rp !== null;
    if (isRl !== this.wasRl) {
      this.wasRl = isRl;
      this.tag.classList.toggle("reloading", isRl);
    }
    if (isRl) this.tagRl.style.transform = `scaleX(${rp.toFixed(2)})`;
    const frac = Math.max(0, f.hp / Math.max(1, f.maxHp));
    if (frac !== this.lastHpFrac) {
      this.lastHpFrac = frac;
      this.tagHp.style.transform = `scaleX(${frac.toFixed(3)})`;
    }
  }

  dispose() {
    this.mixer.stopAllAction();
    this.root.removeFromParent();
    this.tag.remove();
    for (const m of this.mats) m.dispose();
    this.ringMat.dispose();
    if (this.youRing) (this.youRing.material as THREE.Material).dispose();
    if (this.youArrow) (this.youArrow.material as THREE.Material).dispose();
  }
}
