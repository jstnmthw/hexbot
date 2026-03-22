# n0xb0t Reference: IRC Protocol Gotchas & Common Patterns

Quick reference for things that trip up IRC bot developers. Read this when you're unsure about IRC-specific behavior.

## IRC message format

```
:nick!ident@hostname COMMAND target :trailing parameter
```

- Maximum message length: ~512 bytes (including the `\r\n`)
- The bot's own prefix (`nick!ident@host`) counts against this limit when the server relays the message
- Safe maximum for message content: ~400 bytes after accounting for protocol overhead

## Splitting long messages

If a reply exceeds the safe limit, split it into multiple messages. Split on word boundaries, not mid-word. Add rate limiting between splits (irc-framework's putserv queue helps).

## Case sensitivity

IRC nicks and channels are case-insensitive, but the rules depend on the CASEMAPPING ISUPPORT token:

- `rfc1459` (most common): `a-z` = `A-Z`, `{` = `[`, `|` = `\`, `}` = `]`, `~` = `^`
- `ascii`: only `a-z` = `A-Z`
- `strict-rfc1459`: like rfc1459 but `~` ≠ `^`

Use `irc-framework`'s `client.caseCompare()` for safe comparison.

## Flood protection

IRC servers kill connections that send too many messages too fast. Typical limits:

- ~5 messages per 2 seconds before throttling
- ~20 messages in a burst before disconnect

`irc-framework` has built-in send queues, but plugins should still avoid:

- Loops that send a message per user in a channel
- Responding to every message in a busy channel
- Sending multiple lines where one would do

## NickServ verification timing

When a user joins a channel, there's a race condition:

1. User JOINs → your bot sees the join
2. User identifies with NickServ (may happen before or after join)
3. Bot queries `NickServ ACC nick` → response comes async

If your auto-op plugin ops on join, it must wait for the ACC response before opping. A naive implementation ops immediately, which means anyone can get ops by using an admin's nick before NickServ catches up.

Pattern: on join, query ACC, wait for response, then op if verified.

## Hostmask patterns

Format: `nick!ident@hostname`

Common wildcard patterns:

- `*!*@specific.host.com` — match anyone from this host
- `*!myident@*` — match anyone with this ident (less reliable)
- `*!*@*.isp.com` — match anyone from this ISP
- `nick!*@*` — match this nick regardless of host (insecure)

On networks with cloaks (Libera, etc.), hostmasks look like `nick!ident@user/accountname` after identification.

## Channel modes reference

Standard modes (available everywhere):

- `+o nick` — operator
- `+v nick` — voice
- `+b mask` — ban
- `+i` — invite only
- `+m` — moderated (only +o/+v can speak)
- `+t` — topic lock (only ops can change topic)
- `+k key` — channel key (password)
- `+l N` — user limit

Common but not universal:

- `+h nick` — half-op (UnrealIRCd, InspIRCd, not Libera)
- `+a nick` — admin/protected (UnrealIRCd)
- `+q nick` — owner (UnrealIRCd)
- `+e mask` — ban exception
- `+I mask` — invite exception

Always check ISUPPORT PREFIX and CHANMODES before assuming a mode exists.

## ISUPPORT tokens the bot cares about

| Token                       | What it tells us                                          |
| --------------------------- | --------------------------------------------------------- |
| `PREFIX`                    | Available user modes and their symbols (e.g., `(ohv)@%+`) |
| `CHANMODES`                 | Available channel modes grouped by type                   |
| `MODES`                     | Max mode changes per MODE command                         |
| `MAXCHANNELS` / `CHANLIMIT` | Max channels the bot can join                             |
| `NICKLEN`                   | Max nick length                                           |
| `TOPICLEN`                  | Max topic length                                          |
| `KICKLEN`                   | Max kick reason length                                    |
| `CASEMAPPING`               | Case comparison rules                                     |
| `NETWORK`                   | Network name                                              |

## Common bind patterns

```javascript
// Command with arguments
api.bind('pub', '-', '!kick', async (ctx) => {
  const target = ctx.args[0]; // First word after !kick
  const reason = ctx.args.slice(1).join(' ') || 'No reason';
});

// Wildcard match on any message containing a URL
api.bind('pubm', '-', '* *http://*', async (ctx) => {});
api.bind('pubm', '-', '* *https://*', async (ctx) => {});

// Timer that fires every 5 minutes
api.bind('time', '-', '300', async (ctx) => {});

// React to ops being given
api.bind('mode', '-', '* +o', async (ctx) => {
  // ctx.target = who got opped
});

// NickServ notice response
api.bind('notice', '-', '*ACC*', async (ctx) => {
  // Parse "nick ACC 3" response
});
```

## Database usage patterns

```javascript
// Store structured data as JSON
api.db.set('game:state', JSON.stringify({ players: [], turn: 0 }));
const state = JSON.parse(api.db.get('game:state'));

// Use key prefixes for different data types
api.db.set(`user:${nick}:score`, String(score));
api.db.set(`user:${nick}:lastSeen`, String(Date.now()));

// List all keys with a prefix
const userKeys = api.db.list('user:');
```
