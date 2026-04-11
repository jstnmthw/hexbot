# Plan: Discriminated `HandlerContext` by bind type

## Summary

Today, `HandlerContext` is a single interface where `channel: string | null` and `command` / `args` / `text` have semantics that shift per bind type — a reader has to consult a prose table in `src/types.ts` to know what `ctx.args` means for `kick` vs `pub`. Plugins compensate with 31 `ctx.channel!` non-null assertions, and half a dozen `const channel = ctx.channel!` locals, to reach the real type. This refactor turns the prose table into the type system: `api.bind` becomes generic on `BindType`, and each bind type receives a context whose shape is already narrowed. `ctx.channel!` assertions disappear across the plugin tree, and `ctx.command` / `ctx.args` stop being free-form strings for event types where they have a fixed meaning.

## Feasibility

**Alignment** — Fits DESIGN.md cleanly. The bind system is already described with per-type semantics; this refactor makes the description machine-checked. No architectural change, no new concept, no runtime behavior change.

**Dependencies** — None. All building blocks exist: `BindType` is a string literal union, `HandlerContext` is already the central type, `api.bind` is already the only public registration path, and strict mode is on.

**Blockers** — None. Internal-only types. Plugin API signatures widen (more precise) but remain compatible at call sites because TypeScript can infer `T` from the first argument.

**Complexity estimate** — **M** (half to one day). Mechanical fan-out: one type file, one dispatcher signature, ~15 plugin files, ~6 test helpers. Compiler finds every call site.

**Risk areas**

- `api.bind` must infer `T` from a literal `type` argument — any plugin that stores the bind type in a `const` before calling `bind` will need `as const` or explicit generic. Grep confirms no current plugin does this.
- The dispatcher internally still runs on the widest union (`HandlerContext`) because it genuinely routes events of mixed types. The narrowing is at the plugin-facing boundary, not inside the dispatcher loop.
- `notice` bind is intentionally left as nullable — channel notices and PM notices both exist. Handlers that need the channel must narrow.
- Tests that hand-construct `HandlerContext` to call handlers directly must match the new, narrower per-type shape. Expect mechanical edits in `tests/core/dispatcher*.test.ts` and `tests/plugins/*.test.ts`.
- Command context (`CommandContext` in `src/command-handler.ts`) is a separate type and out of scope — the command router already has its own shape and doesn't need to change.

## Dependencies

- [x] `BindType` union is a single source of truth in `src/types.ts`
- [x] Strict TypeScript is enabled
- [x] No plugin stores `BindType` in a non-literal variable before calling `bind`

## Phases

### Phase 1: New types in `src/types.ts`

**Goal:** Introduce the discriminated per-bind-type context families without removing the existing `HandlerContext` name. Everything still compiles because `HandlerContext` becomes a union alias.

- [ ] In `src/types.ts`, split the existing `HandlerContext` fields into a `BaseHandlerContext` interface that omits `channel`, `command`, and `args` (and `text` if we narrow its meaning for join/part/kick/mode/etc per the table). Keep `nick`, `ident`, `hostname`, `reply`, `replyPrivate` on the base.
- [ ] Add `ChannelHandlerContext` = `BaseHandlerContext & { channel: string; text: string; command: string; args: string }` as the default "channel is set, fields are strings" shape. Used by `pub` / `pubm` which keep the current semantics.
- [ ] Add `NullChannelHandlerContext` = `BaseHandlerContext & { channel: null; ... }` for `msg`, `msgm`, `nick`, `ctcp`, `quit`, `time`, `raw`.
- [ ] Add `NullableChannelHandlerContext` = `BaseHandlerContext & { channel: string | null; ... }` for `notice` only.
- [ ] Add per-event narrower types for the bind types where `command` / `args` have a fixed meaning per the prose table:
  - `JoinContext extends ChannelHandlerContext` with `command: 'JOIN'; args: ''`
  - `PartContext extends ChannelHandlerContext` with `command: 'PART'` (args = reason)
  - `KickContext extends ChannelHandlerContext` with `command: 'KICK'`
  - `NickContext extends NullChannelHandlerContext` with `command: 'NICK'`
  - `ModeContext extends ChannelHandlerContext` with `command` typed as `` `${'+'|'-'}${string}` ``
  - `TopicContext extends ChannelHandlerContext` with `command: 'topic'; args: ''`
  - `InviteContext extends ChannelHandlerContext` with `command: 'INVITE'; args: ''`
  - `QuitContext extends NullChannelHandlerContext` with `command: 'quit'; args: ''`
  - `TimeContext extends NullChannelHandlerContext` with `command: ''; args: ''; text: ''`
  - `JoinErrorContext extends ChannelHandlerContext`
  - `CtcpContext extends NullChannelHandlerContext` (CTCP has its own command/text semantics)
  - `RawContext extends NullChannelHandlerContext`
  - For `pub`/`pubm`/`msg`/`msgm` the generic `Channel`/`NullChannel` forms are enough — their `command` and `args` stay free-form strings (user message content).
- [ ] Add the mapped type:
  ```ts
  export type BindContextFor<T extends BindType> = T extends 'pub'
    ? ChannelHandlerContext
    : T extends 'pubm'
      ? ChannelHandlerContext
      : T extends 'msg'
        ? NullChannelHandlerContext
        : T extends 'msgm'
          ? NullChannelHandlerContext
          : T extends 'join'
            ? JoinContext
            : T extends 'part'
              ? PartContext
              : T extends 'kick'
                ? KickContext
                : T extends 'nick'
                  ? NickContext
                  : T extends 'mode'
                    ? ModeContext
                    : T extends 'raw'
                      ? RawContext
                      : T extends 'time'
                        ? TimeContext
                        : T extends 'ctcp'
                          ? CtcpContext
                          : T extends 'notice'
                            ? NullableChannelHandlerContext
                            : T extends 'topic'
                              ? TopicContext
                              : T extends 'quit'
                                ? QuitContext
                                : T extends 'invite'
                                  ? InviteContext
                                  : T extends 'join_error'
                                    ? JoinErrorContext
                                    : never;
  ```
- [ ] Redefine `HandlerContext` as the union `BindContextFor<BindType>` (or a manual union of the concrete types). This keeps existing internal call sites (dispatcher, permissions, command-handler helper) working on the widest shape.
- [ ] Redefine `BindHandler<T extends BindType = BindType>` as `(ctx: BindContextFor<T>) => void | Promise<void>`. The default type parameter preserves the existing single-typed `BindHandler` alias for consumers that want the widest form.
- [ ] Update the prose table comment above `HandlerContext` to reference the per-type interfaces instead of restating the fields.
- [ ] **Verification:** `pnpm tsc --noEmit` is clean — the union means nothing has actually changed yet for consumers.

### Phase 2: Narrow `api.bind` and the plugin-facing signatures

**Goal:** Make `api.bind<T>(type: T, ...)` generic so the handler parameter is inferred as `BindContextFor<T>`. After this phase, `api.bind('pub', '+o', '!foo', (ctx) => { ... })` gives `ctx.channel: string` at the call site.

- [ ] In `src/types.ts`, update `PluginAPI.bind` to `<T extends BindType>(type: T, flags: string, mask: string, handler: BindHandler<T>): void`. Do the same for `PluginAPI.unbind`.
- [ ] In `src/plugin-loader.ts`, update the concrete implementation of `bind` / `unbind` on the returned `api` object to match the new generic signature. The implementation body doesn't change — it still calls `dispatcher.bind`, which keeps the widest `BindHandler` type internally.
- [ ] In `src/dispatcher.ts`, keep `Dispatcher.bind(type: BindType, flags, mask, handler: BindHandler, pluginId)` on the widest type — plugins are type-checked at `api.bind`, not in the dispatcher. `BindEntry.handler` stays `BindHandler`.
- [ ] Compile; expect errors to surface exactly at plugin call sites where `ctx.channel!` was masking the real type, plus a small number of test helpers. No runtime changes.
- [ ] **Verification:** `pnpm tsc --noEmit` surfaces a finite, predictable list of errors — use this as the Phase 3 worklist.

### Phase 3: Delete `ctx.channel!` across plugins

**Goal:** Remove every `ctx.channel!` and `const channel = ctx.channel!` created to work around the old nullability. Inline `ctx.channel` directly where it reads clearly; keep a local only when the handler uses the same value many times.

- [ ] `plugins/topic/index.ts` — 9 sites. Delete `const channel = ctx.channel!` at line 194; elsewhere inline `ctx.channel` directly in `api.getChannel`, `api.channelSettings.set`, `api.say`, `api.topic`, `api.notice` calls.
- [ ] `plugins/seen/index.ts:71` — inline.
- [ ] `plugins/flood/index.ts:202, 218` — delete `const channel = ctx.channel!` locals.
- [ ] `plugins/greeter/index.ts:88, 148, 166` — delete local + inline the two remaining sites.
- [ ] `plugins/chanmod/auto-op.ts:19` — delete local (pub handler).
- [ ] `plugins/chanmod/commands.ts` — 11 sites (104, 119, 139, 154, 170, 185, 209, 234, 287, 330, 369). Most are `const channel = ctx.channel!` at the top of a `cmd` / `pub` handler body. Delete locals; use `ctx.channel` in call sites, or keep as `const channel = ctx.channel` (no `!`) if the handler reuses it heavily.
- [ ] `plugins/chanmod/topic-recovery.ts:25` — delete local.
- [ ] `plugins/chanmod/invite.ts:12` — delete local.
- [ ] `plugins/chanmod/protection.ts:71, 301` — delete locals.
- [ ] For `notice` bind handlers (the one type that stays nullable): confirm they already narrow `ctx.channel` or don't use it. Grep for `'notice'` binds; the chanserv-notice plugin is the main caller — expect its handler already checks `ctx.channel !== null`.
- [ ] **Verification:** Run `grep -rn "ctx\.channel!" src plugins` — expect zero hits.

### Phase 4: Tighten tests that hand-construct `HandlerContext`

**Goal:** The handful of tests that call handlers directly with a mocked ctx will now fail at compile because they're missing the discriminated shape. Fix them in lockstep.

- [ ] Audit `tests/core/dispatcher.test.ts`, `tests/core/dispatcher-permissions.test.ts`, `tests/core/dispatcher-verification.test.ts`, `tests/core/dispatcher-flood.test.ts` for inline `HandlerContext` literals. Each dispatch call uses a specific bind type — update the literal to satisfy the corresponding `BindContextFor<T>`.
- [ ] Audit `tests/plugins/*.test.ts` — same treatment. Most tests already construct the right shape for their bind; the compiler will name exactly which ones aren't.
- [ ] If the same mock shape appears in 3+ tests, extract a `tests/helpers/handler-context.ts` factory with per-type builders (`pubCtx`, `joinCtx`, `kickCtx`, etc.) that fill in sensible defaults.
- [ ] **Verification:** `pnpm test` passes 2115+ tests (the current baseline).

### Phase 5: Doc + cleanup

**Goal:** Keep the docs in sync and close the loop.

- [ ] Update `plugins/README.md` snippets that reference `ctx.channel` so new plugins inherit the narrowed shape.
- [ ] Update the table comment above `HandlerContext` in `src/types.ts` to cross-reference the per-type interface names (so a reader can jump straight from the table cell to the interface).
- [ ] Update `DESIGN.md` if it documents `HandlerContext` verbatim (most likely not — it references the bind system abstractly).
- [ ] **Verification:** `pnpm tsc --noEmit` clean, `pnpm test` clean, `grep -rn "ctx\.channel!"` returns zero.

## Config changes

None. This is a pure type refactor with zero runtime behavior change.

## Database changes

None.

## Test plan

- **No new tests required.** The refactor's correctness is guarded by (a) `tsc` catching any mismatch between bind type and handler parameter, (b) the existing 2115-test suite which already exercises the runtime behavior of every bind type.
- **Regression guard:** After Phase 5, `grep -rn "ctx\.channel!" src plugins` should return zero, and this should be added to a quick lint sweep or mentioned in the code-review checklist so it doesn't regrow.
- **Spot-check test update target for Phase 4:** the dispatcher tests use inline mocks most heavily; once those compile, the per-plugin tests will mostly follow because they delegate to the same helper shapes.

## Open questions

None — all four design decisions were resolved up front:

1. **Approach:** Generic `bind<T>` with `BindContextFor<T>` mapped type.
2. **`notice`:** stays `string | null`, handlers narrow.
3. **Scope:** also tighten `text`/`command`/`args` per bind type where the meaning is fixed by the prose table.
4. **Plugin migration:** delete `const channel = ctx.channel!` locals and inline `ctx.channel` directly.
