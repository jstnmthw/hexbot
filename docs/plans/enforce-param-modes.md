# Plan: Enforce Unauthorized +k / +l Removal

## Summary

When `enforce_modes` is enabled and no `channel_key` or `channel_limit` is configured, the bot currently ignores unauthorized `+k` and `+l` mode changes. The desired behavior: if the configured state is "no key" / "no limit", then someone setting `+k` or `+l` should be reverted — just like unauthorized `+i`, `+m`, `+p`, `+s` are already reverted.

## How it works today

The "unauthorized simple mode" block (mode-enforce.ts:146-165) explicitly skips parametered modes via two guards:

1. `!target` — +k/+l always have a parameter, so this is false
2. `!PARAM_MODES.has(modeChar)` — explicit exclusion

The dedicated key/limit blocks (lines 167-210) only fire when `channel_key` is non-empty or `channel_limit > 0`. When they're unset, +k/+l slip through completely.

## How Eggdrop handles this

Eggdrop uses `chanmode` which can include `-k` or `-l` to explicitly force-remove those modes. If `chanmode` says nothing about +k/-k, Eggdrop does nothing. Eggdrop removes keys with `-k <the_actual_key>` (not `-k *`).

## Proposed design (stricter than Eggdrop, simpler for users)

When `enforce_modes` is on:

- If `channel_key` is empty and someone sets `+k <key>` → remove with `-k <key>` (using the param from the event)
- If `channel_limit` is 0 and someone sets `+l <n>` → remove with `-l`

This is stricter than Eggdrop (which requires explicit `-k`/`-l` in chanmode) but consistent with hexbot's philosophy where `enforce_modes` means "the configured state is the desired state." No extra configuration needed — the absence of `channel_key` already implies "no key desired."

To remove +k, we use `-k <the_key_that_was_just_set>` from `ctx.args`, matching Eggdrop's approach of using the actual key rather than a wildcard. This is the most portable approach across IRC daemons.

## Feasibility

- **Alignment**: Fully aligned with DESIGN.md — extends existing enforcement logic
- **Dependencies**: None — all required infrastructure exists
- **Blockers**: None
- **Complexity**: M (a day) — Phase 1 is small (reactive enforcement), Phase 2 adds channel mode tracking to channel-state
- **Risk areas**: IRC daemon differences in `-k` handling (mitigated by using the actual key param); `channel info` event timing relative to bot gaining ops on join

## Phases

### Phase 1: Add unauthorized +k/+l removal to reactive enforcement

**Goal:** When enforce_modes is on and no key/limit is configured, revert unauthorized +k/+l.

- [ ] In `plugins/chanmod/mode-enforce.ts`, after the channel key enforcement block (line 187), add a new block:
  - If `!channelKey && canEnforce && modeStr === '+k' && target` → `api.mode(channel, '-k', target)` after delay
  - Log: `Removing unauthorized +k on ${channel} (no channel_key configured, set by ${setter})`
- [ ] Similarly after the channel limit enforcement block (line 210), add:
  - If `channelLimit === 0 && canEnforce && modeStr === '+l'` → `api.mode(channel, '-l')` after delay
  - Log: `Removing unauthorized +l on ${channel} (no channel_limit configured, set by ${setter})`
- [ ] Verify: load chanmod with `enforce_modes: true` but no `channel_key`/`channel_limit` configured. Have a user set `+k foo` and `+l 10` — bot should revert both.

### Phase 2: Track channel modes in channel-state + proactive sync on join

**Goal:** channel-state learns the channel's current mode string, key, and limit so that `syncChannelModes()` can remove unauthorized +k/+l on join (not just react to live changes).

**Why this is needed:** `syncChannelModes()` is called on bot join (auto-op.ts:14) and on `.chanset` changes. Today it can _add_ configured modes but can't _remove_ unconfigured ones because `ch.modes` is always `''` — channel-state only tracks per-user modes (+o/+v/+h), not channel modes (+i/+k/+l/+s/etc.).

**How irc-framework provides this:** When the server sends RPL_CHANNELMODEIS (numeric 324), irc-framework emits `'channel info'` with `{ channel, modes, raw_modes, raw_params }`. The server sends 324 in response to `MODE #channel` (no args). irc-framework does NOT auto-request this on join — we need to send `MODE #channel` ourselves.

#### Phase 2a: Extend ChannelInfo to track channel modes

- [ ] Add `key` and `limit` fields to `ChannelInfo` in `src/core/channel-state.ts`:
  ```ts
  export interface ChannelInfo {
    name: string;
    topic: string;
    modes: string; // now actually populated: 'ntsk', 'nts', etc.
    key: string; // NEW: current channel key ('' if none)
    limit: number; // NEW: current channel limit (0 if none)
    users: Map<string, UserInfo>;
  }
  ```
- [ ] Update `ensureChannel()` to initialize `key: ''` and `limit: 0`

#### Phase 2b: Listen for `channel info` event

- [ ] In `ChannelState.attach()`, add `this.listen('channel info', this.onChannelInfo.bind(this))`
- [ ] Implement `onChannelInfo()`:
  - Parse `raw_modes` (e.g. `'+ntsk'`) and `raw_params` (e.g. `['secretkey']`) to extract the mode chars, key, and limit
  - Set `ch.modes` to the simple mode chars (e.g. `'ntsk'`)
  - Set `ch.key` from +k param if present, else `''`
  - Set `ch.limit` from +l param if present, else `0`

#### Phase 2c: Update `onMode()` to track channel mode changes

- [ ] Extend the existing `onMode()` handler to also update `ch.modes`, `ch.key`, and `ch.limit` for non-user mode changes:
  - `+i`/`-i`, `+m`/`-m`, etc. → add/remove from `ch.modes` string
  - `+k <key>` → set `ch.key`, add `'k'` to `ch.modes`
  - `-k` → clear `ch.key`, remove `'k'` from `ch.modes`
  - `+l <n>` → set `ch.limit`, add `'l'` to `ch.modes`
  - `-l` → clear `ch.limit`, remove `'l'` from `ch.modes`

#### Phase 2d: Request MODE on bot join

- [ ] In `auto-op.ts`, after the bot joins a channel, send `raw('MODE #channel')` to request the current mode string. This triggers RPL_CHANNELMODEIS → `channel info` → `onChannelInfo()` populates `ch.modes`/`ch.key`/`ch.limit`.
- [ ] Chain `syncChannelModes()` to the `channel info` event rather than relying on the enforce_delay timer. When `onChannelInfo` fires for a channel, emit a `channel:modesReady` event on the event bus. The chanmod plugin listens for that event and calls `syncChannelModes()` — guaranteeing state is populated before sync runs. Keep the existing timer-based sync on `.chanset` changes (where state is already current).

#### Phase 2e: Extend `syncChannelModes()` to remove unauthorized modes

- [ ] After the existing "add missing modes" block, add a "remove unauthorized modes" block:
  - Compare `ch.modes` against `desiredModes` — any mode in current but not in desired (excluding user-mode chars) gets `-` applied
  - If `!channelKey && ch.key` → `api.mode(channel, '-k', ch.key)`
  - If `channelLimit === 0 && ch.limit > 0` → `api.mode(channel, '-l')`
- [ ] Verify: bot joins a channel with `+k oldkey` already set, `channel_key` is empty, `enforce_modes` on → bot removes the key

### Phase 3: Tests

**Goal:** Full test coverage for both reactive and proactive enforcement.

#### Phase 3a: Reactive enforcement tests (Phase 1)

- [ ] `tests/plugins/chanmod.test.ts` — new describe block: "unauthorized +k removal (no channel_key configured)"
  - Test: user sets `+k foo` with enforce_modes on, no channel_key → bot sends `MODE #test -k foo`
  - Test: user sets `+k foo` with enforce_modes OFF → bot does NOT remove it
  - Test: bot itself sets +k → not reverted (isBotNick guard)
  - Test: nodesynch nick sets +k → not reverted
- [ ] `tests/plugins/chanmod.test.ts` — new describe block: "unauthorized +l removal (no channel_limit configured)"
  - Test: user sets `+l 10` with enforce_modes on, no channel_limit → bot sends `MODE #test -l`
  - Test: user sets `+l 10` with enforce_modes OFF → bot does NOT remove it

#### Phase 3b: Channel-state mode tracking tests (Phase 2)

- [ ] `tests/core/channel-state.test.ts` — new describe block: "channel mode tracking"
  - Test: `channel info` event populates `ch.modes`, `ch.key`, `ch.limit`
  - Test: `+k` / `-k` mode events update `ch.key` and `ch.modes`
  - Test: `+l` / `-l` mode events update `ch.limit` and `ch.modes`
  - Test: simple mode changes (+i, -i, +s, -s) update `ch.modes`

#### Phase 3c: Proactive sync tests (Phase 2)

- [ ] `tests/plugins/chanmod.test.ts` — new describe block: "proactive removal of unauthorized modes on join"
  - Test: channel has `+k oldkey`, no `channel_key` configured → bot sends `-k oldkey` on join sync
  - Test: channel has `+l 50`, no `channel_limit` configured → bot sends `-l` on join sync
  - Test: channel has `+k oldkey`, `channel_key` = `"newkey"` → bot sends `+k newkey` (existing behavior, verify still works)

### Phase 4: Update setting descriptions

**Goal:** Make the behavior clear in help text.

- [ ] Update `channel_key` description in `plugins/chanmod/index.ts` from `'Channel key (+k) to enforce when enforce_modes is on (empty = disabled)'` to `'Channel key (+k) to enforce (empty = remove unauthorized keys when enforce_modes is on)'`
- [ ] Update `channel_limit` description similarly: `'Channel user limit (+l) to enforce (0 = remove unauthorized limits when enforce_modes is on)'`

## Config changes

None — uses existing `enforce_modes`, `channel_key`, and `channel_limit` settings.

## Database changes

None.

## Test plan

See Phase 3 above. Key scenarios:

1. **Reactive: unauthorized +k, no key configured** → removed immediately
2. **Reactive: unauthorized +l, no limit configured** → removed immediately
3. **Reactive: configured key, someone removes it** → restored (already works)
4. **Reactive: configured limit, someone changes it** → corrected (already works)
5. **Reactive: enforce_modes off** → nothing happens
6. **Reactive: bot/nodesynch nicks** → exempt from enforcement
7. **Proactive: bot joins channel with stale +k, no key configured** → removed on join sync
8. **Proactive: bot joins channel with stale +l, no limit configured** → removed on join sync
9. **Channel-state: modes/key/limit tracked correctly through mode changes and channel info events**

## Open questions

None.
