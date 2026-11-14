// Tiny entry: the title screen is plain HTML/CSS and paints immediately. The 3D game (three.js, models,
// shaders) is a separate chunk loaded after the first paint, when the browser is idle — so a cold first
// visit shows the logo and PLAY at once, and pressing PLAY early simply starts the match when ready.
import { prefetchModels } from "./render/modelList";

// the island's models start downloading now, in parallel with the three.js and game chunks (?offline e2e runs too)
prefetchModels();

import { initTitleMenu } from "./ui/titlemenu";
initTitleMenu();
const play = document.getElementById("play");
// PLAY is clickable from the first paint: pressed while the 3D still loads, the match starts as soon as it's ready.
play?.addEventListener("click", () => {
  if (play.dataset.loading !== "1") return;
  (window as unknown as { __brWantPlay?: boolean }).__brWantPlay = true;
  play.textContent = "STARTING…";
});

// three.js evaluates in its own task first, then the game code in the next one (two shorter tasks).
const load = () =>
  void import("three").then(() => new Promise<void>((r) => setTimeout(r, 0))).then(() => import("./game"));
// start right after the first paint (no idle wait: the title is already on screen and interactive)
requestAnimationFrame(() => setTimeout(load, 0));

export {};
