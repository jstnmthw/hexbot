# Plan: IdleRPG Plugin

## Summary

An IRC IdleRPG plugin for n0xb0t where players progress by being present in a designated channel. Characters gain XP passively from presence, earn bonus XP from channel activity, and build uptime streak multipliers for staying connected — rewarding both lurkers and active participants. Quitting or getting kicked breaks your streak (the only real penalty). The design takes the best from the classic IdleRPG (passive progression, communal events, item hunts) while flipping the psychology: instead of punishing activity, it rewards engagement. This makes the game a community-building tool rather than a channel silencer.

## Theme Options

Before diving into mechanics, the game needs a **theme** that flavors all the text output — item names, event descriptions, class titles, quest narratives. Here are five options:

### 1. **Cyberpunk / Netrunner** 🔌
- **Flavor:** Players are rogue hackers idling in the Net, leveling up their neural implants and ICE-breaking software. Items are cybernetic augmentations (neural jacks, optical implants, monofilament whips). Events involve corporate intrusions, data heists, and black-market deals. Quests are "runs" against megacorp servers.
- **Why it works:** The concept of "idling in a network" maps perfectly to IRC culture. The aesthetic is rich with naming possibilities and fits the tech-savvy IRC demographic.
- **Classes:** Netrunner (hacker), Street Samurai (combat), Fixer (social/trade), Techie (crafting/items)

### 2. **Dark Fantasy / Souls-like** ⚔️
- **Flavor:** Players are undead wanderers cursed to wander a dying world. Leveling up means kindling your inner flame. Items are ancient weapons and tattered armor. Events are encounters with eldritch horrors and fellow hollows. Death (penalties) is just part of the cycle — you always come back.
- **Why it works:** The "death is expected" framing makes penalties feel thematic rather than punishing. Rich lore potential. The grim aesthetic gives weight to every level gained.
- **Classes:** Knight (tank/defense), Sorcerer (magic/events), Rogue (evasion/crits), Cleric (support/healing)

### 3. **Space Exploration / Sci-Fi** 🚀
- **Flavor:** Players are deep-space travelers in cryosleep (idling), their ships auto-piloting through the cosmos. Level-ups represent reaching new star systems. Items are ship modules and alien artifacts. Events are asteroid fields, alien encounters, and distress signals. Quests are expeditions to uncharted sectors.
- **Why it works:** "Idling in cryosleep while your ship travels" is an intuitive metaphor. The vastness of space naturally explains long wait times. Endless naming possibilities for items and locations.
- **Classes:** Pilot (speed/evasion), Engineer (items/repair), Xenobiologist (events/discovery), Marine (combat)

### 4. **Eldritch Horror / Lovecraftian** 🐙
- **Flavor:** Players are investigators slowly descending into madness. Experience is "forbidden knowledge" — the more you learn, the closer you get to something terrible. Items are cursed tomes, ritual components, and protective wards. Events are sanity-testing encounters with things from beyond. The "idle" framing is that you're studying ancient texts and meditating on cosmic truths.
- **Why it works:** Progression feeling dangerous and double-edged is unique. Penalties can be framed as "sanity breaks" — thematic and funny. The mystery element keeps event text engaging.
- **Classes:** Occultist (magic/risk), Detective (investigation/luck), Medium (spirits/events), Professor (knowledge/items)

### 5. **Post-Apocalyptic / Wasteland** ☢️
- **Flavor:** Players are survivors hunkering down in a bunker (the IRC channel). Idling = scavenging the wasteland. Items are jury-rigged weapons and salvaged gear. Events are raider attacks, radioactive storms, and supply drops. Quests are expeditions to dangerous ruins.
- **Why it works:** The "bunker" metaphor fits IRC channels perfectly. Scrappy, improvised gear is fun to generate. The survival theme creates natural tension and community bonding.
- **Classes:** Scavenger (items/luck), Wastelander (combat/survival), Mechanic (crafting/repair), Medic (support/recovery)

### 6. **Satanic / Occult** 🜏
- **Flavor:** Players are cultists performing a grand infernal ritual. Idling is meditation and communion with dark powers — the longer you focus, the deeper your connection to the abyss. Items are ritual implements (athames, grimoires, chalices, black candles, inverted pentacles, bone relics). Events are demonic visitations, pacts with named devils, blood moon surges, and failed summonings that backfire. Quests are multi-step rituals to summon greater demons or open hellgates. Level-ups represent circles of initiation — ascending through infernal ranks from Acolyte to Archfiend.
- **Why it works:** The "silent ritual" framing maps perfectly to idling — meditation and dark rites require patience and stillness. The hierarchical rank system (circles, titles) gives leveling real flavor. Edgy enough to be memorable, tons of naming material from real-world demonology and occult tradition (Goetic demons, Qliphoth, infernal hierarchies). The communal ritual angle makes quests feel like actual group ceremonies.
- **Classes:** Diabolist (pacts/events — bargains with named demons for power), Black Knight (combat/defense — infernal armor and hellfire weapons), Witch (hexes/items — cursed artifacts and potions), Necromancer (support/undead — raises minions, shields allies with bone wards)

> **Recommendation:** Theme 1 (Cyberpunk) or Theme 3 (Space) map most naturally to the "idling on a network/in transit" concept. Theme 2 (Dark Fantasy) has the richest RPG tradition to draw from. Theme 6 (Satanic/Occult) has the strongest flavor text potential and the "silent ritual" framing is a perfect idle metaphor. The theme is purely cosmetic to the mechanics — we pick one and flavor all text output accordingly.

---

## Research: What We're Taking From Existing IdleRPGs

### From the Original IdleRPG (jotun/G7)
- ✅ Core idle-to-level mechanic (presence = progression)
- ✅ Random events (godsends, calamities)
- ✅ Item system (10 equipment slots, find items on level-up)
- ✅ Automatic PvP battles
- ✅ Team battles
- ✅ Quest system for high-level players
- ❌ Penalty system for talking/quitting/nick changes (we flip this — activity is a *bonus*)
- ❌ Purely exponential TTL scaling (causes dead mid-game)
- ❌ Extremely harsh penalties (e.g., part = 200× multiplier)
- ❌ No class/race system
- ❌ No catch-up mechanics

### From MultIdleRPG
- ✅ Team/guild focus — encourages community
- ✅ Cross-channel potential (if we want it later)

### From Gelbpunkt's Discord IdleRPG
- ✅ Class system with meaningful differentiation
- ✅ Guild system with shared bank
- ✅ Adventure/quest commands
- ✅ Trading between players
- ❌ Too many commands for a pure idle game (it became an active RPG)
- ❌ Patreon-gated classes (gross)

### Our QoL Improvements
1. **Softcap scaling** — TTL uses `base * level^1.5` instead of `base * 1.16^level`, preventing the "wait 3 weeks for one level" problem
2. **Hybrid XP model** — Flip the classic design: idle = base XP, channel activity = bonus XP, uptime streak = multiplier. No penalties for talking — talking *helps* you
3. **Uptime streaks** — Consecutive hours in channel build a stacking multiplier (+1% per hour, max +20%). Quitting/getting kicked resets it. Netsplits forgiven with a 5-minute grace window
4. **Activity bonus with diminishing returns** — First 5 messages per 5-minute window grant bonus XP. Prevents spam gaming while rewarding real conversation
5. **Catch-up XP** — Players below the server median level get a small idle speed bonus (up to 15%)
6. **Graceful disconnect** — No streak reset for QUIT if the player reconnects within 5 minutes (handles netsplits, bouncer restarts)
7. **Prestige system** — At max level, players can "ascend" to reset at level 1 with a permanent passive bonus, extending endgame
8. **Daily login bonus** — Small TTL reduction for being online when the daily tick fires (rewards consistency without demanding 24/7 uptime)
9. **Class abilities** — Each class has one passive and one active ability (used automatically), adding strategic depth without active play
10. **Event log channel** — Bot can post major events (level-ups, boss kills, legendary drops) to a separate channel for spectators
11. **Web leaderboard** — Expose a simple JSON endpoint (future, not MVP) for a leaderboard page

---

## Feasibility

- **Alignment:** Fully aligned with DESIGN.md. This is a standard plugin using `bind()`, the KV database, timers, and IRC output methods. No core changes needed.
- **Dependencies:** All required core modules exist — plugin-loader, dispatcher, database, permissions, channel-state, IRC bridge. Everything is built and tested.
- **Blockers:** None. The plugin API provides everything needed: `time` binds for game ticks, `pubm`/`join`/`part`/`nick` binds for tracking, `db` for persistence, `say`/`action`/`notice` for output.
- **Complexity estimate:** **L (days)** — The game logic is substantial (leveling, items, events, battles, quests, classes) but it's all self-contained in one plugin with no core changes.
- **Risk areas:**
  - **Flood protection:** The bot must not flood the channel with game messages. Rate-limit output and batch announcements.
  - **Database performance:** With many players, frequent timer ticks writing to KV could bottleneck. Batch updates and use in-memory state with periodic DB flushes.
  - **Timer precision:** The `time` bind minimum is 10 seconds. Game ticks at 30-60 second intervals are fine.
  - **Nick tracking:** Players are identified by IRC hostmask, not nick. Need to handle nick changes gracefully.
  - **Channel state dependency:** Requires `channel-state` module for knowing who's online. Already available via `api.getUsers()`.

---

## Dependencies

- [x] Core dispatcher with `time`, `pub`, `pubm`, `join`, `part`, `nick`, `quit` bind types
- [x] Plugin KV database (`api.db`)
- [x] Channel state module (`api.getUsers()`, `api.getUserHostmask()`)
- [x] IRC output methods (`api.say()`, `api.action()`, `api.notice()`)
- [x] Permission system (for admin commands)
- [ ] Decide on theme before Phase 1 (affects all flavor text)

---

## Core Mechanics Design

### Identity
Players register with `!idle register <class>`. Identity is tracked by **hostmask** (`ident@host` portion), not nick — so nick changes don't lose your character. The bot resolves the current nick from channel state.

### Leveling
- **Time-to-level (TTL):** `base_seconds * level ^ 1.5`
  - Level 1→2: 10 minutes
  - Level 5→6: ~37 minutes
  - Level 10→11: ~1.75 hours
  - Level 20→21: ~5 hours
  - Level 30→31: ~9 hours
  - Level 50→51: ~20 hours
  - Level 75→76: ~36 hours (prestige territory)
- **Max level:** 75 (prestige resets to 1 with bonuses)
- **Idle tick:** Every 30 seconds, all online registered players gain progress toward their next level. The amount gained depends on their current multipliers (base + streak + activity + class + prestige + catch-up).

### XP Sources (Hybrid Model)

The game uses an **incentive model** — presence is the baseline, activity and consistency are rewarded on top. The only real penalty is losing your uptime streak.

#### 1. Presence XP (Base)
Every 30-second tick, online registered players reduce their TTL by 30 seconds × their total multiplier. Just being in channel earns the base rate (1.0×).

#### 2. Activity Bonus
Channel messages from registered players grant a small **activity bonus** that stacks into their next tick's multiplier:

| Messages in window | Bonus |
|--------------------|-------|
| 1st message | +0.10× |
| 2nd message | +0.08× |
| 3rd message | +0.06× |
| 4th message | +0.04× |
| 5th message | +0.02× |
| 6th+ messages | No additional bonus |

- **Window:** 5 minutes. Counter resets each window.
- **Max activity bonus per window:** +0.30× (if you send 5+ messages).
- **Decay:** Activity bonus decays to 0 at the start of each new 5-minute window. You have to keep participating.
- This rewards real conversation without incentivizing spam — 5 messages in 5 minutes is a natural chat pace.

#### 3. Uptime Streak
Consecutive time spent in the game channel builds a **streak multiplier**:

| Streak Duration | Bonus |
|-----------------|-------|
| Per hour online | +0.01× (1%) |
| Maximum | +0.20× (20%) at 20 hours |

- **Streak resets on:** Quit, kick, or part (unless reconnect within grace period).
- **Grace period:** 5 minutes. If you disconnect and rejoin within 5 minutes, your streak is preserved. Handles netsplits, bouncer restarts, brief disconnects.
- **Nick changes:** No effect on streak. Change your nick freely.
- **Streak persists across ticks** — it's tracked as a timestamp of when the streak started, so the bonus is always calculated from `now - streakStart`.

#### 4. Multiplier Summary

| Source | Range | How to Earn |
|--------|-------|-------------|
| Base presence | 1.0× | Be in channel |
| Activity bonus | +0.0× to +0.30× | Chat (up to 5 msgs per 5 min) |
| Uptime streak | +0.0× to +0.20× | Stay connected (1% per hour) |
| Class passive | +0.0× to +0.10× | Depends on class |
| Prestige bonus | +0.0× to +0.30× | 3% per ascension (max 10) |
| Catch-up bonus | +0.0× to +0.15× | Below median level |
| **Total possible** | **1.0× to 2.05×** | |

A fully optimized player (prestige 10, 20h streak, chatting, with class bonus) progresses at roughly 2× the speed of a fresh idle player. This is meaningful but not oppressive — a new player isn't hopelessly behind.

### Streak-Breaking Events (The Only Penalties)

| Event | Effect |
|-------|--------|
| Quit IRC | Streak resets to 0 (forgiven if rejoin within 5 min) |
| Kicked from channel | Streak resets to 0 (no grace period) |
| Part channel | Streak resets to 0 (forgiven if rejoin within 5 min) |
| Nick change | **No effect** — change nicks freely |
| Channel message | **No penalty** — earns activity bonus instead |

The psychology: you're never *punished* for playing the game. The worst that happens is you lose your streak bonus and go back to base rate. This keeps the game feeling rewarding rather than anxiety-inducing.

### Classes (4 classes)
Each class has a **passive** (always active) and a **signature** (triggers automatically in specific situations):

| Class | Passive | Signature |
|-------|---------|-----------|
| **Warrior** | +10% battle power | **Last Stand:** 25% chance to survive a lost battle with no TTL loss |
| **Mage** | +10% XP from events | **Arcane Surge:** Godsend events are 50% stronger |
| **Rogue** | +10% activity bonus (activity msgs count 1.1× each) | **Pickpocket:** 15% chance to steal an item on PvP win |
| **Cleric** | +5% team battle power | **Sanctuary:** Once per day, grants a random online teammate 1 hour of streak protection (their streak won't reset if they disconnect) |

> Class names will be re-flavored to match the chosen theme.

### Items (10 slots)
| Slot | Example (Fantasy) |
|------|-------------------|
| Weapon | Sword, Axe, Staff |
| Shield | Buckler, Tower Shield |
| Helm | Iron Helm, Crown |
| Armor | Chainmail, Robe |
| Gloves | Gauntlets, Bracers |
| Leggings | Greaves, Leggings |
| Boots | Sabatons, Sandals |
| Ring | Signet Ring, Band |
| Amulet | Pendant, Talisman |
| Charm | Rune, Totem |

- **Item level:** 1 to `floor(1.5 * player_level)`
- **Find item on level-up:** Random slot, random level within range
- **Equip if better:** Auto-equip if new item > current item in that slot
- **Total item power:** Sum of all equipped item levels. Used in battles.
- **Legendary items:** At level 25+, 1/40 chance of a "legendary" item worth 2× normal max level
- **Item names:** Generated from theme-appropriate word lists (prefix + material + type)

### Battles
- **Auto-PvP:** Every 2 hours, two random online players are matched. Higher total item power wins. Loser gets +5% TTL penalty, winner gets -10% TTL bonus.
- **Critical hits:** 5% chance for 2× effect on win/loss.
- **Team battles:** Every 6 hours, two random teams of 3 online players battle. Winning team gets -15% TTL each, losing team gets +5% TTL each.
- **Level bracket matching:** PvP only matches players within ±10 levels of each other (prevents level 60 stomping level 5).

### Events (Random)
Every 5 minutes, each online player has a chance for a random event:

| Event | Chance | Effect |
|-------|--------|--------|
| **Godsend** | 12% | Reduce TTL by 5-15% |
| **Calamity** | 10% | Increase TTL by 3-10% |
| **Item Find** | 8% | Find a random item (may upgrade a slot) |
| **Item Break** | 5% | Lowest item loses 10-30% of its level |
| **Hand of God** | 3% | 75% chance: reduce TTL by 10-50%. 25% chance: increase TTL by 10-25% |
| **Nothing** | 62% | No event |

### Quests
- **Triggered:** Every 8 hours, if 3+ players are online at level 15+, a quest begins.
- **Duration:** 1-4 hours (random).
- **Participants:** 3 random eligible online players are drafted.
- **Success:** All questers get -20% TTL reduction.
- **Failure:** Quest fails if any quester goes offline during the quest. Remaining questers get +5% TTL penalty.
- **Narrative:** Quest text is generated from theme-appropriate templates ("The party ventures into the Ruined Server Room to retrieve the Lost Encryption Key...").

### Prestige (Ascension)
- Available at level 75.
- Resets to level 1 with all items cleared.
- Grants a permanent **+3% idle speed bonus** per ascension (stacking, max 10 ascensions = +30%).
- Prestige count displayed on leaderboard and in `!idle info`.
- Prestige players get a special prefix/title in game output.

### Daily Bonus
- Once per 24-hour cycle, every online registered player gets a small TTL reduction (flat 5 minutes).
- Announced in channel: `[IdleRPG] Daily sync complete. All online adventurers gain a burst of inspiration!`

### Catch-Up Mechanic
- Server tracks the **median player level**.
- Players more than 5 levels below the median gain **+1% idle speed per level below median** (max +15%).
- This helps new players close the gap without punishing veterans.

---

## Commands

### Player Commands (no flags required)
| Command | Description |
|---------|-------------|
| `!idle register <class>` | Create a character (one per hostmask) |
| `!idle info [nick]` | View your (or another player's) character sheet |
| `!idle top [N]` | Leaderboard (default top 10) |
| `!idle items [nick]` | View equipped items |
| `!idle quest` | View current quest status |
| `!idle classes` | List available classes and abilities |
| `!idle online` | List online registered players |
| `!idle ascend` | Prestige (if level 75) |

### Admin Commands (+o flag)
| Command | Description |
|---------|-------------|
| `!idle admin reset <nick>` | Reset a player's character |
| `!idle admin kick <nick>` | Remove a player from the game |
| `!idle admin event` | Force a random event cycle |
| `!idle admin quest` | Force a quest to start |
| `!idle admin announce <msg>` | Send a game announcement |

---

## Phases

### Phase 1: Scaffold & Data Model
**Goal:** Plugin skeleton with registration, database schema, and basic character display.

- [ ] Create `plugins/idlerpg/` directory structure
- [ ] Create `plugins/idlerpg/config.json` with default settings (game channel, tick intervals, scaling constants, theme)
- [ ] Create `plugins/idlerpg/index.ts` with standard plugin exports (`name`, `version`, `description`, `init`, `teardown`)
- [ ] Define TypeScript interfaces for game data: `PlayerCharacter`, `Item`, `GameConfig`, `QuestState`, `BattleResult`
- [ ] Implement DB helper layer over `api.db` — `savePlayer(player)`, `loadPlayer(hostmask)`, `loadAllPlayers()`, `deletePlayer(hostmask)`
- [ ] Implement `!idle register <class>` — creates character, validates class choice, prevents duplicates
- [ ] Implement `!idle info [nick]` — displays character sheet (level, class, TTL remaining, items, prestige count)
- [ ] Implement `!idle classes` — lists available classes and their abilities
- [ ] **Verify:** Register a character, view info, confirm DB persistence across plugin reload

### Phase 2: Idle Engine & Leveling
**Goal:** Players gain progress by idling. Level-ups happen automatically with announcements.

- [ ] Implement game tick via `time` bind (30-second interval) — iterates online registered players, decrements TTL
- [ ] Implement level-up logic — when TTL reaches 0, increment level, calculate new TTL, generate and equip item
- [ ] Implement catch-up XP bonus (median level tracking, bonus idle speed for low-level players)
- [ ] Implement level-up announcements in channel (`api.action()` for flavor)
- [ ] Implement item generation — random slot, random level, auto-equip if upgrade, themed item names
- [ ] Implement legendary item drops (level 25+, 1/40 chance, 2× power)
- [ ] Implement `!idle items [nick]` — display all equipped items with levels
- [ ] Implement `!idle top [N]` — leaderboard sorted by level (then TTL remaining)
- [ ] **Verify:** Idle in channel, observe TTL decreasing, level up, receive items, check leaderboard

### Phase 3: Activity Tracking & Uptime Streaks
**Goal:** Channel activity grants bonus XP. Uptime streaks reward consistent presence. Disconnects break streaks (with grace period).

- [ ] Bind `pubm` — detect channel messages from registered players, increment activity counter for current 5-minute window
- [ ] Implement activity bonus calculation — diminishing returns (0.10, 0.08, 0.06, 0.04, 0.02) for first 5 messages per window
- [ ] Implement 5-minute activity window reset (clear counters each window)
- [ ] Implement uptime streak tracking — store `streakStartedAt` timestamp per player, calculate bonus as `min(hours * 0.01, 0.20)`
- [ ] Integrate activity bonus + streak multiplier into the idle tick from Phase 2
- [ ] Bind `part` — reset player streak, start 5-minute grace timer
- [ ] Bind `join` — if rejoining within grace period, restore streak (set `streakStartedAt` back to original value)
- [ ] Handle quit events — reset streak with same 5-minute grace window as part
- [ ] Handle kick events — reset streak immediately (no grace period)
- [ ] Bind `nick` — update nick mapping only, no streak/XP effect
- [ ] Implement Rogue class passive (+10% activity bonus amplification)
- [ ] Track player online/offline state transitions for game logic
- [ ] **Verify:** Chat in channel → observe activity bonus in next tick. Stay online for 2+ hours → see streak bonus. Part and rejoin within 5 min → streak preserved. Quit without rejoin → streak reset to 0.

### Phase 4: Random Events
**Goal:** Periodic random events add excitement and variance to progression.

- [ ] Implement event tick via `time` bind (5-minute interval, separate from idle tick)
- [ ] Implement event table with weighted random selection (godsend, calamity, item find, item break, hand of god)
- [ ] Implement godsend — reduce TTL by 5-15%, announce in channel
- [ ] Implement calamity — increase TTL by 3-10%, announce in channel
- [ ] Implement item find event — find random item outside of level-up
- [ ] Implement item break event — degrade lowest item
- [ ] Implement Hand of God — high-variance event with dramatic announcement
- [ ] Implement Mage class passive (+10% XP from events) and signature (50% stronger godsends)
- [ ] Generate theme-flavored event descriptions from templates
- [ ] **Verify:** Wait for event ticks, observe events firing for online players, check Mage bonuses apply

### Phase 5: Battle System
**Goal:** Automatic PvP and team battles create rivalry and excitement.

- [ ] Implement PvP tick via `time` bind (2-hour interval)
- [ ] Implement player matching — select two random online players within ±10 levels
- [ ] Implement battle resolution — compare total item power, apply win/loss TTL adjustments
- [ ] Implement critical hit system (5% chance for 2× effect)
- [ ] Implement Warrior class passive (+10% battle power) and signature (25% survive lost battle)
- [ ] Implement Rogue class signature (15% chance to steal an item on PvP win)
- [ ] Implement team battle tick (6-hour interval) — two teams of 3 random online players
- [ ] Implement Cleric class passive (+5% team battle power) and signature (daily streak protection for a teammate)
- [ ] Announce battle results with dramatic flavor text
- [ ] **Verify:** Force a battle via admin command, observe matching, resolution, and TTL changes

### Phase 6: Quests
**Goal:** Multi-player cooperative quests for mid-to-high level players.

- [ ] Implement quest tick via `time` bind (8-hour interval)
- [ ] Implement quest eligibility check (3+ online players at level 15+)
- [ ] Implement quest creation — select participants, set duration, generate narrative
- [ ] Implement quest tracking — monitor participant online status during quest
- [ ] Implement quest success/failure — TTL rewards/penalties, announcements
- [ ] Implement `!idle quest` — view current quest status (participants, time remaining, narrative)
- [ ] Generate themed quest narratives from templates
- [ ] **Verify:** Force a quest via admin command, observe participant tracking, complete quest, verify rewards

### Phase 7: Prestige & Endgame
**Goal:** Prestige system for endgame players, daily bonuses for engagement.

- [ ] Implement `!idle ascend` — reset character at level 75, increment prestige counter, grant permanent idle speed bonus
- [ ] Implement prestige display in `!idle info` and `!idle top`
- [ ] Implement daily bonus tick (24-hour interval) — small TTL reduction for all online players
- [ ] Implement prestige idle speed bonus calculation (3% per ascension, max 30%)
- [ ] Add prestige title/prefix to game output (e.g., `★ PlayerName` for prestige 1, `★★` for 2, etc.)
- [ ] **Verify:** Reach level 75 (or admin-set), ascend, confirm reset with bonus, verify idle speed increase

### Phase 8: Admin Commands & Polish
**Goal:** Admin tools, output rate limiting, and final polish.

- [ ] Implement `!idle admin reset <nick>` — reset a player's character
- [ ] Implement `!idle admin kick <nick>` — remove player from game entirely
- [ ] Implement `!idle admin event` — force an event cycle
- [ ] Implement `!idle admin quest` — force a quest
- [ ] Implement `!idle admin announce <msg>` — broadcast game announcement
- [ ] Implement output rate limiting — queue messages and send max 3 per 2 seconds to avoid IRC flood
- [ ] Implement `!idle online` — list online registered players with levels
- [ ] Add help text for all commands (brief, fits one IRC line each)
- [ ] Final pass on all announcement text for theme consistency and readability
- [ ] **Verify:** Test all admin commands. Trigger many simultaneous events and confirm no flooding.

---

## Config Changes

New file `plugins/idlerpg/config.json`:
```json
{
  "game_channel": "#idlerpg",
  "theme": "cyberpunk",
  "tick_interval_seconds": 30,
  "event_interval_seconds": 300,
  "pvp_interval_seconds": 7200,
  "team_battle_interval_seconds": 21600,
  "quest_interval_seconds": 28800,
  "daily_bonus_seconds": 86400,
  "base_ttl_seconds": 600,
  "ttl_exponent": 1.5,
  "max_level": 75,
  "max_prestige": 10,
  "prestige_bonus_percent": 3,
  "catchup_max_bonus_percent": 15,
  "catchup_threshold_levels": 5,
  "activity_window_seconds": 300,
  "activity_max_messages": 5,
  "activity_bonus_per_message": [0.10, 0.08, 0.06, 0.04, 0.02],
  "streak_bonus_per_hour": 0.01,
  "streak_max_bonus": 0.20,
  "streak_grace_period_seconds": 300,
  "legendary_min_level": 25,
  "legendary_chance": 0.025,
  "legendary_multiplier": 2,
  "pvp_level_bracket": 10,
  "quest_min_players": 3,
  "quest_min_level": 15,
  "announce_channel": null,
  "flood_max_messages": 3,
  "flood_window_seconds": 2
}
```

New entry in `config/plugins.json`:
```json
{
  "idlerpg": {
    "enabled": true,
    "channels": ["#yourchannel"],
    "config": {
      "game_channel": "#yourchannel",
      "theme": "cyberpunk"
    }
  }
}
```

---

## Database Changes

All data stored in the plugin's namespaced KV store. No schema changes to core.

**Key patterns:**

| Key Pattern | Value (JSON) | Description |
|-------------|--------------|-------------|
| `player:<ident@host>` | `PlayerCharacter` object | Full character data |
| `quest:active` | `QuestState` object or `null` | Currently active quest |
| `state:last_pvp` | Timestamp (ms) | Last PvP battle time |
| `state:last_team_battle` | Timestamp (ms) | Last team battle time |
| `state:last_quest` | Timestamp (ms) | Last quest start time |
| `state:last_daily` | Timestamp (ms) | Last daily bonus time |
| `state:median_level` | Number | Cached median level |
| `nick_map:<ident@host>` | Current nick string | Hostmask → nick mapping |

**PlayerCharacter shape:**
```typescript
interface PlayerCharacter {
  handle: string;           // Display name (current nick at registration)
  hostmask: string;         // ident@host (identity key)
  class: 'warrior' | 'mage' | 'rogue' | 'cleric';
  level: number;
  ttl: number;              // Seconds remaining to next level
  totalIdleTime: number;    // Lifetime idle seconds (for stats)
  items: Record<ItemSlot, Item | null>;
  prestige: number;
  createdAt: number;        // Timestamp
  lastOnline: number;       // Timestamp
  streakStartedAt: number;  // Timestamp — when current uptime streak began (0 = no streak)
  activityCount: number;    // Messages in current activity window
  activityWindowStart: number; // Timestamp — start of current 5-min activity window
  lastSanctuary: number;    // Timestamp (Cleric daily ability)
  sanctuaryUntil: number;   // Timestamp — streak protection expires at (from Cleric buff)
  onQuest: boolean;
}

interface Item {
  slot: ItemSlot;
  name: string;
  level: number;
  legendary: boolean;
}

type ItemSlot = 'weapon' | 'shield' | 'helm' | 'armor' | 'gloves' |
                'leggings' | 'boots' | 'ring' | 'amulet' | 'charm';
```

---

## Test Plan

### Unit Tests (`plugins/idlerpg/__tests__/`)

- **TTL calculation:** Verify `calculateTTL(level)` produces expected values at key levels (1, 10, 25, 50, 75) and that prestige bonus applies correctly
- **Item generation:** Verify item level ranges are correct for player level, legendary drop rate is approximately 1/40 over many iterations, items are valid for their slot
- **Battle resolution:** Verify higher item power wins, critical hits apply correct multiplier, class bonuses apply, level bracket matching excludes mismatched players
- **Activity bonus:** Verify diminishing returns per message (0.10, 0.08, ...), window reset after 5 min, max 5 messages count, Rogue amplification (+10%) applies correctly
- **Uptime streaks:** Verify bonus grows at 1% per hour, caps at 20%, resets on quit/kick/part, grace period preserves streak on quick rejoin, Cleric sanctuary prevents streak reset
- **Event system:** Verify event probabilities sum to 100%, each event applies its effect correctly, Mage bonuses amplify godsend effects
- **Catch-up mechanic:** Verify bonus is calculated correctly relative to median, caps at 15%, doesn't apply to players above threshold
- **Prestige:** Verify reset clears level/items/TTL, increments prestige, applies idle speed bonus, rejects if below max level or at max prestige
- **Quest system:** Verify eligibility checks, participant tracking, success/failure conditions, reward/penalty application
- **Registration:** Verify duplicate prevention, class validation, character creation with correct defaults
- **Leaderboard:** Verify sort order (level desc, TTL asc), prestige display, handles ties
- **Output rate limiting:** Verify message queue respects flood limits

### Integration Tests

- **Full game loop:** Register → idle → level up → receive item → battle → quest → ascend
- **Activity flow:** Register → send messages → verify activity bonus increases tick multiplier → wait for window reset → verify bonus decays
- **Streak flow:** Register → stay online 2+ hours → verify streak multiplier → disconnect → rejoin within grace → verify streak preserved → disconnect → wait past grace → rejoin → verify streak reset
- **Plugin reload:** Register characters, reload plugin, verify all state persists from DB

---

## Open Questions

1. **Which theme?** Need to pick one before Phase 1 so all flavor text is consistent. See theme options above.
2. **Single channel or multi-channel?** Current design assumes one game channel. Should players be able to idle in any channel the bot is in, or just a designated game channel?
3. **Event verbosity:** Should every event be announced in channel, or should minor events (small godsends/calamities) be silent with only major events announced? A `verbosity` config option?
4. **PvP opt-out?** Should players be able to opt out of PvP battles, or is it mandatory? Opt-out reduces the communal feel but some players may find unsolicited PvP frustrating.
5. **Item trading?** Not in current design but could be added in a future phase. Worth planning the data model for it now?
6. **Announce channel?** Should major events (level-ups, legendary drops, quest completions) be cross-posted to a separate "game log" channel, or only appear in the game channel?
