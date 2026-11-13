// Tiny DOM helpers. Text always goes through textContent (names come from the chain: never innerHTML).

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string | number, ...kids: (Node | null | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== "") el.textContent = String(text);
  for (const k of kids) if (k) el.appendChild(k);
  return el;
}

const NS = "http://www.w3.org/2000/svg";
/** An inline SVG icon from one path (24×24 viewBox). */
export function icon(d: string, cls = "ic"): SVGSVGElement {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("class", cls);
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", d);
  s.appendChild(p);
  return s;
}

export const ICON = {
  crown: "M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z",
  coin: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM8.5 7h2.1l2.9 5.6V7h2v10h-2.1l-2.9-5.6V17h-2z",
  check: "M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z",
  skull: "M12 2a9 9 0 0 0-9 9c0 3 1.5 5.6 4 7.2V22h3v-2h4v2h3v-3.8c2.5-1.6 4-4.2 4-7.2a9 9 0 0 0-9-9zM8.5 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4z",
  up: "M12 4l8 8h-5v8H9v-8H4z",
  star: "M12 2l3 7 7 .6-5.3 4.7 1.6 7.2L12 17.8 5.7 21.5l1.6-7.2L2 9.6 9 9z",
  link: "M10.6 13.4a1 1 0 0 1 0-1.4l3.5-3.5a1 1 0 1 1 1.4 1.4L12 13.4a1 1 0 0 1-1.4 0zM7.8 19.1a3.5 3.5 0 0 1-2.5-6l2.8-2.8 1.4 1.4-2.8 2.8a1.5 1.5 0 1 0 2.1 2.1l2.8-2.8 1.4 1.4-2.8 2.8a3.5 3.5 0 0 1-2.4 1.1zm8.5-5.3l-1.4-1.4 2.8-2.8a1.5 1.5 0 1 0-2.1-2.1l-2.8 2.8-1.4-1.4 2.8-2.8a3.5 3.5 0 1 1 4.9 4.9z",
};

export const PERSONALITY_ICON: Record<string, string> = {
  aggressive: "M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-7 0 2 1 3 2 3 0-3-1-5 1-8z",
  camper: "M12 3L2 21h20L12 3zm0 6l5 10h-3l-2-4-2 4H7z",
  sniper: "M11 2h2v4h-2zM11 18h2v4h-2zM2 11h4v2H2zM18 11h4v2h-4zM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6z",
  looter: "M9 3h6l-1 3h-4zM7 7h10c3 3 4 7 4 10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4c0-3 1-7 4-10z",
  coward: "M5 2h2v20H5zM8 3c4-2 6 2 11 0v9c-5 2-7-2-11 0z",
  balanced: "M12 2l10 10-10 10L2 12z",
};

export const PERSONALITY_COLOR: Record<string, string> = {
  aggressive: "#ff5a5f",
  camper: "#9be15d",
  sniper: "#c08bff",
  looter: "#ffc93c",
  coward: "#9ad7ff",
  balanced: "#ffffff",
};

export const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
