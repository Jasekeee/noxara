// DOM HUD: top chips, storm, kill feed, weapon card, hp, popups, damage numbers, minimap, hints.
import type { FighterState, Match, WeaponKind } from "../sim/types";
import { MATCH_TICKS, TICK_HZ } from "../sim/types";
import { WEAPON_LABEL } from "../render/palette";
import { IDLE_RELOAD, WEAPONS } from "../sim/rules";

/** 0..1 reload progress (empty mag: until readyTick; partial mag: idle refill), or null when not reloading. */
const rlStart = new Map<number, number>();
export function reloadProgress(f: FighterState, tick: number): number | null {
  const w = WEAPONS[f.weapon];
  if (f.ammo === 0) {
    if (!rlStart.has(f.idx)) rlStart.set(f.idx, Math.max(f.lastShotTick, tick - 1));
    const s0 = rlStart.get(f.idx)!;
    return Math.min(1, Math.max(0, (tick - s0) / Math.max(1, f.readyTick - s0)));
  }
  rlStart.delete(f.idx);
  if (f.ammo < w.mag) {
    const since = tick - f.lastShotTick;
    if (since >= 4 && since < IDLE_RELOAD) return since / IDLE_RELOAD;
  }
  return null;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Floater { el: HTMLDivElement; x: number; y: number; z: number; t: number; dur: number; vx: number; on: boolean }

export class Hud {
  private alive = $("alive");
  private kills = $("kills");
  private stormChip = $("storm-chip");
  private stormText = $("storm-text");
  private matchTime = $("match-time");
  private stormWarn = $("storm-warn");
  private feed = $("feed");
  private wIcon = $<HTMLImageElement>("weapon-icon");
  private wName = $("weapon-name");
  private ammo = $("ammo");
  private hpFill = $("hp-fill");
  private hpGhost = $("hp-ghost");
  private hpText = $("hp-text");
  private popupEl = $("popup");
  private bannerEl = $("banner");
  private hint = $("hint");
  private hitmarker = $("hitmarker");
  private vignette = $("vignette");
  private flashEl = $("flash");
  private mini = $<HTMLCanvasElement>("minimap");
  private miniCtx = this.mini.getContext("2d")!;
  private floaters: Floater[] = [];
  private fi = 0;
  private cache = new Map<string, string | number>();
  icons: Partial<Record<WeaponKind, string>> = {};
  private maxAmmo = new Map<WeaponKind, number>();
  private reloadStart = 0;
  private flashA = 0;
  hintsDone = false;
  portraits: string[] = [];
  private reloadTip = document.getElementById("reload-tip")!;
  private reloadTipShown = false;
  private dirEls: HTMLElement[] = [];
  private dirI = 0;
  private lastR = Infinity;
  private shrinkTick = -99;

  constructor() {
    const box = $("floaters");
    for (let i = 0; i < 40; i++) {
      const el = document.createElement("div");
      el.className = "dmg";
      el.style.opacity = "0";
      box.appendChild(el);
      this.floaters.push({ el, x: 0, y: 0, z: 0, t: 0, dur: 1, vx: 0, on: false });
    }
  }

  private set(key: string, v: string | number, fn: () => void) {
    if (this.cache.get(key) === v) return;
    this.cache.set(key, v);
    fn();
  }

  reset() {
    this.lastR = Infinity;
    this.shrinkTick = -99;
    this.feed.textContent = "";
    this.cache.clear();
    this.maxAmmo.clear();
    for (const f of this.floaters) { f.on = false; f.el.style.opacity = "0"; }
    this.vignette.className = "";
    this.hintsDone = false;
  }

  private hintTouch = false;
  showHints(touch: boolean) {
    this.hintTouch = touch;
    this.hint.innerHTML = touch
      ? `<span data-k="move">Left thumb: <b>move</b></span><span data-k="aim">Right thumb: <b>aim + shoot</b></span><span data-k="fire">Open <b>crates</b> for better blasters</span>`
      : `<span data-k="move"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move</span><span data-k="aim"><kbd>Mouse</kbd> aim</span><span data-k="fire"><kbd>Click</kbd> shoot</span>`;
    this.hint.classList.remove("hidden", "fade");
  }
  updateHints(used: { move: boolean; aim: boolean; fire: boolean }, elapsed: number, touch = false) {
    if (this.hintsDone) return;
    if (touch && !this.hintTouch) this.showHints(true); // a touch arrived after the chips were drawn
    for (const s of this.hint.querySelectorAll<HTMLElement>("span")) {
      const k = s.dataset.k as keyof typeof used;
      s.classList.toggle("done", !!used[k]);
    }
    if ((used.move && used.aim && used.fire && elapsed > 3) || elapsed > 12) {
      this.hintsDone = true;
      this.hint.classList.add("fade");
      setTimeout(() => this.hint.classList.add("hidden"), 900);
    }
  }

  update(m: Match, me: FighterState, watching: FighterState) {
    const st = m.state;
    this.set("alive", st.alive, () => (this.alive.textContent = String(st.alive)));
    this.set("kills", me.kills, () => {
      this.kills.textContent = String(me.kills);
    });
    const left = Math.max(0, MATCH_TICKS - st.tick);
    const secs = Math.ceil(left / TICK_HZ);
    this.set("time", secs, () => (this.matchTime.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`));
    if (st.storm.r < this.lastR) this.shrinkTick = st.tick;
    this.lastR = st.storm.r;
    const closing = st.tick - this.shrinkTick < 3;
    const soon = !closing && st.storm.targetR < st.storm.r - 1;
    this.set("storm", `${st.storm.phase}${closing}${soon}`, () => {
      this.stormText.textContent = closing ? "STORM CLOSING" : soon ? "STORM INCOMING" : st.storm.phase > 0 ? `STORM ${st.storm.phase}` : "SAFE ZONE";
      this.stormChip.classList.toggle("closing", closing);
    });
    const dx = me.x - st.storm.cx, dy = me.y - st.storm.cy;
    const outside = me.alive && dx * dx + dy * dy > st.storm.r * st.storm.r;
    const low = me.alive && me.hp / Math.max(1, me.maxHp) < 0.3;
    this.set("out", (outside ? 1 : 0) + (low ? 2 : 0) + st.storm.dps * 4, () => {
      this.stormWarn.classList.toggle("hidden", !outside);
      // say how much it hurts and what to do (cold judge #4: storm deaths were confusing)
      this.stormWarn.textContent = `OUTSIDE THE ZONE · −${st.storm.dps} HP/s · GET TO THE CIRCLE`;
      this.vignette.className = outside ? "on" : low ? "low" : "";
    });

    const w = watching;
    this.set("spec", w.idx === me.idx ? "" : w.name, () => {
      const el = document.getElementById("spec")!;
      el.classList.toggle("hidden", w.idx === me.idx);
      const t = document.getElementById("spec-text")!;
      t.textContent = "SPECTATING ";
      const b = document.createElement("b");
      b.textContent = w.name.toUpperCase();
      t.appendChild(b);
      const wn = document.getElementById("watch-name")!;
      wn.classList.toggle("hidden", w.idx === me.idx);
      wn.textContent = `${w.name}'s`;
    });
    this.set("wname", w.weapon + (this.icons[w.weapon] ? "+" : ""), () => {
      this.wName.textContent = WEAPON_LABEL[w.weapon];
      const ic = this.icons[w.weapon];
      if (ic) this.wIcon.src = ic;
    });
    const mx = WEAPONS[w.weapon].mag;
    const rp = reloadProgress(w, st.tick);
    if (w.ammo === 0) {
      const p = rp ?? 0;
      this.set("rl", 1, () => (this.ammo.innerHTML = `<span class="rl">RELOADING</span><span class="rlbar"><i></i></span>`));
      const bar = this.ammo.querySelector<HTMLElement>(".rlbar i");
      if (bar) bar.style.transform = `scaleX(${p.toFixed(2)})`;
      if (w.idx === me.idx && !this.reloadTipShown) {
        this.reloadTipShown = true;
        this.reloadTip.classList.remove("hidden");
        setTimeout(() => this.reloadTip.classList.add("hidden"), 2600);
      }
    } else {
      this.set("rl", 0, () => {});
      this.set("ammo", `${w.weapon}${w.ammo}/${mx}`, () => {
        let h = "";
        const n = Math.min(mx, 12);
        for (let i = 0; i < n; i++) h += i < w.ammo ? "<i></i>" : '<i class="off"></i>';
        h += '<span class="idlebar"><i></i></span>';
        this.ammo.innerHTML = h;
      });
      const ib = this.ammo.querySelector<HTMLElement>(".idlebar");
      if (ib) {
        const show = rp !== null;
        ib.style.opacity = show ? "1" : "0";
        if (show) (ib.firstElementChild as HTMLElement).style.transform = `scaleX(${rp!.toFixed(2)})`;
      }
    }
    const hp = Math.max(0, Math.ceil(w.hp));
    this.set("hp", `${hp}/${w.maxHp}`, () => {
      const f = Math.max(0, w.hp / Math.max(1, w.maxHp));
      this.hpFill.style.transform = `scaleX(${f})`;
      this.hpGhost.style.transform = `scaleX(${f})`;
      this.hpFill.classList.toggle("low", f < 0.35);
      this.hpText.textContent = String(hp);
    });

    if (this.flashA > 0) {
      this.flashA = Math.max(0, this.flashA - 0.08);
      this.flashEl.style.opacity = String(this.flashA);
    }
  }

  /** Red wedge at the screen edge pointing toward whoever just hit you (angle: 0 = up, clockwise). */
  damageDir(angle: number) {
    if (!this.dirEls.length) {
      const box = document.getElementById("dmgdir")!;
      for (let i = 0; i < 4; i++) this.dirEls.push(box.appendChild(document.createElement("i")));
    }
    const el = this.dirEls[this.dirI];
    this.dirI = (this.dirI + 1) % this.dirEls.length;
    const r = Math.min(innerWidth, innerHeight) * 0.3;
    el.style.transform = `rotate(${angle.toFixed(3)}rad) translateY(${-r}px)`;
    el.animate([{ opacity: 1 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 900, easing: "ease-out" });
  }

  feedBounty(by: string, victim: string, value: number, me: boolean) {
    const li = document.createElement("li");
    li.className = "bounty";
    li.textContent = value > 0 ? `${by} claimed the ${value.toLocaleString("en-US")} NOX bounty on ${victim}!` : `${by} claimed the bounty on ${victim}!`;
    if (me) li.classList.add("me");
    this.feed.prepend(li);
    while (this.feed.children.length > 5) this.feed.lastElementChild!.remove();
    setTimeout(() => li.classList.add("out"), 6500);
    setTimeout(() => li.remove(), 7000);
  }

  /** A gold kill-feed line with ready text (bounty claims). */
  feedLine(text: string, me: boolean) {
    const li = document.createElement("li");
    li.className = "bounty" + (me ? " me" : "");
    li.textContent = text;
    this.feed.prepend(li);
    while (this.feed.children.length > 5) this.feed.lastElementChild!.remove();
    setTimeout(() => li.classList.add("out"), 6500);
    setTimeout(() => li.remove(), 7000);
  }

  // ---------------------------------------------------------------- events
  feedItem(killer: string | null, victim: string, weapon: WeaponKind | "storm", opts: { me?: boolean; bounty?: boolean; kAcct?: string; vAcct?: string }) {
    const li = document.createElement("li");
    if (opts.bounty) li.className = "bounty";
    else if (opts.me) li.className = "me";
    const k = document.createElement("span");
    k.textContent = killer ?? "";
    const icon = weapon === "storm" ? Object.assign(document.createElement("span"), { className: "storm", textContent: "STORM" }) : Object.assign(document.createElement("img"), { src: this.icons[weapon] ?? "", alt: weapon });
    const v = document.createElement("span");
    v.textContent = victim;
    if (opts.kAcct) k.title = opts.kAcct;
    if (opts.vAcct) v.title = opts.vAcct;
    if (killer) li.append(k);
    li.append(icon, v);
    if (opts.bounty) li.append(Object.assign(document.createElement("span"), { className: "crown", textContent: "BOUNTY!" }));
    this.feed.prepend(li);
    while (this.feed.children.length > 5) this.feed.lastElementChild!.remove();
    setTimeout(() => li.classList.add("out"), 5200);
    setTimeout(() => li.remove(), 5700);
  }

  popup(text: string, cls = "") {
    const el = this.popupEl;
    el.textContent = text;
    el.className = "popup";
    void el.offsetWidth;
    el.className = `popup show ${cls}`;
  }
  banner(text: string, cls = "") {
    const el = this.bannerEl;
    el.textContent = text;
    el.className = "banner";
    void el.offsetWidth;
    el.className = `banner show ${cls}`;
  }
  hitMark(x: number, y: number, kill: boolean) {
    const el = this.hitmarker;
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.className = "";
    void el.offsetWidth;
    el.className = kill ? "on kill" : "on";
  }
  hurtFlash() {
    this.vignette.classList.add("hurt");
    setTimeout(() => this.vignette.classList.remove("hurt"), 160);
  }
  whiteFlash(a: number) {
    this.flashA = Math.max(this.flashA, a);
  }

  private stackT = new Map<number, { t: number; n: number }>();
  floater(text: string, x: number, y: number, z: number, cls: string, key = -1) {
    if (key >= 0) {
      const now = performance.now();
      const st = this.stackT.get(key);
      const n = st && now - st.t < 350 ? st.n + 1 : 0;
      this.stackT.set(key, { t: now, n });
      y += (n % 4) * 0.55;
      x += (n % 2 ? 0.5 : -0.5) * Math.min(1, n);
    }
    const f = this.floaters[this.fi];
    this.fi = (this.fi + 1) % this.floaters.length;
    f.el.textContent = text;
    f.el.className = `dmg ${cls}`;
    f.x = x + (Math.random() - 0.5) * 0.6;
    f.y = y;
    f.z = z;
    f.t = 0;
    f.dur = cls.includes("crit") ? 0.95 : 0.75;
    f.vx = (Math.random() - 0.5) * 40;
    f.on = true;
  }
  /** project: world -> screen px; returns false if behind camera */
  updateFloaters(dt: number, project: (x: number, y: number, z: number) => { x: number; y: number } | null) {
    for (const f of this.floaters) {
      if (!f.on) continue;
      f.t += dt;
      const k = f.t / f.dur;
      if (k >= 1) { f.on = false; f.el.style.opacity = "0"; continue; }
      const p = project(f.x, f.y, f.z);
      if (!p) continue;
      const rise = 50 * (1 - (1 - k) * (1 - k));
      const sc = k < 0.15 ? 0.6 + (k / 0.15) * 0.8 : 1.4 - Math.min(0.4, (k - 0.15) * 1.5);
      f.el.style.transform = `translate(${(p.x + f.vx * k).toFixed(1)}px, ${(p.y - rise).toFixed(1)}px) translate(-50%, -50%) scale(${sc.toFixed(2)})`;
      f.el.style.opacity = String(k > 0.7 ? (1 - k) / 0.3 : 1);
    }
  }

  minimap(m: Match, me: number, visible: (i: number) => boolean) {
    const c = this.miniCtx, W = this.mini.width;
    const R = m.map.radius, s = (W / 2 - 6) / R;
    c.clearRect(0, 0, W, W);
    c.save();
    c.translate(W / 2, W / 2);
    c.fillStyle = "#3b9fc0";
    c.beginPath(); c.arc(0, 0, W / 2, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#f4d79c";
    c.beginPath(); c.arc(0, 0, R * s, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#74c64e";
    c.beginPath(); c.arc(0, 0, R * s - 3, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#3f8d34";
    for (const b of m.map.bushes) { c.beginPath(); c.arc(b.x * s, b.y * s, Math.max(2, b.r * s), 0, Math.PI * 2); c.fill(); }
    const st = m.state;
    // storm
    c.fillStyle = "rgba(138,60,255,.45)";
    c.beginPath();
    c.arc(0, 0, W, 0, Math.PI * 2);
    c.arc(st.storm.cx * s, st.storm.cy * s, st.storm.r * s, 0, Math.PI * 2, true);
    c.fill();
    if (st.storm.targetR < st.storm.r) {
      c.strokeStyle = "#fff"; c.lineWidth = 1.5; c.setLineDash([3, 3]);
      c.beginPath(); c.arc((st.storm.tx ?? st.storm.cx) * s, (st.storm.ty ?? st.storm.cy) * s, st.storm.targetR * s, 0, Math.PI * 2); c.stroke();
      c.setLineDash([]);
    }
    for (const ch of st.chests) if (!ch.open) { c.fillStyle = "#ffc93c"; c.fillRect(ch.x * s - 2.5, ch.y * s - 2.5, 5, 5); }
    for (const f of st.fighters) {
      if (!f.alive || f.idx === me || f.bounty) continue;
      if (!visible(f.idx)) continue;
      c.fillStyle = "#ff5a5f";
      c.beginPath(); c.arc(f.x * s, f.y * s, 3, 0, Math.PI * 2); c.fill();
    }
    // the bounty carrier is always on the map: a pulsing gold crown
    const b = st.fighters.find((f) => f.bounty && f.alive);
    if (b) {
      const k = 1 + Math.sin(performance.now() * 0.008) * 0.18;
      const x = b.x * s, y = b.y * s, r = 7 * k;
      c.fillStyle = "rgba(255,201,60,.3)";
      c.beginPath(); c.arc(x, y, r * 1.6, 0, Math.PI * 2); c.fill();
      c.beginPath();
      c.moveTo(x - r, y + r * 0.6); c.lineTo(x - r, y - r * 0.4); c.lineTo(x - r * 0.5, y); c.lineTo(x, y - r * 0.8);
      c.lineTo(x + r * 0.5, y); c.lineTo(x + r, y - r * 0.4); c.lineTo(x + r, y + r * 0.6); c.closePath();
      c.fillStyle = "#ffc93c"; c.strokeStyle = "#15112b"; c.lineWidth = 1.5; c.fill(); c.stroke();
    }
    const p = st.fighters[me];
    if (p.alive) {
      const a = (p.aim / 4096) * Math.PI * 2;
      c.fillStyle = "#3df2ff"; c.strokeStyle = "#15112b"; c.lineWidth = 2;
      c.beginPath();
      c.moveTo(p.x * s + Math.cos(a) * 7, p.y * s + Math.sin(a) * 7);
      c.lineTo(p.x * s + Math.cos(a + 2.4) * 5, p.y * s + Math.sin(a + 2.4) * 5);
      c.lineTo(p.x * s + Math.cos(a - 2.4) * 5, p.y * s + Math.sin(a - 2.4) * 5);
      c.closePath(); c.stroke(); c.fill();
    }
    c.restore();
  }
}
