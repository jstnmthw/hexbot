# Plan: Eggdrop Parity — Channel Moderation, Defaults & Base Mods

## Summary

Review of Eggdrop 1.9/1.10 defaults reveals four meaningful gaps in n0xb0t: timed bans (Eggdrop default: 120 min auto-expire), inbound flood protection (Eggdrop: per-channel flood thresholds with kick/ban escalation), channel mode enforcement (Eggdrop: enforce `+nt` by default, re-apply if stripped), and a CTCP handler (Eggdrop: auto-reply VERSION/PING/TIME). Two smaller quality-of-life gaps also exist: a `+cycle` recovery behavior when the bot loses ops, and a `+nodesynch` option to stop fighting ChanServ. This plan implements them in priority order.

## Feasibility

- **Alignment**: All features fit the existing plugin + core architecture. Timed bans and mode enforcement extend chanmod. Flood protection is a new plugin (explicitly planned in DESIGN.md Phase 2). CTCP is a new plugin using the existing `ctcp` bind type. Cycle behavior is a chanmod config option.
- **Dependencies**: All core modules required (dispatcher, database, channel-state, irc-commands) are complete. No blockers.
- **Complexity**: M — most pieces are self-contained; flood plugin is the most complex.
- **Risk areas**: Mode enforcement can cause mode wars with ChanServ — mitigated by `nodesynch` option. Timed ban cleanup needs a reliable timer that survives plugin reload. Flood thresholds need sensible defaults that don't false-positive on normal chatty channels.

## Dependencies

- [x] `dispatcher.ts` — bind system (complete)
- [x] `database.ts` — plugin KV store (complete)
- [x] `channel-state.ts` — user tracking (complete)
- [x] `irc-commands.ts` — ban/kick/mode wrappers (complete)
- [x] `chanmod` plugin — extends existing (complete)
- [x] `time` bind type — for timed cleanup loops (complete)

---

## Phase 1: Timed Bans

**Goal:** Bans placed via `!ban` or `!kickban` auto-expire after a configurable duration. Default: 120 minutes (Eggdrop default). Bans can be made permanent with `!ban <mask> 0`. Active bans are listable with `!bans`.

### Tasks

- [x] **`plugins/chanmod/index.ts`** — Extend `!ban` syntax: `!ban <nick|mask> [duration_minutes]`. Parse duration from trailing arg (default: `default_ban_duration` config, 0 = permanent).
- [x] **`plugins/chanmod/index.ts`** — On ban, store record in plugin DB: `key = "ban:<channel>:<mask>"`, value = `JSON.stringify({ mask, channel, by, ts, expires })` where `expires = 0` means permanent.
- [x] **`plugins/chanmod/index.ts`** — On plugin load (startup), scan all ban DB keys, lift any with `expires > 0 && expires <= Date.now()`, and log `[chanmod] lifted N expired bans after downtime` if any were found.
- [x] **`plugins/chanmod/index.ts`** — Register a `time` bind (`* * * * *` — every minute) that iterates all ban keys for this channel, checks `expires` against `Date.now()`, and calls `api.irc.mode(channel, '-b', mask)` for expired bans then deletes the DB key.
- [x] **`plugins/chanmod/index.ts`** — Add `!bans [channel]` command (requires +o): lists active bans with expiry times.
- [x] **`plugins/chanmod/index.ts`** — Extend `!unban` to also delete the DB record.
- [x] **`config/plugins.example.json`** — Add `default_ban_duration: 120` to chanmod config block.
- [x] Verification: `!ban <nick> 5` bans, `!bans` shows it with 5-min expiry, after 5 min MODE -b is sent, `!bans` shows empty.

---

## Phase 2: Inbound Flood Protection Plugin

**Goal:** Detect and respond to message floods, join/part spam, and nick-change spam in channels. Configurable thresholds and escalating responses (warn → kick → tempban). This is explicitly planned in DESIGN.md Phase 2.

### Tasks

- [x] **`plugins/flood/index.ts`** — Create new plugin. Register `pubm` bind to track message rate per `nick@channel`. Use sliding window counter: store `{ count, window_start }` in memory (Map). If `count > msg_threshold` within `msg_window_secs`, trigger flood action.
- [x] **`plugins/flood/index.ts`** — Track join flood per nick: register `join` bind, count rapid join/part/rejoin cycles per nick (>3 joins within 60s = flood).
- [x] **`plugins/flood/index.ts`** — Track nick-change spam: register `nick` bind, count nick changes per user hostmask (>3 in 60s = flood).
- [x] **`plugins/flood/index.ts`** — Implement escalation logic: first offence = warn (NOTICE to nick), second = kick, third within window = tempban (duration from config, default 10 min). Store offence count per nick in memory with TTL reset.
- [x] **`plugins/flood/index.ts`** — Guard all actions with bot-has-ops check and `+o` flag requirement not needed (bot acts on its own detection). Skip if flood detection sender has `+o` or higher flag (don't flood-kick ops).
- [x] **`plugins/flood/config.json`** — Create default config:
  ```json
  {
    "msg_threshold": 5,
    "msg_window_secs": 3,
    "ban_duration_minutes": 10,
    "ignore_ops": true,
    "actions": ["warn", "kick", "tempban"]
  }
  ```
- [x] **`config/plugins.example.json`** — Add flood plugin entry (disabled by default — operators opt in).
- [x] Verification: Rapidly send 6 messages in 2 seconds → receive NOTICE warning. Send 6 more → get kicked. Rejoin and do it again → get tempbanned for 10 min.

---

## Phase 3: Channel Mode Enforcement + nodesynch

**Goal:** Enforce a configured channel mode string (e.g. `+nt`) and re-apply it if stripped. Add `nodesynch` option to suppress mode enforcement for changes made by ChanServ. Both are Eggdrop defaults.

### Tasks

- [x] **`plugins/chanmod/index.ts`** — Add `enforce_channel_modes` config key (string, e.g. `"+nt"`, default `""`). On MODE event: if a mode in `enforce_channel_modes` is removed and remover is not in `nodesynch_users` list, re-apply it after `enforce_delay_ms`.
- [x] **`plugins/chanmod/index.ts`** — On bot JOIN confirmation (RPL_NAMREPLY / MODE sync completes), check if channel's current modes include all `enforce_channel_modes` modes; if not, set them.
- [x] **`plugins/chanmod/index.ts`** — Add `nodesynch_nicks` config (array, default `["ChanServ"]`). If a mode change source nick is in this list, skip enforcement entirely.
- [x] **`config/plugins.example.json`** — Add `enforce_channel_modes: "+nt"` and `nodesynch_nicks: ["ChanServ"]` to chanmod config example.
- [x] Verification: Set `enforce_channel_modes: "+nt"`. Manually `/mode #chan -t`. Bot re-applies `+t` within `enforce_delay_ms`. Then have ChanServ remove it — bot does NOT re-apply.

---

## Phase 4: +cycle Recovery

**Goal:** When the bot is deopped and cannot re-op itself (no ops available), cycle the channel (part + rejoin) to request ops from ChanServ or trigger auto-op. This is Eggdrop's `+cycle` channel option.

### Tasks

- [x] **`plugins/chanmod/index.ts`** — Add `cycle_on_deop` config (boolean, default `false`). When mode enforcement fires for the bot's own `-o` and enforcement attempt count reaches the max (`enforce_max` — 3), instead of giving up silently, schedule a part+rejoin after `cycle_delay_ms` (default 5000ms).
- [x] **`plugins/chanmod/index.ts`** — On rejoin, reset enforcement counters for the channel.
- [x] **`plugins/chanmod/index.ts`** — Skip cycle if channel has `+i` (invite-only) flag set in channel-state — bot can't rejoin without an invite.
- [x] **`config/plugins.example.json`** — Add `cycle_on_deop: false` (disabled by default — opt-in, can be disruptive).
- [x] Verification: Disable bot auto-op, manually `/deop` the bot 3 times within enforcement window, confirm bot parts and rejoins the channel.

---

## Phase 5: CTCP Plugin

**Goal:** Standard CTCP replies for VERSION, PING, and TIME. Eggdrop ships the `ctcp` module and replies to these by default. n0xb0t irc-framework handles CTCP PING natively; VERSION and TIME need explicit handlers.

### Tasks

- [x] **`plugins/ctcp/index.ts`** — Create new plugin. On load, read `name` + `version` from `package.json` via `fs.readFileSync` to build the default version string (e.g. `"n0xb0t v1.0.0"`). Register `ctcp` bind for `VERSION`: reply with that string.
- [x] **`plugins/ctcp/index.ts`** — Register `ctcp` bind for `TIME`: reply with current local time string.
- [x] **`plugins/ctcp/index.ts`** — Register `ctcp` bind for `SOURCE`: reply with configurable source URL (or empty to skip).
- [x] **`plugins/ctcp/config.json`** — Default config:
  ```json
  {
    "version": "n0xb0t v1.0 (Node.js/irc-framework)",
    "source": "",
    "reply_time": true
  }
  ```
- [x] **`config/plugins.example.json`** — Add ctcp plugin entry (enabled by default).
- [x] Verification: `/ctcp <botnick> VERSION` → bot replies with version string. `/ctcp <botnick> TIME` → bot replies with current time.

---

## Phase 6: Config Defaults Audit

**Goal:** Update default configs to match Eggdrop's sensible IRC defaults.

### Tasks

- [x] **`config/bot.example.json`** — Default TLS port to 6697 (already done), default network to `irc.libera.chat` (more appropriate modern default vs Rizon).
- [x] **`plugins/chanmod/index.ts`** — Add `default_ban_type` config: `1` = `*!*@host`, `2` = `*!*ident@host`, `3` = `*!*ident@*.domain` (Eggdrop default is Type 3). Ban mask builder should respect this.
- [x] **`plugins/chanmod/index.ts`** — Improve ban mask builder: given a full `nick!ident@hostname.tld`, Type 3 should strip the first hostname component and wildcard it (`*!*ident@*.tld`), Type 1 = `*!*@hostname.tld`, Type 2 = `*!*ident@hostname.tld`. If hostname contains `/` (cloaked host, e.g. `user/foo`), skip wildcard logic and use the full cloak: `*!*@user/foo`.
- [x] **`config/plugins.example.json`** — Add `default_ban_type: 3` and `default_ban_duration: 120` to chanmod block.
- [x] Verification: `!ban <nick>` on a user with ident `foo` at `bar.baz.net` produces ban mask `*!*foo@*.baz.net` with Type 3.

---

## Config Changes

### chanmod plugin additions to `plugins.example.json`

```json
{
  "chanmod": {
    "config": {
      "auto_op": true,
      "enforce_modes": false,
      "enforce_channel_modes": "+nt",
      "nodesynch_nicks": ["ChanServ"],
      "default_ban_duration": 120,
      "default_ban_type": 3,
      "cycle_on_deop": false,
      "cycle_delay_ms": 5000
    }
  }
}
```

### New plugins

```json
{
  "flood": {
    "enabled": false,
    "channels": ["#yourchannel"],
    "config": {
      "msg_threshold": 5,
      "msg_window_secs": 3,
      "ban_duration_minutes": 10,
      "ignore_ops": true,
      "actions": ["warn", "kick", "tempban"]
    }
  },
  "ctcp": {
    "enabled": true,
    "config": {
      "version": "n0xb0t (Node.js)",
      "source": "",
      "reply_time": true
    }
  }
}
```

## Database Changes

### chanmod plugin (Phase 1)

New key pattern in chanmod's plugin namespace:

```
ban:<channel>:<mask>  →  { mask, channel, by, ts, expires }
```

- `expires = 0` means permanent (no auto-remove)
- `expires = <unix_ms>` — removed when `Date.now() >= expires`

No schema migrations needed — uses existing KV store.

## Test Plan

- **Timed bans**: Place a 1-minute ban, verify DB entry exists, advance time mock, verify cleanup fires and MODE -b is sent.
- **Flood protection**: Simulate rapid pub messages from a test nick, verify warn/kick/ban escalation at correct thresholds. Verify ops are exempt. Verify counters reset after TTL.
- **Mode enforcement**: Simulate MODE -t on a channel with `enforce_channel_modes: "+t"`, verify re-apply fires. Simulate same from "ChanServ" — verify it does NOT re-apply.
- **CTCP plugin**: Dispatch CTCP VERSION/TIME events, verify correct CTCP replies.
- **Ban mask builder**: Unit test all three ban types (1/2/3) against example hostmasks including IPv4, IPv6, and cloaked hostmasks.

## Decisions

1. **Timed ban persistence across restarts**: On reconnect, lift all bans whose expiry has passed and log how many were cleaned up (e.g. `[chanmod] lifted 3 expired bans after downtime`).
2. **Flood plugin scope**: Opt-in per channel via `channels` array in plugin config. Flood protection is inactive on channels not listed.
3. **CTCP VERSION string**: Auto-read `name` + `version` from `package.json` at plugin load time. No config override needed.
4. **Cloaked hostmask ban masks**: Use the full cloak as-is — `*!*@user/foo`. Precise match, only affects that specific cloaked user. Type 3 wildcard logic is skipped when the hostname contains a `/`.
