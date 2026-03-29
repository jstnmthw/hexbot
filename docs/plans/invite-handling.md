# Plan: INVITE Handling

## Summary

Add full INVITE handling to HexBot in two tiers:

1. **Core auto-join** — bot automatically rejoins any channel it is already configured to be in when invited (no permission check, matches Eggdrop's core behavior).
2. **chanmod `invite` channel setting** — when enabled, accept user-triggered invites from users holding the `o` flag in the channel or the global `m`/`n` flag.

The work touches four source files and one new plugin module in a well-contained sequence: one type union, the dispatcher mask switch, the bridge event handler, one bot core bind, and one new chanmod module.

## Feasibility

- **Alignment**: Fits cleanly into the existing dispatcher/bind architecture. No design changes required.
- **Dependencies**: All required modules exist and are built.
- **Blockers**: None.
- **Complexity**: S — well-contained, follows existing patterns exactly.
- **Risk areas**:
  - Double-join edge case for configured channels that also have the chanmod `invite` setting enabled. Handled by chanmod's "already in channel" guard (`api.getChannel(channel)`), though channel state is updated async after the server confirms the JOIN.

## Hostmask resolution for permission checks

irc-framework's `invite` event includes `nick`, `ident`, and `hostname` directly from the IRC protocol message (`:nick!ident@host INVITE botnick :#channel`). The inviter's full hostmask is present in the event itself — no shared channel or channel state lookup is needed.

This is how Eggdrop handles invite permissions: it matches `nick!ident@host` from the INVITE message directly against its user database. HexBot's chanmod invite handler should do the same — construct `nick!ident@host` from `ctx` and call `api.permissions.findByHostmask(fullHostmask)` directly, bypassing `getUserHostmask()`.

WHOIS is **not** needed for basic flag checking. It would only be warranted if you wanted to gate on services account identity (similar to `require_acc_for`), which is out of scope here.

## Dependencies

- [x] `src/types.ts` — BindType union exists
- [x] `src/dispatcher.ts` — matchesMask and bind system exist
- [x] `src/irc-bridge.ts` — bridge exists with attach() pattern
- [x] `src/bot.ts` — configuredChannels populated, registered handler exists
- [x] `plugins/chanmod/` — channel settings, helpers, and teardown pattern exist

## Phases

### Phase 1: Type system

**Goal:** Add `'invite'` to BindType and document its HandlerContext field semantics.

- [ ] `src/types.ts` — add `'invite'` to `BindType` union after `'quit'` with comment `// Bot invited to a channel, stackable`
- [ ] `src/types.ts` — add `invite` row to HandlerContext field-semantics table comment: nick=inviter, channel=invited channel, text=`"#chan nick!ident@host"`, command=`'INVITE'`, args=`''`
- [ ] **Verify**: `pnpm typecheck` passes with no errors

### Phase 2: Dispatcher mask matching

**Goal:** Teach the dispatcher how to match `'invite'` binds.

- [ ] `src/dispatcher.ts` — add `case 'invite'` to `matchesMask` switch, identical semantics to `join`/`part`: `mask === '*'` matches all; otherwise wildcard match against `#channel nick!ident@host`
- [ ] **Verify**: `pnpm typecheck` passes; existing dispatcher tests still pass

### Phase 3: IRC bridge

**Goal:** Translate irc-framework `invite` events into dispatcher `'invite'` events.

- [ ] `src/irc-bridge.ts` — add `this.listenIrc('invite', this.onInvite.bind(this))` in `attach()`, after the `quit` listener
- [ ] `src/irc-bridge.ts` — implement `private onInvite(event: Record<string, unknown>): void` that sanitizes nick/ident/hostname/channel, validates channel with `isValidChannel`, builds context with `command: 'INVITE'`, `args: ''`, `text: '#chan nick!ident@host'`, and dispatches `'invite'`
- [ ] `tests/irc-bridge.test.ts` — add `describe('invite events')` block:
  - Dispatches with correct ctx fields (nick, channel, command, args, text)
  - Rejects invalid channel names
  - Mask `'*'` matches
  - Mask `'#test *'` matches `#test` but not `#other`
- [ ] **Verify**: `pnpm test` passes

### Phase 4: Core auto-join bind

**Goal:** Bot automatically rejoins configured +i channels on invite, no permission check.

- [ ] `src/bot.ts` — in `registerConnectionEvents`, inside the `'registered'` handler **before** `resolve()`, alongside the other connection wiring (after JOIN error handlers, before the channel join loop), register a dispatcher bind: type `'invite'`, flags `'-'`, mask `'*'`, pluginId `'core'`
- [ ] The bind handler: find the channel in `configuredChannels` (case-insensitive); if found, call `this.client.join(ch.name, ch.key)` and log `INVITE from ${nick}: re-joining configured channel ${ch.name}`; ignore if not a configured channel
- [ ] `tests/bot.test.ts` — add core invite bind tests:
  - Re-joins configured channel with key on invite
  - Ignores invite to non-configured channel
- [ ] **Verify**: `pnpm test` passes

### Phase 5: chanmod invite setting

**Goal:** Plugin-level invite handling with permission checking, per the invite bind pattern.

- [ ] `plugins/chanmod/state.ts` — add `invite: boolean` to `ChanmodConfig` interface and `readConfig()` (default `false`)
- [ ] `plugins/chanmod/invite.ts` — new file implementing `setupInvite(api, config, state)`:
  - Bind `'invite'` on `'*'` with flags `'-'`
  - Check `api.channelSettings.get(channel, 'invite')` — skip if off
  - Construct `fullHostmask = "${ctx.nick}!${ctx.ident}@${ctx.hostname}"` from context (hostmask is available directly from the INVITE message — no channel state lookup needed)
  - Look up user via `api.permissions.findByHostmask(fullHostmask)`; accept if user has global `n`/`m` flags or channel `o` flag
  - Skip if bot already in channel: `if (api.getChannel(channel)) return`
  - Call `api.join(channel)` and log the event
  - Return teardown no-op `() => {}`
- [ ] `plugins/chanmod/index.ts` — register `invite` channel setting in `api.channelSettings.register()`:
  - key: `'invite'`, type: `'flag'`, default: `config.invite`, description: `'Accept invites from ops/masters and join the invited channel'`
- [ ] `plugins/chanmod/index.ts` — import `setupInvite` and add to `teardowns` array in `init()`
- [ ] `tests/plugins/chanmod.test.ts` — add `describe('invite handling')` block:
  - Ignores invite when `invite` setting is off (default)
  - Ignores invite from unprivileged user (hostmask not in permissions DB)
  - Accepts invite from user with `o` channel flag
  - Accepts invite from global master (`m` flag)
  - Skips join if already in channel
- [ ] **Verify**: `pnpm test` passes

### Phase 6: Docs

**Goal:** Keep DESIGN.md accurate.

- [ ] `DESIGN.md` — create a bind type reference table (no existing table) listing all bind types with their HandlerContext field semantics, including the new `invite` type
- [ ] **Verify**: review confirms table is consistent with `src/types.ts`

## Config changes

No bot.json changes needed. chanmod plugin config gets one new optional field:

```json
{
  "invite": false
}
```

Default is `false` (opt-in). Per-channel override via `.chanset #channel invite on`.

## Database changes

None. The `invite` channel setting is stored in the existing `channel_settings` table via the ChannelSettings module.

## Test plan

| Test file                       | What it covers                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `tests/irc-bridge.test.ts`      | Bridge translates invite events correctly; mask matching; invalid channel rejected |
| `tests/core/dispatcher.test.ts` | `matchesMask` for `'invite'` type with wildcard and pattern masks                  |
| `tests/bot.test.ts`             | Core bind re-joins configured channel with key; ignores unknown channels           |
| `tests/plugins/chanmod.test.ts` | Setting off/on, hostmask-based flag checks, already-in-channel guard               |

## Open questions resolved

1. **Inviter hostmask lookup** — irc-framework includes `nick`, `ident`, `hostname` directly in the `invite` event from the IRC message. chanmod's invite handler constructs the hostmask from `ctx` and calls `api.permissions.findByHostmask()` directly. No shared channel needed. No WHOIS needed for flag checking.

2. **Core bind placement** — before `resolve()`, alongside the other connection wiring (JOIN error handlers, channel joins). Keeps all startup setup in one logical block.

3. **`MockIRCClient.join` signature** — needs `join(channel: string, key?: string): void` to allow key assertions in tests. Fix in `tests/helpers/mock-irc.ts` as part of Phase 4.

4. **DESIGN.md bind type table** — no existing table; Phase 6 creates one from scratch covering all bind types.
