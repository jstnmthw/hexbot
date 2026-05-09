# Are `.set` and `.chanset` two different "channel settings" systems? (And why does `.info` show two formats?)

## Context

The user observed that `.info chanmod` lists ~46 keys (flags rendered as a `+/-` grid, value-typed keys as labeled lines), while `.help chanset` describes a different, smaller per-channel surface. Their question is whether this is two separate systems and whether the format inconsistency is intentional.

Short factual answer first, before getting into trade-offs:

- **There is one settings backend.** Three scopes (`core`, `<plugin-id>`, `<channel>`), one `SettingsRegistry` shape, one DB table. See `DESIGN.md:11`.
- **There are two operator surfaces over that backend.**
  - `.set` / `.unset` / `.info` — the universal surface, accepts any of the three scopes (`src/core/commands/settings-commands.ts`).
  - `.chanset` / `.chaninfo` — a channel-only alias with Eggdrop-style `+key`/`-key` shorthand (`src/core/commands/channel-commands.ts:32`). `.set #chan key value` and `.chanset #chan key value` write to the same registry.
- **Format is shared.** Both surfaces render via `formatFlagGrid` + `formatValueLines` from `src/core/commands/settings-render.ts`. Flags = compact grid, value-typed (`int`/`string`) = labeled line. The `*` marker means "overridden from default." That's by design — the mixed grid+lines layout is the format, not two formats.

So the user is _not_ wrong to feel like there are two things — but the two things are **not** "two channel-settings systems." They are:

1. **Plugin-scope settings** (`chanmod` as a scope) — bot-wide config for the chanmod plugin. ~46 keys, e.g. `services_host_pattern`, `enforce_delay_ms`, `default_ban_duration`, `chanserv_nick`. Edited via `.set chanmod <key> <value>`. These don't vary per channel.
2. **Channel-scope settings** (`#chan` as a scope) — per-channel overrides. ~9 keys registered by chanmod (`bitch`, `enforce_modes`, `auto_op`, `enforcebans`, `protect_ops`, `revenge`, `channel_modes`, `channel_key`, `channel_limit`). Edited via `.chanset #chan +key` _or_ `.set #chan key value`.

The actually-confusing thing the user has stumbled onto is **the overlap between those two scopes inside chanmod**:

| Key             | Plugin scope (`chanmod`) | Channel scope (`#chan`)     |
| --------------- | ------------------------ | --------------------------- |
| `auto_op`       | flag — bot-wide default  | flag — per-channel override |
| `enforce_modes` | flag — bot-wide default  | flag — per-channel override |
| `bitch`         | flag — bot-wide default  | flag — per-channel override |
| `enforcebans`   | flag — bot-wide default  | flag — per-channel override |

…plus four more renamed-but-equivalent pairs (`enforce_channel_modes`/`channel_modes`, `enforce_channel_key`/`channel_key`, `enforce_channel_limit`/`channel_limit`, `punish_deop`/`protect_ops`, `revenge_on_kick`/`revenge`).

The mechanism, as wired in `plugins/chanmod/index.ts:114`, is: chanmod reads its plugin-scope value at `init()` and registers it as the **default** for the channel-scope key with the same name. So `chanmod.bitch = true` means "bitch is on for every channel that hasn't overridden it"; `#foo.bitch = false` means "but #foo opts out." That's a real, useful feature. But operators have to read the code to know that's what's happening — `.info chanmod` and `.chanset #foo` look like two parallel knobs for the same thing.

## Options

### Option A: Document it; change nothing

Add a paragraph to `plugins/chanmod/README.md` and the chanmod section of operator docs explaining the plugin-scope-as-default / channel-scope-as-override pattern. Maybe add a `.help info` or `.help chanset` line that points at the other.

- Pro: zero churn; the design is actually correct, just under-communicated.
- Pro: KV-canonical-after-first-boot semantics stay clean — both scopes already have well-defined precedence.
- Con: confusion will recur for anyone who doesn't read the doc. The .info output offers no visual cue that some of these keys are "defaults that channels override."
- Effort: S.

### Option B: Hide the channel-overridable keys from `.info <plugin>` by default

Add a `flags?: { channelOverridable?: boolean }` field to `PluginSettingDef`. When chanmod registers a key as the default for a channel-scope setting of the same name, mark the plugin-scope copy `channelOverridable: true`. `.info chanmod` then omits those keys from its main output and adds a footer like:

```
9 keys are per-channel — see `.chanset <#chan>`.
```

`.info chanmod --all` (or `.set chanmod` with no key) still shows everything for completeness.

- Pro: cleans up the visible "two surfaces over the same name" problem without changing semantics.
- Pro: the footer line is a built-in pointer to the other surface.
- Con: introduces a new field on the def shape; chanmod needs to flag every overlapping key.
- Con: doesn't help operators who go _through_ `.info chanmod --all` and still see duplicates.
- Effort: S–M.

### Option C: Eliminate the plugin-scope copies; channel-scope is the only surface for overlapping keys

Remove the plugin-scope versions of `bitch`, `auto_op`, `enforce_modes`, `enforcebans`, `punish_deop`, `revenge_on_kick`, and the three `enforce_channel_*` keys. The channel-scope registry becomes the only place these live. The "default for new channels" is whatever the channel-scope def's `default:` field says — which is what `getChannelSnapshot()` already exposes.

To set "bitch on for every channel," the operator would `.chanset` per channel (or use a future bulk operation). A "set this as the default for new channels" capability would need to come from a separate `defaults` mutator on the channel registry — which doesn't exist today.

- Pro: kills the duplicate-key confusion at the source. One key, one home.
- Pro: aligns with the user's `project_chanset_decision.md` memory — channel settings live behind the channel admin layer, not behind plugin-wide keys.
- Con: loses the "change plugin-scope once, every channel inherits" ergonomic. That's a real regression for ops who want bot-wide policy.
- Con: `plugins.json` first-run seed for those keys has to move from the plugin block to a channel-defaults mechanism — non-trivial migration.
- Effort: M–L.

### Option D: Rename plugin-scope copies to make the "default" meaning explicit

Rename the overlapping plugin-scope keys to `default_<name>` (or similar): `chanmod.default_bitch`, `chanmod.default_auto_op`, `chanmod.default_enforce_modes`, `chanmod.default_enforcebans`. Channel-scope keys keep their short names (`bitch`, `auto_op`, …). The plugin-scope key remains the source of the channel default.

- Pro: visible signal in `.info chanmod` that these keys are channel-overridable defaults, not bot-wide knobs.
- Pro: keeps the inheritance ergonomic from Option A while dispelling the "same key in two places" surprise.
- Con: renames break existing `plugins.json` seeds and KV rows — needs a migration. The clean-cut posture (`feedback_clean_cut.md`) makes that cheap, but it's still a one-time cost.
- Con: doesn't address the _non_-overlapping plugin-scope keys (`services_host_pattern`, `enforce_delay_ms`, etc.) at all — operators still need to know those are bot-wide.
- Effort: M (rename + migration script + plugins.json update + tests).

## Recommendation

**Option B + the docs from Option A**, with **Option D as a follow-up only if B doesn't land it.** Confidence: medium-high.

Reasoning:

- The design is correct; the bug is presentation. Plugin-scope-as-default + channel-scope-as-override is a genuinely useful pattern (it's how many Eggdrop modules behave too, see below). Don't dismantle it (Option C) and don't pay the rename cost (Option D) until B has been tried — the cost/value ratio is best on B.
- B leaves muscle memory intact (`.set chanmod bitch true` still works, `.chanset #chan +bitch` still works) but stops the `.info chanmod` snapshot from looking like a wall of duplicates against `.chanset #chan`. A one-line footer pointing at the other surface is the cheapest possible "this is how the two relate" signal.
- The docs paragraph is strictly additive — write it whether or not you do B.
- Format consistency the user noticed isn't actually broken: flags-as-grid + values-as-lines is a deliberate choice in `settings-render.ts` and is shared between the two surfaces. Don't touch it.

If, after B, operators still complain, then Option D is the next step. Skip Option C unless a second plugin starts wanting "default-then-override" semantics and the duplication starts to feel structural.

## What Eggdrop does

Eggdrop draws a much sharper line than HexBot does:

- **`.set`** in Eggdrop is a Tcl-level operator command — it manipulates Tcl global variables (e.g. `set default-flags "p"`). Bot-wide. Read by `eggdrop.conf` at startup; persisted to `eggdrop.conf` only by manual edit. There is no per-channel `.set`.
- **`.chanset`** sets per-channel flags and string options registered by the channel module (e.g. `+enforcebans`, `+bitch`, `greet`, `idle-kick`). Per-channel. Persisted to the channel file (`chanfile`).
- **`.chaninfo`** displays per-channel flags + options. There's no `.info <plugin>` equivalent; module-level config lives in Tcl globals viewable through Tcl introspection, which is operationally distinct.

Importantly, Eggdrop modules **don't** route their bot-wide Tcl globals through the same operator command as their per-channel options. The two surfaces are surfaced through entirely different mechanisms, which is why an Eggdrop operator never asks "wait, is `.set` channel-related?" — the syntactic separation does the work.

HexBot intentionally collapsed both behind one `SettingsRegistry` (good — it gives us live KV, audit, reload classes uniformly). The cost is that the operator surfaces look more similar than the Eggdrop ones do, and that visual similarity is what tripped the user. Option B basically reintroduces a small amount of the Eggdrop-style separation at the _display_ layer without giving up the unified backend.
