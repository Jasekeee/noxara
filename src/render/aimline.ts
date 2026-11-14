// Per-weapon aim indicator on the ground (Brawl-Stars style). Numbers come straight from the sim's WEAPONS table:
//   popper / blaster = tapered arrow of exactly `range` length, shotgun = cone of the real pellet spread,
//   sniper = long thin line with a tick at max range, grenade = lob arc + landing circle of the blast radius.
// Team-neutral off-white fill with a thin dark outline so it reads on grass and sand. Input-layer only.
import * as THREE from "three";
import { WEAPONS } from "../sim/rules";
import type { WeaponKind } from "../sim/types";

type P = [number, number]; // (forward, left) in local space, +x = aim direction

const START = 0.85; // begin just outside the feet ring
const TAU = Math.PI * 2;
const FILL = 0xf6f3ea;
const EDGE = 0x1b2230;

/** angle units (4096 = full turn) -> radians */
const angRad = (u: number) => (u / 4096) * TAU;

/** local polygon sets for a weapon (all in world units); grenade is handled separately (dist-dependent) */
export function shapeFor(kind: WeaponKind): P[][] {
  const w = WEAPONS[kind];
  const L = w.range / 1000;
  if (kind === "shotgun") {
    // outer pellets sit at +-spread, each pellet jitters by up to +-20 units
    const half = angRad(w.spread + 20);
    const pts: P[] = [[START * 0.6, 0]];
    const n = 20;
    for (let i = 0; i <= n; i++) {
      const a = -half + (2 * half * i) / n;
      pts.push([Math.cos(a) * L, Math.sin(a) * L]);
    }
    return [pts];
  }
  if (kind === "sniper") {
    const t = 0.07;
    const line: P[] = [[START, -t], [L, -t], [L, t], [START, t]];
    const tick: P[] = [[L - 0.12, -0.55], [L + 0.12, -0.55], [L + 0.12, 0.55], [L - 0.12, 0.55]];
    return [line, tick];
  }
  if (kind === "grenade") return [];
  // popper / blaster: shaft tapers wider toward the tip, then an arrowhead whose tip is at max range
  const hx = Math.max(START + 1, L - 1.5);
  return [[[START, -0.1], [hx, -0.3], [hx, -0.75], [L, 0], [hx, 0.75], [hx, 0.3], [START, 0.1]]];
}

function circlePts(r: number, n = 40): P[] {
  const o: P[] = [];
  for (let i = 0; i < n; i++) o.push([Math.cos((i / n) * TAU) * r, Math.sin((i / n) * TAU) * r]);
  return o;
}

export class AimLine {
  readonly group = new THREE.Group();
  private shapes = new THREE.Group(); // local space, rotated by the aim
  private fillMat = new THREE.MeshBasicMaterial({ color: FILL, transparent: true, opacity: 0.3, depthWrite: false, depthTest: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  private edgeMat = new THREE.LineBasicMaterial({ color: EDGE, transparent: true, opacity: 0.55, depthWrite: false, depthTest: false });
  private dotMat = new THREE.MeshBasicMaterial({ color: FILL, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false });
  private dotGeo = new THREE.CircleGeometry(0.17, 12).rotateX(-Math.PI / 2);
  private landing = new THREE.Group(); // grenade landing circle (world space)
  private dots: THREE.Mesh[] = [];
  private kind: WeaponKind | null = null;
  private built: THREE.Object3D[] = [];
  private ang = 0;
  private dist = 0;
  private k = 0; // fade 0..1
  private seen = false;

  constructor() {
    for (let i = 0; i < 14; i++) {
      const d = new THREE.Mesh(this.dotGeo, this.dotMat);
      d.renderOrder = 21;
      d.frustumCulled = false;
      this.dots.push(d);
      this.group.add(d);
    }
    this.shapes.position.y = 0.18;
    this.landing.position.y = 0.17;
    this.group.add(this.shapes, this.landing);
    this.group.visible = false;
    this.group.renderOrder = 20;
  }

  private addPoly(parent: THREE.Group, pts: P[], closeEdge = true) {
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2); // shape (x, y) -> world (x, 0, -y); the edge below uses the same mapping
    const fill = new THREE.Mesh(g, this.fillMat);
    fill.renderOrder = 20;
    fill.frustumCulled = false;
    const eg = new THREE.BufferGeometry().setFromPoints(pts.map(([x, y]) => new THREE.Vector3(x, 0.01, -y)));
    const edge = closeEdge ? new THREE.LineLoop(eg, this.edgeMat) : new THREE.Line(eg, this.edgeMat);
    edge.renderOrder = 21;
    edge.frustumCulled = false;
    parent.add(fill, edge);
    this.built.push(fill, edge);
  }

  private build(kind: WeaponKind) {
    for (const o of this.built) { o.removeFromParent(); (o as THREE.Mesh).geometry?.dispose(); }
    this.built.length = 0;
    this.kind = kind;
    const lob = kind === "grenade";
    this.fillMat.opacity = kind === "sniper" ? 0.6 : kind === "shotgun" ? 0.3 : 0.42;
    for (const poly of shapeFor(kind)) this.addPoly(this.shapes, poly);
    if (lob) {
      this.addPoly(this.landing, circlePts(WEAPONS.grenade.blast / 1000, 48));
      this.addPoly(this.landing, circlePts(0.35, 16));
    }
    this.shapes.visible = !lob;
    this.landing.visible = lob;
    for (const d of this.dots) d.visible = lob;
  }

  /** px,pz = player world pos; ang radians (sim convention atan2(dz,dx)); dist = aim distance in world units */
  update(show: boolean, px: number, pz: number, ang: number, dist: number, kind: WeaponKind, dt: number) {
    if (!show) {
      this.seen = false;
      this.k = Math.max(0, this.k - dt * 12);
      this.group.visible = this.k > 0.01;
      return;
    }
    if (kind !== this.kind) this.build(kind);
    const range = WEAPONS[kind].range / 1000;
    const tgtDist = Math.max(1, Math.min(range, dist));
    if (!this.seen) { this.ang = ang; this.dist = tgtDist; this.seen = true; }
    // shortest-arc angle lerp (framerate independent)
    const s = 1 - Math.exp(-dt * 28);
    let d = ang - this.ang;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    this.ang += d * s;
    this.dist += (tgtDist - this.dist) * s;
    this.k = Math.min(1, this.k + dt * 10);
    this.group.visible = true;

    this.shapes.position.x = px;
    this.shapes.position.z = pz;
    this.shapes.rotation.y = -this.ang;
    this.shapes.scale.set(1, 1, 1);

    if (kind === "grenade") {
      const ca = Math.cos(this.ang), sa = Math.sin(this.ang);
      this.landing.position.set(px + ca * this.dist, 0.17, pz + sa * this.dist);
      const n = this.dots.length;
      const span = this.dist - START;
      for (let i = 0; i < n; i++) {
        const t = (i + 1) / (n + 1);
        const along = START + span * t;
        const h = Math.sin(t * Math.PI) * Math.min(2.2, 0.35 + this.dist * 0.18); // lob height (reads as an arc to the tilted camera)
        const dot = this.dots[i];
        dot.position.set(px + ca * along, 0.2 + h, pz + sa * along);
        dot.scale.setScalar(0.8 + 0.5 * Math.sin(t * Math.PI));
      }
    }
    const f = this.k;
    this.edgeMat.opacity = 0.55 * f;
    this.dotMat.opacity = 0.85 * f;
    this.fillMat.opacity = (kind === "sniper" ? 0.6 : kind === "shotgun" ? 0.3 : 0.42) * f;
  }
}
