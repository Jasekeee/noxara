// Player progression UI: XP bar on the end card (fills, level-up moment), level badge, unlock list.
// XP rules live in src/sim/progression.ts. Offline/guest XP is kept in localStorage for display only.
import { levelProgress, unlocksForLevel } from "../sim/progression";
import { h, icon, ICON } from "./dom";

const KEY = "bountyroyale.xp.v1";

export function localXp(): number {
  try {
    const v = Number(localStorage.getItem(KEY) ?? 0);
    return Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
  } catch {
    return 0;
  }
}
export function setLocalXp(xp: number) {
  try {
    localStorage.setItem(KEY, String(Math.max(0, Math.trunc(xp))));
  } catch {
    /* private mode: progress just isn't remembered */
  }
}

const pct = (xp: number) => {
  const p = levelProgress(xp);
  return p.nextAt === null ? 100 : ((xp - p.levelAt) / (p.nextAt - p.levelAt)) * 100;
};

/**
 * Draw the XP box and animate before -> after. Calls onLevelUp(level, unlocks) for each level gained,
 * at the moment the bar fills.
 */
export function renderXp(el: HTMLElement, before: number, after: number, onLevelUp: (level: number, unlocks: string[]) => void) {
  el.textContent = "";
  const p0 = levelProgress(before);
  const lvl = h("div", "xp-lvl", undefined, h("small", "", "LEVEL"), h("b", "", p0.level));
  const fill = h("i", "xp-fill");
  const bar = h("div", "xp-bar", undefined, fill);
  const gain = h("span", "xp-gain", `+${after - before} XP`);
  const num = h("span", "xp-num", "");
  const unl = h("ul", "xp-unlocks");
  el.append(h("div", "xp-row", undefined, lvl, h("div", "xp-main", undefined, h("div", "xp-top", undefined, gain, num), bar)), unl);
  const setNum = (xp: number) => {
    const p = levelProgress(xp);
    num.textContent = p.nextAt === null ? `${xp} XP · max level` : `${xp - p.levelAt} / ${p.nextAt - p.levelAt} XP`;
  };
  fill.style.transition = "none";
  fill.style.width = `${pct(before)}%`;
  setNum(before);
  if (after <= before) return;

  // step through every level boundary
  const steps: { to: number; level: number; up: boolean }[] = [];
  let cur = before;
  while (cur < after) {
    const p = levelProgress(cur);
    if (p.nextAt !== null && after >= p.nextAt) {
      steps.push({ to: p.nextAt, level: p.level + 1, up: true });
      cur = p.nextAt;
    } else {
      steps.push({ to: after, level: p.level, up: false });
      cur = after;
    }
  }
  let i = 0;
  const run = () => {
    if (i >= steps.length || !el.isConnected) return;
    const s = steps[i++];
    fill.style.transition = "width .9s cubic-bezier(.3,.8,.3,1)";
    fill.style.width = s.up ? "100%" : `${pct(s.to)}%`;
    setTimeout(() => {
      setNum(s.to);
      if (s.up) {
        lvl.lastElementChild!.textContent = String(s.level);
        lvl.classList.remove("pop");
        void lvl.offsetWidth;
        lvl.classList.add("pop");
        const u = unlocksForLevel(s.level);
        for (const t of u) unl.appendChild(h("li", "", undefined, icon(ICON.up), h("span", "", t)));
        onLevelUp(s.level, u);
        fill.style.transition = "none";
        fill.style.width = "0%";
        void fill.offsetWidth;
      }
      setTimeout(run, s.up ? 450 : 0);
    }, 950);
  };
  setTimeout(run, 500);
}

/** Small "Lv 3" badge with a mini bar (lobby / HUD). */
export function levelBadge(el: HTMLElement, xp: number) {
  const p = levelProgress(xp);
  el.textContent = "";
  const f = h("i");
  f.style.width = `${pct(xp)}%`;
  el.append(h("b", "", `Lv ${p.level}`), h("span", "lv-bar", undefined, f));
  el.title = p.nextAt === null ? `Level ${p.level} (max)` : `Level ${p.level} — ${xp - p.levelAt}/${p.nextAt - p.levelAt} XP to level ${p.level + 1}`;
}
