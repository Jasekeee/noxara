// Tiny entry: the title screen is plain HTML/CSS and paints immediately. The 3D game (three.js, models,
// shaders) is a separate chunk loaded after the first paint, when the browser is idle — so a cold first
// visit shows the logo and PLAY at once, and pressing PLAY early simply starts the match when ready.
const play = document.getElementById("play");
play?.addEventListener("click", () => {
  if (play.getAttribute("aria-disabled") !== "true") return;
  (window as unknown as { __brWantPlay?: boolean }).__brWantPlay = true;
  play.textContent = "STARTING…";
});

// three.js evaluates in its own task first, then the game code in the next one (two shorter tasks).
const load = () =>
  void import("three").then(() => new Promise<void>((r) => setTimeout(r, 0))).then(() => import("./game"));
const whenIdle = (cb: () => void) =>
  "requestIdleCallback" in window ? requestIdleCallback(cb, { timeout: 600 }) : setTimeout(cb, 60);
requestAnimationFrame(() => setTimeout(() => whenIdle(load), 0));

export {};
