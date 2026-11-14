// "About the game": the pitch, three steps, the economy in plain words, the NEAR links. Safe to open anywhere (it is a page, not a mode).
import type { GameClient } from "../net/api";
import { h, icon, ICON } from "./dom";
import { NEAR_NETWORK } from "../net/client";

/** Mainnet links, filled in after the owner's mainnet deploy (docs/SUBMISSION.md §5). null = not deployed yet. */
export const MAINNET: { contract: string | null; deployTx: string | null; explorer: string } = {
  contract: "noxara.near",
  deployTx: "BmMiB9ccNQcWkGnFZxCLMG8VQRn7GDBGT1EHXK2r26H6",
  explorer: "https://nearblocks.io",
};
export const GITHUB_URL = "https://github.com/Jasekeee/noxara";
export const GAME_URL = "https://playnoxara.vercel.app";
/** The launch post on X; null until it is published (no fake link). */
export const X_POST_URL: string | null = null;

export interface AboutDeps {
  client(): GameClient | null;
  near(): void;
  economy(): void;
}

function ext(text: string, href: string) {
  const a = h("a", "near-link", undefined, icon(ICON.link), h("span", "", text));
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

export function renderAbout(body: HTMLElement, d: AboutDeps) {
  body.textContent = "";
  const sec = (title: string, ...kids: (Node | string)[]) => {
    const s = h("section", "ab-sec");
    s.append(h("h3", "ab-h", title), ...kids);
    body.appendChild(s);
  };
  body.appendChild(h("p", "page-lede", "Only one walks out. Take out the richest mercenary. Claim the bounty."));

  const steps = h("ol", "ab-steps");
  const step = (t: string, text: string) => steps.appendChild(h("li", "ab-step", undefined, h("div", "", undefined, h("b", "", t), h("p", "", text))));
  step("Move, aim, shoot", "WASD or the left stick moves you. Aim with the mouse or the right stick and shoot where you aim. There is no auto-aim: every shot is yours.");
  step("Hide and loot", "Bushes hide you from everyone outside arm's reach. Crates with a gold beam hold a better weapon (blaster, shotgun, sniper or grenades); green crosses heal. Keep moving: the storm shrinks the island.");
  step("Outlast the storm", "The richest fighter carries the bounty and wears the crown. Last one standing takes the pot.");
  sec("How to play", steps);

  sec(
    "How the economy works",
    h("p", "ab-p", undefined, h("b", "", "The House. "), document.createTextNode("The treasury behind every match. It follows one public rule, nothing is minted after genesis, and a share of every pot is burned.")),
    h("p", "ab-p", undefined, h("b", "", "The bounty. "), document.createTextNode("The richest bot is the Mark. Whoever takes it down collects it.")),
    h("p", "ab-p", undefined, h("b", "", "Bot shares. "), document.createTextNode("Fans can own shares of a fighter. Dividends are paid only from profit. If the fighter goes broke, its shares go to zero.")),
    h("p", "sc-note", "NOX is play-money with no real-world value. Ranked (on-chain) play runs until 2026-11-20 00:00 UTC; practice modes are always available."),
  );
  const eco = h("button", "btn-chip", "OPEN THE ECONOMY");
  eco.type = "button";
  eco.addEventListener("click", d.economy);
  body.lastElementChild!.appendChild(eco);

  const c = d.client();
  const links = h("div", "lg-links ab-links");
  const near = h("button", "btn-chip", "HOW NEAR POWERS NOXARA");
  near.type = "button";
  near.addEventListener("click", d.near);
  if (c && c.mode === "chain") {
    const id = (c as GameClient & { contractId?: string }).contractId;
    if (id) {
      links.appendChild(ext(`Game contract (${NEAR_NETWORK}): ${id}`, c.explorerAccount(id)));
      links.appendChild(ext("Live transactions on the explorer", c.explorerAccount(id)));
    }
  }
  if (MAINNET.contract) links.appendChild(ext(`Mainnet contract: ${MAINNET.contract}`, `${MAINNET.explorer}/address/${MAINNET.contract}`));
  if (MAINNET.deployTx) links.appendChild(ext("Mainnet deploy tx", `${MAINNET.explorer}/txns/${MAINNET.deployTx}`));
  sec(
    "Built on NEAR",
    h("p", "ab-p", "Every bot is a keyless NEAR account with a real balance, and you can open any fighter on the explorer from the Fighters page. Guests play with no wallet and no gas. Matches are verified: the server replays the inputs and the settle transaction is on chain."),
    links,
    ...(!MAINNET.contract ? [h("p", "sc-note", "Mainnet links are filled in after the mainnet deploy.")] : []),
    near,
  );

  sec(
    "Coming soon",
    h("ul", "ab-soon", undefined,
      h("li", "", undefined, h("b", "", "Online. "), document.createTextNode("Live matchmaking against real players.")),
      h("li", "", undefined, h("b", "", "3v3 Teams. "), document.createTextNode("Squad up with friends.")),
      h("li", "", undefined, h("b", "", "Ranked NEAR arenas. "), document.createTextNode("Climb the ladder, win NEAR.")),
    ),
  );

  const lk = h("div", "lg-links ab-links");
  lk.appendChild(ext("Play: playnoxara.vercel.app", GAME_URL));
  lk.appendChild(ext("GitHub: Jasekeee/noxara", GITHUB_URL));
  if (X_POST_URL) lk.appendChild(ext("The X post", X_POST_URL));
  sec("Links", lk, ...(X_POST_URL ? [] : [h("p", "sc-note", "X post: coming soon")]));
}
