// Synthesized sound effects (WebAudio, jsfxr-style: oscillators + noise + envelopes). No samples.
import type { WeaponKind } from "../sim/types";

type Wave = OscillatorType;

class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  muted = false;
  private armed = false;
  private voices = 0;
  private last = new Map<string, number>();

  /** Creates/resumes the context, but only once the page has had a user gesture (no autoplay warnings). */
  start() {
    const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    if (ua && !ua.hasBeenActive) {
      if (!this.armed) {
        this.armed = true;
        const go = () => { removeEventListener("pointerdown", go); removeEventListener("keydown", go); this.start(); };
        addEventListener("pointerdown", go);
        addEventListener("keydown", go);
      }
      return;
    }
    if (this.ctx) { if (this.ctx.state === "suspended") void this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.55, this.ctx.currentTime, 0.02);
    return this.muted;
  }

  private ok(key: string, minGap: number): boolean {
    if (!this.ctx || this.muted || this.voices > 28) return false;
    const now = this.ctx.currentTime;
    const l = this.last.get(key) ?? -1;
    if (now - l < minGap) return false;
    this.last.set(key, now);
    return true;
  }

  private env(g: GainNode, t: number, a: number, peak: number, dec: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
  }

  private tone(wave: Wave, f0: number, f1: number, dur: number, vol: number, delay = 0, a = 0.004) {
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = wave;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    this.env(g, t, a, vol, dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + a + dur + 0.02);
    this.voices++;
    o.onended = () => this.voices--;
  }

  private hiss(dur: number, vol: number, fFrom: number, fTo: number, type: BiquadFilterType = "lowpass", delay = 0, q = 1) {
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(fFrom, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, fTo), t + dur);
    const g = c.createGain();
    this.env(g, t, 0.003, vol, dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
    this.voices++;
    s.onended = () => this.voices--;
  }

  /** vol 0..1 from distance to the listener */
  shot(kind: WeaponKind, vol = 1) {
    if (vol < 0.05 || !this.ok("shot" + kind, 0.03)) return;
    const v = vol;
    const j = 1 + (Math.random() - 0.5) * 0.08;
    switch (kind) {
      case "popper":
        this.tone("square", 900 * j, 260, 0.08, 0.16 * v);
        this.hiss(0.05, 0.12 * v, 5000, 1500, "highpass");
        break;
      case "blaster":
        this.tone("sawtooth", 1300 * j, 180, 0.12, 0.15 * v);
        this.tone("square", 650 * j, 120, 0.1, 0.08 * v);
        this.hiss(0.06, 0.12 * v, 7000, 2000, "bandpass", 0, 0.8);
        break;
      case "shotgun":
        this.hiss(0.28, 0.5 * v, 3000, 120);
        this.tone("square", 180 * j, 45, 0.18, 0.22 * v);
        break;
      case "sniper":
        this.tone("sawtooth", 2400 * j, 90, 0.35, 0.18 * v);
        this.hiss(0.4, 0.3 * v, 6000, 200);
        this.tone("sine", 120, 40, 0.3, 0.3 * v);
        break;
      case "grenade":
        this.tone("triangle", 300 * j, 600, 0.12, 0.12 * v);
        this.hiss(0.1, 0.1 * v, 2000, 800, "bandpass");
        break;
    }
  }
  hit(crit: boolean, mine: boolean) {
    if (!this.ok("hit", 0.035)) return;
    if (mine) {
      this.tone("square", crit ? 1500 : 1100, crit ? 2200 : 1300, 0.06, crit ? 0.16 : 0.11);
      if (crit) this.tone("sine", 2600, 2600, 0.12, 0.08, 0.03);
    } else this.hiss(0.08, 0.15, 2500, 600, "bandpass");
  }
  hurt() {
    if (!this.ok("hurt", 0.08)) return;
    this.tone("sawtooth", 220, 70, 0.18, 0.2);
    this.hiss(0.12, 0.2, 1500, 300);
  }
  kill(mine: boolean) {
    if (!this.ok("kill", 0.05)) return;
    if (mine) {
      [660, 880, 1320].forEach((f, i) => this.tone("square", f, f * 1.01, 0.1, 0.13, i * 0.06));
      this.tone("sine", 1760, 1760, 0.3, 0.08, 0.18);
    } else {
      this.tone("triangle", 500, 120, 0.25, 0.12);
    }
  }
  poof(vol = 1) {
    if (vol < 0.05 || !this.ok("poof", 0.05)) return;
    this.hiss(0.35, 0.3 * vol, 1800, 150);
  }
  chest() {
    if (!this.ok("chest", 0.05)) return;
    this.hiss(0.18, 0.3, 800, 200);
    [523, 659, 784, 1047].forEach((f, i) => this.tone("triangle", f, f, 0.16, 0.16, 0.05 + i * 0.07));
    this.tone("sine", 2093, 2093, 0.4, 0.06, 0.35);
  }
  pickup() {
    if (!this.ok("pickup", 0.05)) return;
    this.tone("square", 600, 1200, 0.12, 0.1);
  }
  heal() {
    if (!this.ok("heal", 0.1)) return;
    [392, 523, 659, 784].forEach((f, i) => this.tone("sine", f, f * 1.02, 0.2, 0.14, i * 0.06));
  }
  explode(vol = 1) {
    if (vol < 0.05 || !this.ok("boom", 0.05)) return;
    this.hiss(0.9, 0.75 * vol, 2500, 60);
    this.tone("sine", 140, 28, 0.7, 0.5 * vol);
    this.tone("square", 90, 30, 0.3, 0.15 * vol);
  }
  stormTick() {
    if (!this.ok("stick", 0.2)) return;
    this.tone("square", 180, 160, 0.06, 0.08);
    this.tone("sine", 90, 70, 0.15, 0.12);
  }
  stormWarn() {
    if (!this.ok("swarn", 0.5)) return;
    this.tone("sawtooth", 220, 440, 0.5, 0.12);
    this.tone("sawtooth", 233, 466, 0.5, 0.1, 0.02);
    this.tone("sine", 110, 110, 0.9, 0.12, 0.1);
  }
  ui() {
    if (!this.ok("ui", 0.04)) return;
    this.tone("square", 520, 780, 0.07, 0.1);
  }
  victory() {
    if (!this.ok("vic", 1)) return;
    const n = [523, 659, 784, 1047, 784, 1047, 1319];
    n.forEach((f, i) => this.tone(i % 2 ? "triangle" : "square", f, f, i === n.length - 1 ? 0.7 : 0.14, 0.13, i * 0.11));
    this.tone("sine", 262, 262, 1.2, 0.15, 0.1);
  }
  defeat() {
    if (!this.ok("def", 1)) return;
    [392, 370, 349, 262].forEach((f, i) => this.tone("triangle", f, f * 0.98, i === 3 ? 0.8 : 0.22, 0.15, i * 0.2));
  }
  countTick(go: boolean) {
    if (!this.ok(go ? "go" : "count", 0.3)) return;
    if (go) {
      this.tone("square", 784, 784, 0.1, 0.14);
      this.tone("square", 1568, 1568, 0.35, 0.12, 0.08);
    } else this.tone("square", 523, 523, 0.12, 0.12);
  }
  levelUp() {
    if (!this.ok("lvl", 0.5)) return;
    [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone("square", f, f * 1.01, 0.12, 0.12, i * 0.07));
    this.tone("triangle", 1568, 2093, 0.5, 0.1, 0.38);
  }
  reload() {
    if (!this.ok("reload", 0.3)) return;
    this.tone("square", 300, 260, 0.04, 0.07);
    this.tone("square", 520, 560, 0.05, 0.07, 0.12);
  }
}

export const sfx = new Sfx();
