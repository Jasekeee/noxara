// Single source of truth for the game's colours (see docs/ART.md).
import type { WeaponKind } from "../sim/types";

export const PAL = {
  sky: 0x8fd8ea,
  fog: 0x8fd8ea,
  waterDeep: 0x1a6fb0,
  waterShallow: 0x34c6d3,
  foam: 0xeafcff,
  sand: 0xf4d79c,
  sandWet: 0xd6b07a,
  grass: 0x5fae45,
  grassDark: 0x4a963a,
  grassLight: 0x7cc152,
  storm: 0x8a3cff,
  stormHot: 0xd38bff,
  me: 0x3df2ff,
  gold: 0xffc93c,
  heal: 0x4ce06a,
  hemiSky: 0xd8f1ff,
  hemiGround: 0x5f8a45,
  sun: 0xfff0d6,
};

/** Ring colours for the 9 bots (the local player uses PAL.me). */
export const FIGHTER_COLORS = [0x3df2ff, 0xff5a5f, 0xffa630, 0xb46cff, 0xff6fcf, 0x9be15d, 0xffe14d, 0x5b8cff, 0xff8e6e, 0x2fd6a6];

export const BOLT_COLOR: Record<WeaponKind, number> = {
  popper: 0xffe14d,
  blaster: 0x55f7ff,
  shotgun: 0xff8a3d,
  sniper: 0xff4df0,
  grenade: 0xffb03b,
};

export const WEAPON_LABEL: Record<WeaponKind, string> = {
  popper: "POPPER",
  blaster: "BLASTER",
  shotgun: "SHOTGUN",
  sniper: "SNIPER",
  grenade: "GRENADES",
};
