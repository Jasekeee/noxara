// Render each weapon model once into a small transparent PNG (HUD card + kill feed icons).
import * as THREE from "three";
import type { WeaponKind } from "../sim/types";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { CHARS, WEAPON_MODEL, gltf, model } from "./assets";

/**
 * Render `scene` into the bottom-left W×H device pixels of the renderer's own canvas and copy that region
 * into a 2D canvas with drawImage (same task, so the drawing buffer is still valid). No readPixels at
 * all, so Chrome never logs "GPU stall due to ReadPixels" (hardware or SwiftShader).
 */
function snap(renderer: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.Camera, W: number, H: number, out: HTMLCanvasElement): string {
  const gl = renderer.domElement;
  const dpr = renderer.getPixelRatio();
  const size = renderer.getSize(new THREE.Vector2());
  renderer.setRenderTarget(null);
  renderer.setViewport(0, 0, W / dpr, H / dpr);
  renderer.setScissor(0, 0, W / dpr, H / dpr);
  renderer.setScissorTest(true);
  const prevAlpha = renderer.getClearAlpha();
  const prevBg = scene.background;
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, cam);
  const ctx = out.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(gl, 0, gl.height - H, W, H, 0, 0, W, H);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, size.x, size.y);
  renderer.setClearColor(0x000000, prevAlpha);
  scene.background = prevBg;
  return out.toDataURL("image/png");
}

export async function makeWeaponIcons(renderer: THREE.WebGLRenderer): Promise<Record<WeaponKind, string>> {
  const W = 192, H = 96;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8888aa, 2.4));
  const d = new THREE.DirectionalLight(0xffffff, 2);
  d.position.set(2, 3, 4);
  scene.add(d);
  const cam = new THREE.OrthographicCamera(-1, 1, 0.5, -0.5, 0.1, 20);
  cam.position.set(0, 0.25, 5);
  cam.lookAt(0, 0, 0);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const out = {} as Record<WeaponKind, string>;
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
    out[k] = snap(renderer, scene, cam, W, H, canvas);
    scene.remove(pivot);
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

/** Head-and-shoulders portrait of every character (idle pose), as PNG data URLs, indexed like CHARS. */
export async function makePortraits(renderer: THREE.WebGLRenderer, names: string[] = CHARS): Promise<string[]> {
  const S = 160;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7aa8, 2.2));
  const d = new THREE.DirectionalLight(0xfff0d6, 2.2);
  d.position.set(1.5, 2.5, 3);
  scene.add(d);
  const cam = new THREE.PerspectiveCamera(26, 1, 0.1, 20);
  cam.position.set(0, 0.62, 2.0);
  cam.lookAt(0, 0.42, 0);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const out: string[] = [];
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
    out.push(snap(renderer, scene, cam, S, S, canvas));
    scene.remove(body);
    mixer.stopAllAction();
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}
