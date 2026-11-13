// Render each weapon model once into a small transparent PNG (HUD card + kill feed icons).
import * as THREE from "three";
import type { WeaponKind } from "../sim/types";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { CHARS, WEAPON_MODEL, gltf, model } from "./assets";

export async function makeWeaponIcons(renderer: THREE.WebGLRenderer): Promise<Record<WeaponKind, string>> {
  const W = 192, H = 96;
  const rt = new THREE.WebGLRenderTarget(W, H, { colorSpace: THREE.SRGBColorSpace });
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8888aa, 2.4));
  const d = new THREE.DirectionalLight(0xffffff, 2);
  d.position.set(2, 3, 4);
  scene.add(d);
  const cam = new THREE.OrthographicCamera(-1, 1, 0.5, -0.5, 0.1, 20);
  cam.position.set(0, 0.25, 5);
  cam.lookAt(0, 0, 0);
  const px = new Uint8Array(W * H * 4);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const out = {} as Record<WeaponKind, string>;
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);
  for (const k of Object.keys(WEAPON_MODEL) as WeaponKind[]) {
    const m = model(WEAPON_MODEL[k]);
    const box = new THREE.Box3().setFromObject(m);
    const size = box.getSize(new THREE.Vector3());
    const ctr = box.getCenter(new THREE.Vector3());
    const pivot = new THREE.Group();
    m.position.sub(ctr);
    pivot.add(m);
    if (k === "grenade") {
      pivot.scale.setScalar(0.8 / Math.max(size.y, 0.01));
      pivot.rotation.set(0.2, 0.5, 0);
    } else {
      pivot.rotation.set(0.15, -Math.PI / 2 + 0.25, 0);
      pivot.scale.setScalar(1.75 / Math.max(size.z, 0.01));
    }
    scene.add(pivot);
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, cam);
    await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H, px); // async PBO readback: no GPU stall
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    ctx.putImageData(img, 0, 0);
    out[k] = canvas.toDataURL("image/png");
    scene.remove(pivot);
  }
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(0x000000, prevClear);
  rt.dispose();
  return out;
}

/** Head-and-shoulders portrait of every character (idle pose), as PNG data URLs, indexed like CHARS. */
export async function makePortraits(renderer: THREE.WebGLRenderer, names: string[] = CHARS): Promise<string[]> {
  const S = 160;
  const rt = new THREE.WebGLRenderTarget(S, S, { colorSpace: THREE.SRGBColorSpace });
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7aa8, 2.2));
  const d = new THREE.DirectionalLight(0xfff0d6, 2.2);
  d.position.set(1.5, 2.5, 3);
  scene.add(d);
  const cam = new THREE.PerspectiveCamera(26, 1, 0.1, 20);
  cam.position.set(0, 0.62, 2.0);
  cam.lookAt(0, 0.42, 0);
  const px = new Uint8Array(S * S * 4);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const out: string[] = [];
  const prevTarget = renderer.getRenderTarget();
  const prevAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);
  for (const c of names) {
    const g = gltf(`chars/${c}`);
    const body = SkeletonUtils.clone(g.scene);
    body.rotation.y = -0.35;
    const mixer = new THREE.AnimationMixer(body);
    const idle = g.animations.find((a) => a.name === "idle");
    if (idle) {
      mixer.clipAction(idle).play();
      mixer.update(0.4);
    }
    scene.add(body);
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, cam);
    await renderer.readRenderTargetPixelsAsync(rt, 0, 0, S, S, px);
    const img = ctx.createImageData(S, S);
    for (let y = 0; y < S; y++) img.data.set(px.subarray((S - 1 - y) * S * 4, (S - y) * S * 4), y * S * 4);
    ctx.putImageData(img, 0, 0);
    out.push(canvas.toDataURL("image/png"));
    scene.remove(body);
    mixer.stopAllAction();
  }
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(0x000000, prevAlpha);
  rt.dispose();
  return out;
}
