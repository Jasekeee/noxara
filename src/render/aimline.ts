// Subtle aim preview on the ground: a faint line from the player along the aim, plus a ring on a locked target.
import * as THREE from "three";

export class AimLine {
  readonly group = new THREE.Group();
  private line: THREE.Mesh;
  private ring: THREE.Mesh;
  private lineMat: THREE.MeshBasicMaterial;
  private ringMat: THREE.MeshBasicMaterial;

  constructor() {
    const lg = new THREE.PlaneGeometry(1, 0.1);
    lg.rotateX(-Math.PI / 2);
    lg.translate(0.5, 0, 0); // starts at the origin, runs along +x
    this.lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false, depthTest: false });
    this.line = new THREE.Mesh(lg, this.lineMat);
    const rg = new THREE.RingGeometry(0.55, 0.7, 32);
    rg.rotateX(-Math.PI / 2);
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xff5a5f, transparent: true, opacity: 0.75, depthWrite: false, depthTest: false });
    this.ring = new THREE.Mesh(rg, this.ringMat);
    this.line.renderOrder = this.ring.renderOrder = 19;
    this.line.frustumCulled = this.ring.frustumCulled = false;
    this.group.add(this.line, this.ring);
    this.group.visible = false;
  }

  /** px,pz = player world pos; ang in radians (sim convention: atan2(dz, dx)); len in world units */
  update(show: boolean, px: number, pz: number, ang: number, len: number, locked: boolean, tx: number, tz: number, t: number) {
    this.group.visible = show;
    if (!show) return;
    this.line.position.set(px, 0.15, pz);
    this.line.rotation.y = -ang;
    this.line.scale.x = Math.max(0.5, len);
    this.lineMat.opacity = locked ? 0.4 : 0.2;
    this.lineMat.color.setHex(locked ? 0xff5a5f : 0xffffff);
    this.ring.visible = locked;
    if (locked) {
      this.ring.position.set(tx, 0.16, tz);
      const s = 1 + Math.sin(t * 8) * 0.06;
      this.ring.scale.set(s, 1, s);
    }
  }
}
