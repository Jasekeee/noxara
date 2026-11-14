// Title menu: mode selector (what PLAY does), the How-to-play sheet and the Weekly Bounty Cup card.
// Plain DOM, no three.js: main.ts initialises it at first paint so the menu works while the 3D loads.
import { BIG_ISLAND_ENABLED } from "../modes";
import { CUP, renderCup } from "./cup";
import { h } from "./dom";

export type Mode = "standard" | "training" | "big";
const KEY = "noxara.mode";
const DESC: Record<Mode, string> = {
  standard: "10 fighters. 3 minutes. Last one standing wins the pot.",
  training: "Easy bots. Nothing recorded. Learn the island.",
  big: "3x map. Dense cover. About 7 minutes. Offline.",
};

let mode: Mode = "standard";
const listeners: ((m: Mode) => void)[] = [];
export const getMode = (): Mode => mode;
export const onMode = (fn: (m: Mode) => void) => void listeners.push(fn);

function load(): Mode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "standard" || v === "training" || (v === "big" && BIG_ISLAND_ENABLED)) return v;
  } catch {
    /* storage blocked */
  }
  return "standard";
}

function setMode(m: Mode, seg: HTMLElement, persist = true) {
  mode = m;
  if (persist) {
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* ignore */
    }
  }
  for (const b of Array.from(seg.querySelectorAll<HTMLButtonElement>(".seg[data-mode]"))) {
    const on = b.dataset.mode === m;
    b.setAttribute("aria-pressed", String(on));
    if (!b.classList.contains("soon")) b.tabIndex = on ? 0 : -1;
  }
  const d = document.getElementById("mode-desc");
  if (d) d.textContent = DESC[m];
  for (const fn of listeners) fn(m);
}

// ---- a small modal sheet (How to play, cup rules): Esc / backdrop / close button, Tab stays inside
let sheet: HTMLElement | null = null;
let sheetFrom: HTMLElement | null = null;
function closeSheet() {
  if (!sheet) return;
  sheet.remove();
  sheet = null;
  sheetFrom?.focus({ preventScroll: true });
}
export function openSheet(title: string, body: Node) {
  closeSheet();
  sheetFrom = document.activeElement as HTMLElement | null;
  const card = h("div", "sheet-card");
  const x = h("button", "btn-chip sheet-x", "CLOSE");
  x.type = "button";
  x.addEventListener("click", closeSheet);
  const t = h("h2", "", title);
  t.id = "sheet-title";
  card.append(h("div", "sheet-head", undefined, t, x), body);
  const el = h("div", "sheet");
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "sheet-title");
  el.appendChild(card);
  el.addEventListener("click", (e) => {
    if (e.target === el) closeSheet();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeSheet();
    } else if (e.key === "Tab") {
      const f = Array.from(el.querySelectorAll<HTMLElement>("button, a[href]"));
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    }
  });
  sheet = el;
  document.getElementById("app")!.appendChild(el);
  x.focus({ preventScroll: true });
}

function howTo(): Node {
  const wrap = h("div", "sheet-body");
  const col = (title: string, rows: [string, string][]) => {
    const c = h("div", "howto-col", undefined, h("h3", "", title));
    for (const [k, v] of rows) c.appendChild(h("p", "", undefined, h("kbd", "", k), document.createTextNode(v)));
    return c;
  };
  wrap.append(
    h("div", "howto-cols", undefined,
      col("Keyboard + mouse", [["WASD", "Move"], ["Mouse", "Aim"], ["Click", "Shoot"], ["M", "Mute"], ["Esc", "Pause"]]),
      col("Phone", [["Left thumb", "Move"], ["Right thumb", "Aim and shoot"]]),
    ),
    h("ul", "howto-tips", undefined,
      h("li", "", "Bushes hide you."),
      h("li", "", "Gold crates hold better guns. Green crosses heal."),
      h("li", "", "The storm shrinks the island. Stay inside."),
      h("li", "", "The richest fighter wears the crown. Kill them. Take the bounty."),
    ),
  );
  return wrap;
}

function cupRules(): Node {
  const wrap = h("div", "sheet-body");
  const ul = h("ul", "cup-rules");
  for (const r of CUP.rules) ul.appendChild(h("li", "", r));
  wrap.appendChild(ul);
  return wrap;
}

let boardOpener: (() => void) | null = null;
/** game.ts registers the leaderboard opener (players tab) once it has loaded. */
export const setBoardOpener = (fn: () => void) => void (boardOpener = fn);

export function initTitleMenu() {
  const seg = document.getElementById("mode-seg");
  if (!seg) return;
  if (!BIG_ISLAND_ENABLED) {
    const b = document.getElementById("big-island") as HTMLButtonElement;
    b.classList.add("soon");
    b.setAttribute("aria-disabled", "true");
    b.tabIndex = -1;
    b.append(" ", Object.assign(document.createElement("i"), { className: "soon-badge", textContent: "SOON" }));
  }
  const live = () => Array.from(seg.querySelectorAll<HTMLButtonElement>(".seg[data-mode]:not(.soon)"));
  setMode(load(), seg, false);
  seg.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".seg[data-mode]");
    if (!b || b.classList.contains("soon")) return;
    setMode(b.dataset.mode as Mode, seg);
  });
  seg.addEventListener("keydown", (e) => {
    const k = e.key;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(k)) return;
    const l = live();
    const i = l.findIndex((b) => b === document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const n = k === "Home" ? 0 : k === "End" ? l.length - 1 : (i + (k === "ArrowLeft" || k === "ArrowUp" ? -1 : 1) + l.length) % l.length;
    l[n].focus();
    setMode(l[n].dataset.mode as Mode, seg);
  });
  document.getElementById("howto-btn")?.addEventListener("click", () => openSheet("HOW TO PLAY", howTo()));
  const cup = document.getElementById("cup");
  if (cup) renderCup(cup, () => (boardOpener ?? (() => document.getElementById("nav-board")?.click()))(), () => openSheet("WEEKLY BOUNTY CUP: RULES", cupRules()));
}
