// "For judges — 60 seconds": three steps that show the core (training -> Verified -> Economy) + the chain links.
import type { GameClient } from "../net/api";
import { h, icon, ICON } from "./dom";

/** Mainnet links, filled in after the owner's mainnet deploy (docs/SUBMISSION.md §5). null = not deployed yet. */
export const MAINNET: { contract: string | null; deployTx: string | null; explorer: string } = {
  contract: null,
  deployTx: null,
  explorer: "https://nearblocks.io",
};

export interface JudgeDeps {
  client(): GameClient | null;
  training(): void;
  play(): void;
  economy(): void;
  near(): void;
  sampleBot(): string | null;
}

function ext(text: string, href: string) {
  const a = h("a", "near-link", undefined, icon(ICON.link), h("span", "", text));
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

export function renderJudges(body: HTMLElement, d: JudgeDeps) {
  body.textContent = "";
  body.appendChild(h("p", "page-lede", "9 AI mercenaries. Real wallets. One bounty. Only one walks out. — here is the whole core in about a minute."));
  const steps = h("ol", "jg-steps");
  const step = (n: number, title: string, text: string, btnText: string, onClick: () => void) => {
    const b = h("button", n === 1 ? "btn-primary small" : "btn-ghost small", btnText);
    b.addEventListener("click", onClick);
    steps.appendChild(h("li", "jg-step", undefined, h("span", "jg-n", String(n)), h("div", "", undefined, h("b", "", title), h("p", "", text), b)));
  };
  step(1, "Play a training match (~60 s)", "Easy bots, nothing recorded. Move with WASD or the left stick, aim with the mouse or the right stick, hide in bushes. Find the Mark — the fighter with the crown carries the bounty.", "TRAINING ISLAND", d.training);
  step(2, "Play a real match → Verified", "No wallet, no gas: you're a guest in seconds. At the end, watch the pot flow to the winner, the House and the burn, then click the green Verified badge: the server replayed your inputs and the settle transaction is on NEAR.", "PLAY A REAL MATCH", d.play);
  step(3, "Open the Economy", "One public rule steers the House treasury (get_economy). Nothing is minted after genesis. Fighters pay upkeep, go broke and are replaced by rookies whose shares IPO.", "OPEN ECONOMY", d.economy);
  body.appendChild(steps);

  const c = d.client();
  const links = h("div", "lg-links jg-links");
  if (c && c.mode === "chain") {
    const id = (c as GameClient & { contractId?: string }).contractId;
    if (id) links.appendChild(ext(`Testnet contract: ${id}`, c.explorerAccount(id)));
    const bot = d.sampleBot();
    if (bot) links.appendChild(ext(`A keyless fighter: ${bot}`, c.explorerAccount(bot)));
  }
  if (MAINNET.contract) links.appendChild(ext(`Mainnet contract: ${MAINNET.contract}`, `${MAINNET.explorer}/address/${MAINNET.contract}`));
  if (MAINNET.deployTx) links.appendChild(ext("Mainnet deploy tx", `${MAINNET.explorer}/txns/${MAINNET.deployTx}`));
  const how = h("button", "btn-chip", "HOW NEAR POWERS NOXARA");
  how.addEventListener("click", d.near);
  body.append(h("h3", "jg-h", "On chain"), links);
  if (!MAINNET.contract) body.appendChild(h("p", "sc-note", "Mainnet: links appear here after the mainnet deploy."));
  body.append(how, h("p", "sc-note", "Everything the README claims is checked by `npm run verify` (live testnet reads included). NOX is play-money with no real-world value."));
}
