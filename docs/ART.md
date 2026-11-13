# BOUNTY ROYALE — art direction (render / UI / audio)

Original stylised low-poly island look. Kenney CC0 kits only (Mini Characters, Blaster Kit, Nature Kit), recoloured
into our own palette. No Brawl Stars / Fortnite assets, wording or look-alike characters.

## Palette (`src/render/palette.ts` is the source of truth)
| Role | Hex | Notes |
|---|---|---|
| Sky / fog | `#8fd8ea` | background + linear fog 48–115 u |
| Water deep → shallow → foam | `#1a6fb0` → `#34c6d3` → `#eafcff` | shader: depth by distance from shore, animated foam bands |
| Sand / wet sand | `#f4d79c` / `#d6b07a` | beach cone, vertex coloured |
| Grass mid / dark / light | `#5fae45` / `#4a963a` / `#7cc152` | flat-shaded jittered triangle grid, 1 colour per face |
| Kenney nature recolour | grass `#5cb547`, leaves `#4fb54a` / `#2f9a55`, stone `#c6ccd6`, dirt `#b58a64`, bark `#9c6440` | kit is teal by default |
| Storm | `#8a3cff` / hot `#d38bff` | wall + ground tint outside the safe circle; next circle = white pulsing ring |
| Local player | `#3df2ff` (cyan) | ring + aim line + minimap arrow |
| Bots | 9 distinct ring hues | `FIGHTER_COLORS` |
| Bounty / loot | `#ffc93c` gold | crown, chest beacon, feed highlight |
| Heal | `#4ce06a` | floating cross + glow |
| UI ink / paper / hot | `#15112b` / `#fffaf0` / `#ff4d6d` | HUD panels are ink @ 72–78 % |
| Bolts | popper `#ffe14d`, blaster `#55f7ff`, shotgun `#ff8a3d`, sniper `#ff4df0` | emissive core + trail + additive glow |

## Lighting
Hemisphere (sky `#d8f1ff`, ground `#5f8a45`, 1.25) + one warm directional sun (2.1) with a 2048² shadow map whose
44 × 44 u frustum follows the camera (only nearby casters). Neutral tone mapping, exposure 1.05. A pool of 3
point lights (always present, intensity 0 when idle → no shader recompiles) for muzzle flashes, chests, explosions.

## Camera
Perspective, FOV 38°, pitch 52° down, distance 25 u (portrait: × √(1/aspect)). Exponential follow (k = 6/s) with
2.4 u look-ahead toward the aim. Trauma-based shake (trauma², decays 1.5/s). On death: 1.2 s later, follow the
killer (or the nearest survivor). Title screen: slow orbit over the island.

## Characters & props
10 distinct Kenney mini characters (no zombie), × 2.8 scale. Animations: idle / walk / sprint (body only) blended with
an arm-only layer (`holding-right`, `holding-right-shoot`) so the weapon arm stays up while running; `die` on
elimination, then sink + poof. Weapon models: popper = blaster-b, blaster = blaster-d, shotgun = blaster-q,
sniper = blaster-f, grenade = grenade-a. Obstacles: rocks / trees / crates / tall stones scaled to the sim collision
radius (`?debugcol` draws the collision circles). Bushes: clusters of `plant_bush*`, fade to 32 % and rustle when you
are inside; bushes rustle when a hidden enemy moves in them.

## UI type & layout
Display: system heavy condensed (Avenir Next Condensed / Arial Black / Impact) with a dark ink stroke + hard drop
shadow. Body: Avenir Next / Nunito / system-ui, 700–900. No web fonts (no external requests).
Desktop: chips top-left, storm + timer top-centre, kill feed top-right, minimap bottom-right, weapon + HP bottom-centre.
Mobile (≤720 px or coarse pointer): weapon + HP under the chips, storm timer next to the minimap, twin sticks at the
bottom, mute between the sticks. Buttons ≥ 44 px, visible cyan focus ring.

## Motion rules
- Everything that matters to the player pops (scale overshoot), then settles; nothing slides in linearly.
- Hit: white emissive flash 0.14 s + damage number (crit = gold, bigger) + hit marker for your hits.
- Kill: poof (smoke + colour burst + ring), feed entry, banner + 0.5 s slow-mo for your kills.
- Damage numbers rise 50 px with ease-out and fade over the last 30 %.
- Shake budget: shot 0.05 (shotgun 0.18, sniper 0.22), hit on you 0.28, explosion ≤ 0.6, your death 0.6.
- `prefers-reduced-motion`: decorative CSS loops are disabled.

## Sound list (all synthesized WebAudio, `src/audio/sfx.ts`)
popper / blaster / shotgun / sniper / grenade throw · hit (yours: pitched tick, crit: + chime) · hurt · kill (yours:
arpeggio) · poof · chest open (arpeggio + sparkle) · pickup · heal · explosion (noise + sub drop) · storm tick (outside
the zone, 1/s) · storm warning · victory / defeat stingers · UI click. Distance attenuation from the camera target;
voice cap 28. Starts only after a user gesture; **M** toggles mute.

## Performance / quality
DPR capped at 2. Auto quality: if the frame rate stays under 48 FPS, the renderer steps down
(DPR × 0.8 → 0.65 + no shadows → 0.55 → 0.45). Software rasterizers (SwiftShader / llvmpipe, i.e. headless CI)
start at level 3 without MSAA. Each bush is one merged mesh; decor is instanced; particles draw only up to the last
live one; storm ground tint is an annulus (no full-screen overdraw inside the safe zone).

## Dev URL params (in addition to ?e2e / ?autoplay / ?seed=N / ?bots=1)
`?speed=N` sim speed multiplier · `?cam=N` camera distance · `?q=0..4` force a quality level ·
`?debugcol` draw sim collision circles. With `?e2e`, `__br.match()`, `__br.gl()` and `__br.tris()` are debug extras.

## Economy UI (T2)
- **Lobby cards** (title): portrait (rendered from the in-game model), name, personality glyph + colour, wallet in
  $BOUNTY (gold coin), weapon/armor pips (mint), W·K·M record, gold crown badge with the bounty value on the carrier
  (card glows gold), mint ROOKIE tag for generation > 0. Mobile: swipeable strip.
- **Drop-in**: PLAY shows "DROPPING IN — sealing the match seed on NEAR…" over the orbiting island (never frozen);
  ≤20 s, then offline fallback.
- **In match**: crown badge with the bounty value over the carrier's name tag; bounty claim = gold banner + feed line.
- **Ledger** (end): winner portrait (cheering bob), pot → winner, bounty line, upgrades bought, retirements, rookies,
  house/burn line, mint "Verified" badge, "On NEAR" drawer with explorer links. Guests get a one-line sign-in nudge;
  offline shows placements without amounts.
- Chests are gold + emissive + hex pad + light beam; solid crates are dull grey-brown (terrain).
- Storm: red/pink edge vignette, white ground arrow toward the safe zone, big pink self-damage numbers, tick each second.

## T3 screens
- Pages slide over the title (near-opaque ink panel, BACK + Esc): FIGHTERS grid (balance-sorted, gold glow on the
  bounty carrier, greyscale "Hall of the Broke"), PROFILE (150 px portrait, personality colour wash, 2-line original
  backstory, 6 stat tiles, sponsor box, STORY timeline with coloured dots: gold = wins/bounties, mint = upgrades,
  red = deaths/retirement, cyan = rookies), LEADERBOARD (AI fighters / players tabs, podium tints), MY SPONSORSHIPS.
- Sponsor modal: presets 10/25/50/100 + slider, live share %, sponsor cut, red risk line, CONFIRM STAKE.
- Progression: cyan XP bar on the end card (fills, level tile pops, "LEVEL N!" banner + 5-note arpeggio, unlock lines);
  "Lv N" badge in the lobby and HUD. Human skins 10–14 = female-c, male-d, female-f, male-g, soldier.
- `?mock` fills the T3 client API locally (sign-in, market, history, leaderboards) for screen work only.
