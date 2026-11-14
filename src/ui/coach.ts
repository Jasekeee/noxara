// First-match coaching cues (HUD only, never touches the sim). Shown for the first COACH_MATCHES matches on this device.
const KEY = "noxara.coach.matches.v1";
export const COACH_MATCHES = 3;
/** minimum pause between two coaching cues (ms) */
const MIN_GAP_MS = 3500;

function read(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export class Coach {
  private el: HTMLElement;
  private on = false;
  private hideT = 0;
  private lastShown = new Map<string, number>();
  private uses = new Map<string, number>();
  private once = new Set<string>();
  private lastAny = -99;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  /** Call when a match starts: counts it and decides whether cues are active for this one. */
  startMatch(enabled = true) {
    const n = read();
    this.on = enabled && n < COACH_MATCHES;
    try {
      localStorage.setItem(KEY, String(n + 1));
    } catch {
      /* private mode: cues just show every time */
    }
    this.lastAny = -99;
    this.lastShown.clear();
    this.uses.clear();
    this.once.clear();
    this.hide();
  }

  get active() {
    return this.on;
  }

  /** Show `text`; same key at most `max` times per match and not more often than every `gapMs`. */
  cue(key: string, text: string, now: number, opts: { ms?: number; gapMs?: number; max?: number } = {}) {
    if (!this.on) return false;
    // one cue at a time: never while another is on screen, and at least MIN_GAP_MS after the last one
    if (!this.el.classList.contains("hidden") || now - this.lastAny < MIN_GAP_MS / 1000) return false;
    const { ms = 2600, gapMs = 5000, max = 3 } = opts;
    if ((this.uses.get(key) ?? 0) >= max) return false;
    const last = this.lastShown.get(key);
    if (last !== undefined && now - last < gapMs) return false;
    this.lastShown.set(key, now);
    this.lastAny = now;
    this.uses.set(key, (this.uses.get(key) ?? 0) + 1);
    this.el.textContent = text;
    this.el.classList.remove("hidden");
    this.el.classList.remove("show");
    void this.el.offsetWidth;
    this.el.classList.add("show");
    clearTimeout(this.hideT);
    this.hideT = window.setTimeout(() => this.hide(), ms);
    return true;
  }

  /** A cue that is shown a single time per match. */
  cueOnce(key: string, text: string, now: number, ms = 4200) {
    if (this.once.has(key)) return false;
    if (this.cue(key, text, now, { ms, max: 1 })) {
      this.once.add(key);
      return true;
    }
    return false;
  }

  /** Show a message now regardless of the first-matches gate (one-off hints). */
  show(text: string, ms = 4200) {
    this.el.textContent = text;
    this.el.classList.remove("hidden");
    this.el.classList.remove("show");
    void this.el.offsetWidth;
    this.el.classList.add("show");
    clearTimeout(this.hideT);
    this.hideT = window.setTimeout(() => this.hide(), ms);
  }

  hide() {
    clearTimeout(this.hideT);
    this.el.classList.add("hidden");
    this.el.classList.remove("show");
  }
}
