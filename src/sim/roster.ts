// STUB — agent B replaces with the real T1 roster (names, personalities, skins).
import type { FighterSpec } from "./types";
export function t1Roster(): FighterSpec[] {
  const names = ["You", "Bramble", "Ox", "Pip", "Vex", "Moss", "Juno", "Rook", "Tink", "Sable"];
  return names.map((name, i) => ({ id: i === 0 ? "you" : name.toLowerCase(), name, personality: "balanced", human: i === 0, upgrades: { weaponTier: 0, armor: 0, skin: i }, bounty: i === 3 }));
}
