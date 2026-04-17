# Should HexBot be granted ChanServ founder access on channels it protects?

## Context

The question surfaces because `docs/CHANNEL_PROTECTION.md` recommends
`chanserv_access founder` for "maximum protection," but
`plugins/ai-chat/README.md:143` explicitly warns operators **not** to grant the
bot founder access on channels where ai-chat runs. Those two pieces of
guidance are consistent (one is conservative defence-in-depth for an LLM-faced
surface, the other is an ops-role capability doc) but the overall picture for
an operator is confusing.

The concrete worry: services-backed networks (Atheme / Anope) give a founder
powers that no amount of regular `+o` grants — DROP the channel, transfer
founder to someone else, wipe the access list, AKICK the real human founder.
If the bot's nick is ever compromised (nick hijack, leaked NickServ password,
SASL key theft, prompt-injected LLM emitting a fantasy command), founder turns
a recoverable incident into a permanent loss of the channel.

The flip side is what chanmod actually needs. Looking at
`plugins/chanmod/protection-backend.ts`, `anope-backend.ts`, and
`atheme-backend.ts`:

| Capability                      | Tier required (Atheme) | Tier required (Anope) |
| ------------------------------- | ---------------------- | --------------------- |
| `canOp` (self/others)           | op (+o)                | AOP (level 5)         |
| `canUnban`                      | op                     | AOP                   |
| `canInvite`                     | op                     | AOP                   |
| `canRemoveKey`                  | op (MODE -k)           | AOP (GETKEY)          |
| `canAkick`                      | op (+t)                | SOP (level 10)        |
| `canDeop` (others via ChanServ) | superop (+f/+s)        | SOP                   |
| `canRecover`                    | founder (+R/+F)        | founder (QOP 10000)   |
| `canClearBans`                  | founder                | founder (MODE CLEAR)  |

So founder unlocks exactly two capabilities beyond superop: `canRecover` and
`canClearBans`. Everything else — getting re-opped, unbanning itself,
bypassing +i/+l/+k, mass re-opping other flagged users (which the bot does
via its own `+o` once it has ops back, not via ChanServ), counter-attacking
hostiles, and sticky/enforcebans — works at op/AOP.

## Options

### Option A: Keep the current default (founder recommended)

Leave `docs/CHANNEL_PROTECTION.md` "Maximum protection" recommending
`chanserv_access founder`. Operators get the nicest recovery story on paper:
synthetic MODE CLEAR on Anope, native RECOVER on Atheme.

- **Pro:** Single-command full wipe during a co-ordinated op takeover.
- **Pro:** Matches what a lot of 90s/2000s IRC guides suggest.
- **Con:** The bot's nick becoming a single point of failure is exactly the
  risk you described. A compromised bot with founder can DROP the channel,
  transfer founder, or wipe the access list — none of which are recoverable
  by you as the human founder without services-staff intervention.
- **Con:** The ai-chat README already contradicts this default. An operator
  reading both docs has to reconcile "grant founder for max protection" with
  "never grant founder on ai-chat channels."
- **Con:** Founder expands the blast radius of every other attack class
  (prompt injection, fantasy-command leakage, SASL key theft, a future plugin
  bug that calls `raw()` with user input).
- **Effort:** S (no change).

### Option B: Recommend AOP/op as the default, make founder an opt-in "high-trust" mode

Flip the default recommendation. "Standard protection" and the implicit baseline
become op (Atheme) / AOP (Anope). Founder becomes a documented, clearly labelled
opt-in for operators who have accepted the trade-off (e.g., a locked-down chanmod-
only bot on a low-risk network, or someone who genuinely wants RECOVER and has
weighed the downside).

Concretely:

- Update `docs/CHANNEL_PROTECTION.md` "Recommended settings" tables to default
  to `chanserv_access op` and add a dedicated "Founder trade-off" section that
  enumerates: what founder adds (RECOVER, CLEAR bans), what it risks (DROP,
  SET FOUNDER, FLAGS wipe, AKICK of the real founder), and when it is and
  isn't appropriate.
- Note in that section that operators running ai-chat, any other LLM-driven
  plugin, or any plugin with broad `raw()` surface should stay at op.
- Keep the implementation untouched — chanmod already handles `op` as a
  first-class tier and only enables RECOVER/synthetic-RECOVER when founder is
  confirmed.

- **Pro:** Matches the principle of least privilege that the rest of the
  codebase follows (scoped plugin API, hostmask checks on every privileged
  bind, `auditActor()` convention, etc.).
- **Pro:** Aligns the two docs. The ai-chat note stops looking like an odd
  exception and becomes the general rule, with founder as the exception.
- **Pro:** op-tier protection already handles the realistic attack surface —
  kick/ban, lockdown with +i+k+l, mass deop by a rogue op. The bot regains
  ops via ChanServ OP and then does its own mass re-op + revenge with its own
  +o. RECOVER is only materially better if the attacker has simultaneously
  deopped _every_ trusted user, which is rare on a channel that uses the
  flag/AOP system.
- **Con:** Loses the native `RECOVER` capability on Atheme. Without founder
  the bot can't force-clear ops in one command; it has to wait for ChanServ
  OP and then sort things out itself. In a fast-moving attack this is
  slightly slower.
- **Con:** On Anope, loses `MODE CLEAR ops`. Same practical effect.
- **Con:** Operators upgrading from an older config will see a weaker
  recommendation and may be confused.
- **Effort:** S (docs-only).

### Option C: Add a `founder_restrictions` safety layer in chanmod

Keep allowing founder, but add hard-coded guards in the Atheme/Anope backends
that refuse to ever send DROP, SET FOUNDER, FLAGS wipe, or AKICK against
anyone with `+n`/`+m` flags — even if a caller asks for it. Combined with the
existing ai-chat fantasy-command dropper, this would bound the damage a
compromised bot with founder can do.

- **Pro:** Operators who really want RECOVER can have it without exposing the
  nuclear commands.
- **Con:** Significant new surface in chanmod. Every Atheme/Anope command
  sent by the backend has to be filtered, and the filter list has to cover
  every network dialect we don't currently test against.
- **Con:** Doesn't defend against out-of-chanmod paths. A plugin using
  `raw("PRIVMSG ChanServ :DROP #foo")` bypasses chanmod entirely. Plugin
  authors are not obliged to go through chanmod for services commands.
- **Con:** The most dangerous command on most networks is just
  `PRIVMSG ChanServ :SET #foo FOUNDER attacker`. Writing a reliable allow-list
  of "safe" ChanServ fantasy/services commands across Atheme and Anope is a
  nontrivial ongoing commitment.
- **Effort:** M now, ongoing M for every new network dialect.

### Option D: Two-bot topology — unprivileged AI bot + privileged chanmod bot

Run ai-chat (and other LLM/user-facing surfaces) on one bot nick with no
services access, and run chanmod on a second bot nick that has founder/AOP and
has no plugins that accept LLM output or arbitrary user text. The ai-chat
README already mentions this at the end of the "Operator note" paragraph.

- **Pro:** Clean separation. Compromise of the AI bot can never touch the
  services tier.
- **Pro:** The protective bot's nick can have stricter hostmask restrictions,
  no DCC, no REPL exposure, tighter NickServ enforce settings.
- **Pro:** Doesn't require any code changes — HexBot already supports running
  two instances from different config files.
- **Con:** Two bots in the channel is louder and slightly awkward socially.
- **Con:** Each bot has its own SASL credentials / nick registration to keep
  secure. Slightly more operational overhead.
- **Effort:** S for docs (document the topology as a recommended pattern);
  zero code.

## Recommendation

**Option B, paired with Option D as a documented pattern. High confidence.**

The fear in your question is correct — founder is qualitatively different from
op. It's the only access tier that gives the bot's nick the ability to
permanently destroy the channel (DROP, FOUNDER transfer, FLAGS wipe). Op/AOP
caps the worst-case outcome at "recoverable incident": kicks, bans, deops, key
changes, even AKICK on Anope can all be reversed by the human founder in
minutes. Loss of founder cannot.

The payoff for founder is real but small: `RECOVER` on Atheme is faster and
more complete than the op-tier recovery path, and Anope's synthetic `MODE CLEAR`
sequence is similarly strong. But the op-tier path is not bad — it handles
every attack scenario documented in `docs/CHANNEL_PROTECTION.md` §"Attack
scenarios" _except_ the one that assumes an attacker has already deopped the
bot, deopped every flagged user, and banned the bot, all within the rolling
window. On any channel with an active flag list, the bot can re-op itself and
then use its own `+o` to restore other users.

Concrete changes I'd make:

1. Update `docs/CHANNEL_PROTECTION.md` "Recommended settings" tables so the
   default is `chanserv_access op` (Atheme) / AOP (Anope). Keep founder as a
   documented opt-in with an explicit trade-off section.
2. Add a short "Founder access and bot-nick compromise" section to the same
   doc that enumerates the DROP/FOUNDER/FLAGS-wipe/AKICK risks and notes they
   are unrecoverable without services-staff intervention.
3. Cross-link the ai-chat README note from that section so the two docs tell
   one consistent story.
4. Document the two-bot topology (Option D) as the recommended pattern for
   operators who want both ai-chat and full takeover recovery. No code
   change needed — it's a deployment note.

I would **not** do Option C. Defence-in-depth inside chanmod is worth having,
but a command allow-list inside a services backend is the kind of safety net
that gives operators false confidence without actually closing the holes
(plugin `raw()`, SASL compromise, nick hijack). The cleaner answer is to just
not hand the nuclear codes to a nick that accepts LLM output.

## What Eggdrop does

Eggdrop predates network services, so it has no native "give me founder"
concept; its takeover defence is built entirely around `botnet` cooperation
(several bots opping each other back up) and its own `+o` userflag system.
Where Eggdrop users _do_ register their bot with ChanServ on modern services
networks, the long-standing community guidance — see the eggdrop.conf comments,
the eggheads.org FAQ, and every "setting up eggdrop on Libera" guide of the
last decade — is to grant the bot **ops / AOP only**, never founder, and to
keep the human owner as founder. The reasoning is exactly the one you arrived
at: a bot is a program running on a VM; a channel is a social artefact you
don't want contingent on that VM's integrity.

HexBot's botnet backend (priority 1 in the protection chain, currently stubbed)
is aimed at eventually providing the same services-independent recovery
Eggdrop has always relied on. Until that lands, op/AOP via services is the
closest analogue, and it is sufficient for everything except the RECOVER
shortcut.
