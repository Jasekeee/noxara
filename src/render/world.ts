// Island, water, obstacles, bushes, chests, heals, storm. Static per match; animated per frame.
import * as THREE from "three";
import type { Match, MapData } from "../sim/types";
import { FP } from "../sim/fixed";
import { PAL } from "./palette";
import { bounds, gltf, model } from "./assets";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const U = 1 / FP; // sim FP -> world units

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ water (persistent)

export function makeWater(): { mesh: THREE.Mesh; uniforms: Record<string, THREE.IUniform> } {
  const geo = new THREE.PlaneGeometry(420, 420, 84, 84);
  geo.rotateX(-Math.PI / 2);
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uR: { value: 30 },
      uDeep: { value: new THREE.Color(PAL.waterDeep) },
      uShallow: { value: new THREE.Color(PAL.waterShallow) },
      uFoam: { value: new THREE.Color(PAL.foam) },
    },
  ]);
  const mat = new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      uniform float uTime;
      varying vec2 vW; varying float vH;
      void main() {
        vec3 p = position;
        float h = sin(p.x * 0.33 + uTime * 1.1) * 0.09 + cos(p.z * 0.29 + uTime * 0.83) * 0.09 + sin((p.x + p.z) * 0.7 + uTime * 1.9) * 0.03;
        p.y += h; vW = p.xz; vH = h;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime; uniform float uR;
      uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uFoam;
      varying vec2 vW; varying float vH;
      void main() {
        float d = length(vW) - uR;
        vec3 c = mix(uShallow, uDeep, smoothstep(0.0, 14.0, d));
        float band = sin(d * 1.9 - uTime * 1.8) * 0.5 + 0.5;
        float foam = smoothstep(0.75, 1.0, band) * (1.0 - smoothstep(0.5, 5.0, d)) * 0.8;
        foam += 1.0 - smoothstep(0.2, 1.1, d + sin(atan(vW.y, vW.x) * 9.0 + uTime) * 0.25);
        float s = sin(vW.x * 1.3 + uTime * 1.2) * sin(vW.y * 1.5 - uTime * 0.9);
        c += smoothstep(0.93, 1.0, s) * 0.18;
        c += vH * 0.5;
        c = mix(c, uFoam, clamp(foam, 0.0, 1.0) * 0.85);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -0.32;
  mesh.receiveShadow = false;
  return { mesh, uniforms };
}

// ------------------------------------------------------------------ helpers

/** Build InstancedMeshes for every sub-mesh of a model, one instance per matrix. */
function instanced(name: string, mats: THREE.Matrix4[], cast = false): THREE.Object3D {
  const g = new THREE.Group();
  if (mats.length === 0) return g;
  const src = gltf(name).scene;
  src.updateMatrixWorld(true);
  src.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const im = new THREE.InstancedMesh(m.geometry, m.material, mats.length);
    const tmp = new THREE.Matrix4();
    for (let i = 0; i < mats.length; i++) im.setMatrixAt(i, tmp.multiplyMatrices(mats[i], m.matrixWorld));
    im.castShadow = cast;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    g.add(im);
  });
  return g;
}

/** Big maps: split instances into spatial chunks (each its own InstancedMesh) so off-screen chunks are culled. */
function instancedChunks(name: string, mats: THREE.Matrix4[], cast = false, size = 18): THREE.Object3D {
  const g = new THREE.Group();
  const chunks = new Map<string, THREE.Matrix4[]>();
  for (const m of mats) {
    const k = `${Math.floor(m.elements[12] / size)},${Math.floor(m.elements[14] / size)}`;
    const list = chunks.get(k) ?? [];
    list.push(m);
    chunks.set(k, list);
  }
  for (const list of chunks.values()) g.add(instanced(name, list, cast));
  return g;
}

function fitScale(name: string, radius: number): number {
  const b = bounds(name);
  const fr = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2;
  return radius / Math.max(fr, 0.01);
}

// ------------------------------------------------------------------ per-match world

interface BushView {
  x: number;
  z: number;
  r: number;
  group: THREE.Group;
  mats: THREE.MeshStandardMaterial[];
  rustle: number;
  fade: number;
  phase: number;
}
interface ChestView {
  group: THREE.Group;
  lid: THREE.Object3D | null;
  beacon: THREE.Mesh;
  open: boolean;
  t: number; // time since opened
  mat: THREE.MeshStandardMaterial;
  pad: THREE.Mesh;
}
interface HealView {
  group: THREE.Group;
  taken: boolean;
  t: number;
  phase: number;
}

const healGeo = (() => {
  const a = new THREE.BoxGeometry(0.7, 0.24, 0.24);
  const b = new THREE.BoxGeometry(0.24, 0.7, 0.24);
  const g = new THREE.BufferGeometry();
  // merge two boxes manually
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  let off = 0;
  for (const bx of [a, b]) {
    const p = bx.attributes.position.array, n = bx.attributes.normal.array, ix = bx.index!.array;
    for (let i = 0; i < p.length; i++) { pos.push(p[i]); nor.push(n[i]); }
    for (let i = 0; i < ix.length; i++) idx.push(ix[i] + off);
    off += p.length / 3;
  }
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
})();
const healMat = new THREE.MeshStandardMaterial({ color: 0x6dff8a, emissive: 0x2bd451, emissiveIntensity: 1.1, roughness: 0.4 });
const glowTex = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.35, "rgba(255,255,255,.55)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = gr;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
export { glowTex };
const dullCache = new Map<THREE.Material, THREE.MeshStandardMaterial>();
function dullCrateMat(m: THREE.MeshStandardMaterial) {
  let d = dullCache.get(m);
  if (!d) {
    d = m.clone();
    d.color.setHex(0x9c8f84);
    dullCache.set(m, d);
  }
  return d;
}
function goldChestMat(crate: THREE.Object3D): THREE.MeshStandardMaterial {
  let mat: THREE.MeshStandardMaterial | null = null;
  crate.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    mat ??= (m.material as THREE.MeshStandardMaterial).clone();
    mat.color.setHex(0xffd36a);
    mat.emissive.setHex(0xb06a00);
    mat.emissiveIntensity = 0.6;
    m.material = mat;
  });
  return mat!;
}
const chestPadGeo = (() => {
  const g = new THREE.RingGeometry(0.9, 1.25, 6);
  g.rotateX(-Math.PI / 2);
  return g;
})();
const chestPadMat = new THREE.MeshBasicMaterial({ color: 0xffc93c, transparent: true, opacity: 0.55, depthWrite: false });
const beamGeo = new THREE.CylinderGeometry(0.12, 0.45, 4, 12, 1, true).translate(0, 2, 0);
const beamMat = new THREE.MeshBasicMaterial({ color: 0xffc93c, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });

export class World {
  readonly group = new THREE.Group();
  private bushes: BushView[] = [];
  private chests: ChestView[] = [];
  private heals: HealView[] = [];
  private stormWall: THREE.Mesh;
  private stormGround: THREE.Mesh;
  private nextRing: THREE.Mesh;
  private stormU: Record<string, THREE.IUniform>;
  private owned: { dispose(): void }[] = [];
  readonly radius: number;
  /** callback for burst particles: (x, z, kind) */
  onBurst: (x: number, z: number, kind: "chest" | "heal") => void = () => {};

  private lazyParts = false;
  /** Big Island (cfg.map = "big"): hundreds of obstacles -> instanced, ruins as stone blocks, more decor */
  private big = false;
  /** lazy: build bushes + decor later with finish() (keeps the boot task short) */
  constructor(private match: Match, lazy = false) {
    const map = match.map;
    this.radius = map.radius * U;
    const seed = match.cfg.seed;
    this.big = match.cfg.map === "big";
    this.buildIsland(map, seed);
    if (this.big) this.buildObstaclesInstanced(map, seed);
    else this.buildObstacles(map);
    if (!lazy) {
      this.buildBushes(map, seed);
      this.buildDecor(map, seed);
    } else this.lazyParts = true;
    this.buildPickups();
    if (new URLSearchParams(location.search).has("debugcol")) {
      const mk = (x: number, y: number, r: number, c: number) => {
        const m = new THREE.Mesh(new THREE.RingGeometry(r * U - 0.08, r * U, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: c, depthTest: false }));
        m.position.set(x * U, 0.3, y * U);
        m.renderOrder = 99;
        this.group.add(m);
      };
      for (const o of map.obstacles) mk(o.x, o.y, o.r, 0xff0000);
      for (const b of map.bushes) mk(b.x, b.y, b.r, 0xffff00);
    }

    // ---- storm
    this.stormU = {
      uTime: { value: 0 },
      uR: { value: this.radius },
      uC: { value: new THREE.Vector2() },
      uColor: { value: new THREE.Color(PAL.storm) },
      uHot: { value: new THREE.Color(PAL.stormHot) },
      uEdge: { value: new THREE.Color(PAL.stormEdge) },
    };
    const wallGeo = new THREE.CylinderGeometry(1, 1, 7, 128, 1, true);
    wallGeo.translate(0, 3.0, 0);
    const wallMat = new THREE.ShaderMaterial({
      uniforms: this.stormU,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vP;
        void main() { vUv = uv; vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uColor; uniform vec3 uHot; uniform vec3 uEdge;
        varying vec2 vUv; varying vec3 vP;
        void main() {
          float a = atan(vP.z, vP.x);
          float streak = sin(a * 60.0 + vUv.y * 6.0 - uTime * 2.5) * 0.5 + 0.5;
          float swirl = sin(a * 23.0 - uTime * 1.3 + vUv.y * 12.0) * 0.5 + 0.5;
          float h = vUv.y;
          float alpha = (1.0 - h) * 0.55 + streak * 0.12 * (1.0 - h) + smoothstep(0.0, 0.05, 0.05 - h) * 0.6;
          vec3 c = mix(uColor, uHot, streak * swirl * (1.0 - h));
          c += uEdge * (smoothstep(0.14, 0.0, h) * 0.9 + smoothstep(0.35, 0.0, h) * 0.25);
          gl_FragColor = vec4(c, clamp(alpha, 0.0, 0.85));
          #include <colorspace_fragment>
        }`,
    });
    this.stormWall = new THREE.Mesh(wallGeo, wallMat);
    this.stormWall.renderOrder = 5;
    this.group.add(this.stormWall);

    // annulus from the safe radius outward (scaled per frame): no full-screen overdraw inside the zone
    const gGeo = new THREE.RingGeometry(0.98, 40, 96, 1);
    gGeo.rotateX(-Math.PI / 2);
    const gMat = new THREE.ShaderMaterial({
      uniforms: this.stormU,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec2 vW;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uR; uniform vec2 uC; uniform vec3 uColor;
        varying vec2 vW;
        void main() {
          float d = length(vW - uC) - uR;
          if (d < 0.0) discard;
          float n = sin(vW.x * 0.5 + uTime) * sin(vW.y * 0.45 - uTime * 0.8) * 0.5 + 0.5;
          float a = smoothstep(0.0, 3.0, d) * (0.32 + n * 0.12);
          gl_FragColor = vec4(uColor * 0.6, a);
          #include <colorspace_fragment>
        }`,
    });
    this.stormGround = new THREE.Mesh(gGeo, gMat);
    this.stormGround.position.y = 0.11;
    this.stormGround.renderOrder = 4;
    this.group.add(this.stormGround);

    const ringGeo = new THREE.RingGeometry(0.985, 1, 128);
    ringGeo.rotateX(-Math.PI / 2);
    this.nextRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false }));
    this.nextRing.position.y = 0.08;
    this.nextRing.renderOrder = 4;
    this.group.add(this.nextRing);
    this.owned.push(wallGeo, wallMat, gGeo, gMat, ringGeo, this.nextRing.material as THREE.Material);
  }

  async finish() {
    if (!this.lazyParts) return;
    this.lazyParts = false;
    const y = () => new Promise<void>((r) => setTimeout(r, 0));
    await y();
    this.buildBushes(this.match.map, this.match.cfg.seed);
    await y();
    this.buildDecor(this.match.map, this.match.cfg.seed);
  }

  private buildIsland(map: MapData, seed: number) {
    const R = map.radius * U;
    const rand = rng(seed ^ 0x51a7);
    // grass: jittered triangle grid clipped to an irregular circle, one flat colour per face
    const grassR = R - 1.1;
    const N = this.big ? Math.round((46 * R) / 32) : 46, step = (grassR * 2) / N;
    const cA = new THREE.Color(PAL.grass), cB = new THREE.Color(PAL.grassDark), cC = new THREE.Color(PAL.grassLight), tmp = new THREE.Color();
    const vx: number[] = [], vy: number[] = [], vz: number[] = [];
    const edgeR = (a: number) => grassR * (1 + Math.sin(a * 7 + seed) * 0.012 + Math.sin(a * 13 + seed * 0.3) * 0.01);
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        let x = -grassR + i * step + (j % 2) * step * 0.5 + (rand() - 0.5) * step * 0.5;
        let z = -grassR + j * step + (rand() - 0.5) * step * 0.5;
        const d = Math.hypot(x, z), a = Math.atan2(z, x), er = edgeR(a);
        if (d > er) { x *= er / d; z *= er / d; }
        vx.push(x); vz.push(z);
        vy.push(d >= er - 0.01 ? 0 : rand() * 0.06);
      }
    }
    const pos: number[] = [], col: number[] = [];
    const id = (i: number, j: number) => j * (N + 1) + i;
    const tri = (a: number, b: number, c: number) => {
      const cx = (vx[a] + vx[b] + vx[c]) / 3, cz = (vz[a] + vz[b] + vz[c]) / 3;
      if (Math.hypot(cx, cz) > edgeR(Math.atan2(cz, cx)) - 0.05) return;
      for (const k of [a, c, b]) pos.push(vx[k], vy[k], vz[k]);
      const n = Math.sin(cx * 0.18 + seed) * Math.cos(cz * 0.15) * 0.5 + 0.5;
      tmp.copy(cA).lerp(n > 0.5 ? cC : cB, Math.abs(n - 0.5) * 1.2 + rand() * 0.12);
      for (let k = 0; k < 3; k++) col.push(tmp.r, tmp.g, tmp.b);
    };
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (j % 2 === 0) { tri(id(i, j), id(i + 1, j), id(i, j + 1)); tri(id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)); }
        else { tri(id(i, j), id(i + 1, j + 1), id(i, j + 1)); tri(id(i, j), id(i + 1, j), id(i + 1, j + 1)); }
      }
    }
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g2.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g2.computeVertexNormals();
    if (g2.attributes.normal.getY(0) < 0) {
      const p = g2.attributes.position.array as Float32Array;
      for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; }
      g2.computeVertexNormals();
    }
    const grassMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const grass = new THREE.Mesh(g2, grassMat);
    grass.position.y = 0.02;
    grass.receiveShadow = true;
    this.group.add(grass);

    // sand beach: a cone-ish ring sloping into the water
    const sandGeo = new THREE.CylinderGeometry(R + 0.2, R + 3.2, 1.4, 96, 2, false);
    sandGeo.translate(0, -0.76, 0);
    const sp = sandGeo.attributes.position;
    const sc: number[] = [];
    const sA = new THREE.Color(PAL.sand), sB = new THREE.Color(PAL.sandWet);
    for (let i = 0; i < sp.count; i++) {
      const y = sp.getY(i);
      tmp.copy(sA).lerp(sB, THREE.MathUtils.clamp(-y * 0.9, 0, 1) * 0.8 + rand() * 0.08);
      sc.push(tmp.r, tmp.g, tmp.b);
    }
    sandGeo.setAttribute("color", new THREE.Float32BufferAttribute(sc, 3));
    const sandMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const sand = new THREE.Mesh(sandGeo, sandMat);
    sand.receiveShadow = true;
    this.group.add(sand);
    this.owned.push(g2, grassMat, sandGeo, sandMat);
  }

  private buildObstacles(map: MapData) {
    map.obstacles.forEach((o, i) => {
      let name: string;
      let s: number;
      const r = o.r * U;
      if (o.kind === "tree") {
        name = ["nature/tree_default", "nature/tree_detailed", "nature/tree_fat_fall"][i % 3];
        s = fitScale(name, r) * 1.1;
      } else if (o.kind === "crate") {
        name = ["blasters/crate-medium", "blasters/crate-wide", "blasters/crate-small"][i % 3];
        s = fitScale(name, r) * 1.05;
      } else if (o.kind === "wall") {
        name = ["nature/rock_tallA", "nature/rock_tallB", "nature/stone_tallA"][i % 3];
        s = fitScale(name, r) * 1.1;
      } else {
        name = ["nature/rock_largeA", "nature/rock_largeB", "nature/rock_tallA", "nature/rock_smallA"][i % 4];
        s = fitScale(name, r) * 1.1;
      }
      const m = model(name);
      if (o.kind === "crate") {
        // solid supply crates read as terrain: dull, desaturated wood/stone tint (chests are gold + glowing)
        m.traverse((x) => {
          const mm = x as THREE.Mesh;
          if (mm.isMesh) mm.material = dullCrateMat(mm.material as THREE.MeshStandardMaterial);
        });
      }
      m.scale.setScalar(s);
      m.position.set(o.x * U, 0, o.y * U);
      m.rotation.y = (i * 2.399) % (Math.PI * 2);
      this.group.add(m);
    });
  }

  /** Big Island: one InstancedMesh per model part (a few dozen draw calls for ~220 obstacles). */
  private buildObstaclesInstanced(map: MapData, seed: number) {
    const groups = new Map<string, THREE.Matrix4[]>();
    const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), sc = new THREE.Vector3();
    const walls: THREE.Matrix4[] = [];
    const wallCols: THREE.Color[] = [];
    const rand = rng(seed ^ 0x3a11);
    const stoneA = new THREE.Color(0xd8ccb0), stoneB = new THREE.Color(0xbfae8c), tmp = new THREE.Color();
    map.obstacles.forEach((o, i) => {
      const r = o.r * U;
      if (o.kind === "wall") {
        // ruin wall: axis-aligned stone blocks (posts are <= 1.2 u apart, so neighbours touch), uneven tops
        const hgt = rand() < 0.15 ? 0.7 + rand() * 0.3 : 1.15 + rand() * 0.75;
        const w = r * 1.9;
        walls.push(new THREE.Matrix4().compose(v.set(o.x * U, hgt / 2, o.y * U), q.identity(), sc.set(w, hgt, w)));
        wallCols.push(tmp.copy(stoneA).lerp(stoneB, rand()).offsetHSL(0, 0, (rand() - 0.5) * 0.06).clone());
        return;
      }
      let name: string, s: number;
      if (o.kind === "tree") {
        name = ["nature/tree_default", "nature/tree_detailed", "nature/tree_fat_fall"][i % 3];
        s = fitScale(name, r) * 1.1;
      } else if (o.kind === "crate") {
        name = ["blasters/crate-medium", "blasters/crate-wide", "blasters/crate-small"][i % 3];
        s = fitScale(name, r) * 1.05;
      } else {
        name = ["nature/rock_largeA", "nature/rock_largeB", "nature/rock_tallA", "nature/rock_smallA"][i % 4];
        s = fitScale(name, r) * 1.1;
      }
      q.setFromAxisAngle(up, (i * 2.399) % (Math.PI * 2));
      const m4 = new THREE.Matrix4().compose(v.set(o.x * U, 0, o.y * U), q, sc.set(s, s, s));
      const list = groups.get(name) ?? [];
      list.push(m4);
      groups.set(name, list);
    });
    for (const [name, mats] of groups) {
      const g = instancedChunks(name, mats, true);
      if (name.startsWith("blasters/crate"))
        g.traverse((x) => {
          const mm = x as THREE.InstancedMesh;
          if (mm.isInstancedMesh) mm.material = dullCrateMat(mm.material as THREE.MeshStandardMaterial);
        });
      this.group.add(g);
    }
    if (walls.length) {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
      const im = new THREE.InstancedMesh(geo, mat, walls.length);
      walls.forEach((m4, i) => {
        im.setMatrixAt(i, m4);
        im.setColorAt(i, wallCols[i]);
      });
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      this.group.add(im);
      this.owned.push(geo, mat, im);
    }
  }

  private buildBushes(map: MapData, seed: number) {
    const rand = rng(seed ^ 0xb055);
    // One merged mesh per bush (one draw call), own material so it can fade when you hide in it.
    const src = gltf("nature/plant_bushLarge").scene;
    src.updateMatrixWorld(true);
    const parts: { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial; local: THREE.Matrix4 }[] = [];
    src.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) parts.push({ geo: m.geometry, mat: m.material as THREE.MeshStandardMaterial, local: m.matrixWorld.clone() });
    });
    const tmpM = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), sc = new THREE.Vector3();
    for (const b of map.bushes) {
      const r = b.r * U;
      const group = new THREE.Group();
      group.position.set(b.x * U, 0, b.y * U);
      const mats: THREE.MeshStandardMaterial[] = [];
      const n = Math.max(3, Math.round(r * r * 1.6));
      for (const part of parts) {
        const geos: THREE.BufferGeometry[] = [];
        const r2 = rng(seed ^ 0xb055 ^ Math.round(b.x));
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + r2() * 0.6;
          const d = k === 0 ? 0 : r * (0.3 + r2() * 0.3);
          const pr = r * (0.5 + r2() * 0.15);
          const s = fitScale("nature/plant_bushLarge", pr) * (0.9 + r2() * 0.3);
          q.setFromAxisAngle(up, r2() * Math.PI * 2);
          tmpM.compose(v.set(Math.cos(a) * d, 0, Math.sin(a) * d), q, sc.set(s, s * (0.85 + r2() * 0.3), s)).multiply(part.local);
          geos.push(part.geo.clone().applyMatrix4(tmpM));
        }
        const merged = mergeGeometries(geos, false);
        for (const g of geos) g.dispose();
        if (!merged) continue;
        const mat = part.mat.clone();
        mat.color.offsetHSL(0.0, 0.04, -0.04 - rand() * 0.03);
        mats.push(mat);
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
        this.owned.push(merged);
      }
      this.group.add(group);
      this.bushes.push({ x: b.x * U, z: b.y * U, r, group, mats, rustle: 0, fade: 0, phase: rand() * 10 });
      this.owned.push(...mats);
    }
  }

  private buildDecor(map: MapData, seed: number) {
    const rand = rng(seed ^ 0xdec0);
    const R = map.radius * U - 1.6;
    const blocked = (x: number, z: number, pad: number) => {
      for (const o of map.obstacles) if ((o.x * U - x) ** 2 + (o.y * U - z) ** 2 < (o.r * U + pad) ** 2) return true;
      for (const b of map.bushes) if ((b.x * U - x) ** 2 + (b.y * U - z) ** 2 < (b.r * U + pad) ** 2) return true;
      return false;
    };
    const kinds: [string, number, number][] = [
      ["nature/grass", 140, 2.2],
      ["nature/grass_large", 60, 2.0],
      ["nature/grass_leafs", 50, 2.0],
      ["nature/flower_yellowA", 26, 2.0],
      ["nature/flower_redA", 22, 2.0],
      ["nature/flower_purpleA", 22, 2.0],
      ["nature/mushroom_red", 10, 1.8],
      ["nature/stump_old", 4, 1.8],
      ["nature/log", 4, 1.6],
    ];
    const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), sc = new THREE.Vector3();
    const area = this.big ? (map.radius * map.radius) / (32000 * 32000) : 1;
    for (const [name, count, scale] of kinds) {
      const mats: THREE.Matrix4[] = [];
      for (let i = 0; i < Math.round(count * area); i++) {
        const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * R;
        const x = Math.cos(a) * d, z = Math.sin(a) * d;
        if (blocked(x, z, 0.4)) continue;
        q.setFromAxisAngle(up, rand() * Math.PI * 2);
        const s = scale * (0.7 + rand() * 0.6);
        mats.push(new THREE.Matrix4().compose(v.set(x, 0.02, z), q, sc.set(s, s, s)));
      }
      const cast = name.includes("stump") || name.includes("log");
      this.group.add(this.big ? instancedChunks(name, mats, cast, 24) : instanced(name, mats, cast));
    }
    // palms/trees ring on the beach edge (decor only, outside the walkable area)
    const treeMats: THREE.Matrix4[] = [];
    const ring = map.radius * U + 1.2;
    const nRing = this.big ? Math.round((18 * map.radius) / 32000) : 18;
    for (let i = 0; i < nRing; i++) {
      const a = (i / nRing) * Math.PI * 2 + rand() * 0.2;
      q.setFromAxisAngle(up, rand() * Math.PI * 2);
      const s = 2.2 + rand() * 0.8;
      treeMats.push(new THREE.Matrix4().compose(v.set(Math.cos(a) * ring, -0.2, Math.sin(a) * ring), q, sc.set(s, s, s)));
    }
    // a few rocks in the shallows
    const rockMats: THREE.Matrix4[] = [];
    for (let i = 0; i < (this.big ? 26 : 14); i++) {
      const a = rand() * Math.PI * 2, d = map.radius * U + 4 + rand() * 9;
      q.setFromAxisAngle(up, rand() * Math.PI * 2);
      const s = 1.5 + rand() * 2.5;
      rockMats.push(new THREE.Matrix4().compose(v.set(Math.cos(a) * d, -0.5, Math.sin(a) * d), q, sc.set(s, s, s)));
    }
    this.group.add(instanced("nature/tree_detailed", treeMats.filter((_, i) => i % 2 === 0), true));
    this.group.add(instanced("nature/tree_default", treeMats.filter((_, i) => i % 2 === 1), true));
    this.group.add(instanced("nature/rock_largeB", rockMats, false));
  }

  private buildPickups() {
    const st = this.match.state;
    for (const c of st.chests) {
      const g = new THREE.Group();
      const crate = model("blasters/crate-medium");
      crate.scale.setScalar(1.25);
      crate.rotation.y = (c.id * 1.7) % Math.PI;
      let lid: THREE.Object3D | null = null;
      const mat = goldChestMat(crate);
      crate.traverse((o) => { if (o.name === "lid") lid = o; });
      const pad = new THREE.Mesh(chestPadGeo, chestPadMat);
      pad.position.y = 0.12;
      pad.renderOrder = 2;
      g.add(pad);
      g.add(crate);
      const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.3, 0), new THREE.MeshBasicMaterial({ color: PAL.gold }));
      beacon.position.y = 1.5;
      g.add(beacon);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: PAL.gold, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
      glow.scale.setScalar(1.2);
      beacon.add(glow);
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beacon.userData.beam = beam;
      g.add(beam);
      g.position.set(c.x * U, 0, c.y * U);
      this.group.add(g);
      this.chests[c.id] = { group: g, lid, beacon, open: c.open, t: c.open ? 99 : 0, mat, pad };
      if (c.open) this.applyOpen(this.chests[c.id], 99);
      this.owned.push(beacon.geometry, beacon.material as THREE.Material, glow.material, mat);
    }
    for (const h of st.heals) {
      const g = new THREE.Group();
      const cross = new THREE.Mesh(healGeo, healMat);
      cross.castShadow = true;
      cross.position.y = 0.8;
      g.add(cross);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: PAL.heal, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
      glow.scale.setScalar(1.7);
      glow.position.y = 0.8;
      g.add(glow);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.55, 20), new THREE.MeshBasicMaterial({ color: PAL.heal, transparent: true, opacity: 0.35, depthWrite: false }));
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.07;
      g.add(disc);
      g.position.set(h.x * U, 0, h.y * U);
      this.group.add(g);
      this.heals[h.id] = { group: g, taken: h.taken, t: h.taken ? 99 : 0, phase: h.id * 1.3 };
      if (h.taken) g.visible = false;
      this.owned.push(glow.material, disc.geometry, disc.material as THREE.Material);
    }
  }

  private applyOpen(c: ChestView, t: number) {
    c.beacon.visible = false;
    c.pad.visible = false;
    c.mat.emissiveIntensity = 0.1;
    (c.beacon.userData.beam as THREE.Object3D).visible = false;
    if (c.lid) {
      const k = Math.min(1, t / 0.5);
      c.lid.position.y = 0.19 + Math.sin(k * Math.PI) * 0.9 + k * 0.05;
      c.lid.rotation.z = k * 2.2;
      c.lid.position.x = 0.25 + k * 0.5;
    }
    const pop = t < 0.35 ? 1 + Math.sin((t / 0.35) * Math.PI) * 0.3 : 1;
    c.group.scale.set(pop, 2 - pop, pop);
  }

  /** local player world position for bush transparency. */
  update(dt: number, time: number, me: { x: number; z: number; inBush: boolean } | null, rustlers: { x: number; z: number }[]) {
    const st = this.match.state;
    // storm
    this.stormU.uTime.value = time;
    const R = Math.max(0.01, st.storm.r * U);
    this.stormU.uR.value = R;
    (this.stormU.uC.value as THREE.Vector2).set(st.storm.cx * U, st.storm.cy * U);
    this.stormWall.scale.set(R, 1, R);
    this.stormGround.scale.set(R, 1, R);
    this.stormGround.position.set(st.storm.cx * U, 0.11, st.storm.cy * U);
    this.stormWall.position.set(st.storm.cx * U, 0, st.storm.cy * U);
    this.stormWall.visible = R < this.radius - 0.3;
    const tR = st.storm.targetR * U;
    this.nextRing.visible = tR < R - 0.05;
    this.nextRing.scale.set(tR, 1, tR);
    this.nextRing.position.set((st.storm.tx ?? st.storm.cx) * U, 0.14, (st.storm.ty ?? st.storm.cy) * U);
    (this.nextRing.material as THREE.MeshBasicMaterial).opacity = 0.45 + Math.sin(time * 5) * 0.25;

    // bushes
    for (const b of this.bushes) {
      let inside = false;
      if (me && me.inBush && (me.x - b.x) ** 2 + (me.z - b.z) ** 2 < (b.r + 0.4) ** 2) inside = true;
      for (const r of rustlers) if ((r.x - b.x) ** 2 + (r.z - b.z) ** 2 < (b.r + 0.3) ** 2) b.rustle = Math.min(1, b.rustle + dt * 5);
      if (inside) b.rustle = Math.min(1, b.rustle + dt * 4);
      b.rustle = Math.max(0, b.rustle - dt * 1.8);
      const target = inside ? 1 : 0;
      b.fade += (target - b.fade) * Math.min(1, dt * 10);
      const op = 1 - b.fade * 0.68;
      for (const m of b.mats) {
        const tr = op < 0.99;
        if (m.transparent !== tr) { m.transparent = tr; m.depthWrite = !tr; }
        m.opacity = op;
      }
      const sway = Math.sin(time * 1.4 + b.phase) * 0.02 + Math.sin(time * 22 + b.phase) * 0.07 * b.rustle;
      b.group.rotation.z = sway;
      b.group.rotation.x = Math.cos(time * 19 + b.phase) * 0.05 * b.rustle;
      b.group.scale.y = 1 + Math.sin(time * 25) * 0.04 * b.rustle;
    }

    // chests
    for (const c of st.chests) {
      const v = this.chests[c.id];
      if (!v) continue;
      if (c.open && !v.open) {
        v.open = true;
        v.t = 0;
        this.onBurst(c.x * U, c.y * U, "chest");
      }
      if (v.open) {
        v.t += dt;
        if (v.t < 2) this.applyOpen(v, v.t);
        else if (v.t < 3.2) {
          const k = Math.max(0, (v.t - 2.6) / 0.6);
          v.group.scale.setScalar(1 - k);
          if (k >= 1) v.group.visible = false;
        }
      } else {
        v.beacon.position.y = 1.55 + Math.sin(time * 3 + c.id) * 0.12;
        v.beacon.rotation.y = time * 2;
        v.mat.emissiveIntensity = 0.55 + Math.sin(time * 4 + c.id) * 0.3;
        v.pad.rotation.y = time * 0.8;
      }
    }
    // heals
    for (const h of st.heals) {
      const v = this.heals[h.id];
      if (!v) continue;
      if (h.taken && !v.taken) {
        v.taken = true;
        v.t = 0;
        this.onBurst(h.x * U, h.y * U, "heal");
      }
      if (v.taken) {
        v.t += dt;
        const k = Math.min(1, v.t / 0.25);
        v.group.scale.setScalar(1 + k * 0.6);
        v.group.visible = k < 1;
      } else {
        const c = v.group.children[0];
        c.position.y = 0.95 + Math.sin(time * 2.6 + v.phase) * 0.15;
        c.rotation.set(-0.55, Math.sin(time * 1.8 + v.phase) * 0.5, 0);
      }
    }
  }

  dispose() {
    for (const o of this.owned) o.dispose();
    this.group.removeFromParent();
  }
}
