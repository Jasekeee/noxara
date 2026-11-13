// T1 roster: idx 0 is the human, then 9 original AI fighters (aggressive ×2, camper ×2, balanced ×2,
// sniper, looter, coward), skins 1..9. Names are original to BOUNTY ROYALE. `bounty` marks the richest
// bot (T1: fixed pick).
import type { FighterSpec, Personality } from "./types";

const BOTS: [string, string, Personality][] = [
  ["bot.brindle", "Brindle", "aggressive"],
  ["bot.quillon", "Quillon", "camper"],
  ["bot.vesper", "Vesper", "sniper"],
  ["bot.magpie", "Magpie", "looter"],
  ["bot.tallow", "Tallow", "coward"],
  ["bot.dorrit", "Dorrit", "balanced"],
  ["bot.zinnia", "Zinnia", "aggressive"],
  ["bot.okapi", "Okapi", "camper"],
  ["bot.fenwick", "Fenwick", "balanced"],
];

/** The richest bot carries the bounty in T1 (Vesper). */
const BOUNTY_ID = "bot.vesper";

export function t1Roster(): FighterSpec[] {
  const out: FighterSpec[] = [
    { id: "you", name: "You", personality: "balanced", human: true, upgrades: { weaponTier: 0, armor: 0, skin: 0 }, bounty: false },
  ];
  BOTS.forEach(([id, name, personality], i) => {
    out.push({ id, name, personality, human: false, upgrades: { weaponTier: 0, armor: 0, skin: i + 1 }, bounty: id === BOUNTY_ID });
  });
  return out;
}

/** Same roster but with every fighter (incl. idx 0) driven by the AI — for headless/balance runs. */
export function botOnlyRoster(): FighterSpec[] {
  const r = t1Roster();
  r[0] = { ...r[0], id: "bot.autopilot", name: "Autopilot", human: false, personality: "balanced" };
  return r;
}
