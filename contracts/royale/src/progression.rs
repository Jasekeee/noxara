//! Player progression — an exact mirror of src/sim/progression.ts (checked against
//! src/sim/progression.vectors.json in the unit tests). Integer-only.
use crate::Upgrades;

/// XP for finishing 1st..10th (index = placement - 1).
pub const PLACEMENT_XP: [u64; 10] = [100, 70, 55, 45, 38, 32, 26, 20, 15, 10];
pub const XP_PER_KILL: u64 = 15;
pub const MAX_KILLS_XP: u64 = 9;
pub const BOUNTY_XP: u64 = 50;
/// Cumulative XP needed for level i+1.
pub const LEVELS: [u64; 10] = [0, 90, 200, 340, 510, 710, 940, 1200, 1490, 1800];
pub const MAX_LEVEL: u8 = 10;
/// Human-only skins (palette ids 10..14): (level, skin).
pub const SKIN_UNLOCKS: [(u8, u8); 5] = [(2, 10), (4, 11), (6, 12), (8, 13), (9, 14)];

/// XP for one match. Out-of-range placement counts as 10th; kills are capped at 9.
pub fn xp_for_match(placement: i64, kills: i64, bounty_claimed: bool) -> u64 {
    let p = if (1..=10).contains(&placement) { placement as usize } else { 10 };
    let k = kills.clamp(0, MAX_KILLS_XP as i64) as u64;
    PLACEMENT_XP[p - 1] + k * XP_PER_KILL + if bounty_claimed { BOUNTY_XP } else { 0 }
}

pub fn level_for_xp(xp: i64) -> u8 {
    let xp = xp.max(0) as u64;
    let mut lvl = 1u8;
    for (i, need) in LEVELS.iter().enumerate().skip(1) {
        if xp >= *need {
            lvl = i as u8 + 1;
        }
    }
    lvl
}

pub fn upgrades_for_level(level: i64) -> Upgrades {
    let l = level.clamp(1, MAX_LEVEL as i64) as u8;
    let weapon_tier = if l >= 7 { 2 } else if l >= 3 { 1 } else { 0 };
    let armor = if l >= 5 { 1 } else { 0 };
    let mut skin = 0;
    for (at, id) in SKIN_UNLOCKS {
        if l >= at {
            skin = id;
        }
    }
    Upgrades { weapon_tier, armor, skin }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::{self, Value};

    #[test]
    fn mirrors_the_typescript_vectors() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/sim/progression.vectors.json");
        let v: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("src/sim/progression.vectors.json")).unwrap();
        let c = &v["constants"];
        let arr = |k: &str| c[k].as_array().unwrap().iter().map(|x| x.as_u64().unwrap()).collect::<Vec<_>>();
        assert_eq!(arr("PLACEMENT_XP"), PLACEMENT_XP.to_vec());
        assert_eq!(arr("LEVELS"), LEVELS.to_vec());
        assert_eq!(c["XP_PER_KILL"].as_u64().unwrap(), XP_PER_KILL);
        assert_eq!(c["MAX_KILLS_XP"].as_u64().unwrap(), MAX_KILLS_XP);
        assert_eq!(c["BOUNTY_XP"].as_u64().unwrap(), BOUNTY_XP);
        let mut n = 0;
        for t in v["xpForMatch"].as_array().unwrap() {
            let got = xp_for_match(t["placement"].as_i64().unwrap(), t["kills"].as_i64().unwrap(), t["bountyClaimed"].as_bool().unwrap());
            assert_eq!(got, t["xp"].as_u64().unwrap(), "{t}");
            n += 1;
        }
        for t in v["levelForXp"].as_array().unwrap() {
            assert_eq!(level_for_xp(t["xp"].as_i64().unwrap()) as u64, t["level"].as_u64().unwrap(), "{t}");
            n += 1;
        }
        for t in v["upgradesForLevel"].as_array().unwrap() {
            let u = upgrades_for_level(t["level"].as_i64().unwrap());
            assert_eq!((u.weapon_tier as u64, u.armor as u64, u.skin as u64), (t["weaponTier"].as_u64().unwrap(), t["armor"].as_u64().unwrap(), t["skin"].as_u64().unwrap()), "{t}");
            n += 1;
        }
        assert!(n >= 50, "{n} vectors");
    }
}
