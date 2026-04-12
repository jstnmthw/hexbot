# Bot Linking

HexBot supports **hub-and-leaf bot linking** for multi-bot networks. One bot runs as the hub, and one or more bots connect to it as leaves. Linked bots share permissions, channel state, ban lists, and a cross-bot console.

---

## Topology

```
              Hub bot
            /    |    \
        Leaf1  Leaf2  Leaf3
```

Star topology. The hub is the central authority. Leaves connect to the hub over TCP and never talk directly to each other. The hub fans out frames to all other leaves.

---

## Prerequisites

- All bots in the network must be running HexBot.
- The hub bot must have a reachable IP and open port for leaf connections.
- All bots share the same link password via their `password_env` environment variable (configure a strong, unique passphrase).
- DCC CHAT is recommended but not required (the console and `.relay` command require DCC sessions).

---

## Hub setup

In the hub bot's `config/bot.json`:

```json
"botlink": {
  "enabled": true,
  "role": "hub",
  "botname": "hub-east",
  "listen": {
    "host": "0.0.0.0",
    "port": 5051
  },
  "password_env": "HEX_BOTLINK_PASSWORD",
  "max_leaves": 10,
  "sync_permissions": true,
  "sync_channel_state": true,
  "sync_bans": true,
  "ping_interval_ms": 30000,
  "link_timeout_ms": 90000,
  "max_auth_failures": 5,
  "auth_window_ms": 60000,
  "auth_ban_duration_ms": 300000,
  "auth_ip_whitelist": [],
  "handshake_timeout_ms": 10000,
  "max_pending_handshakes": 3
}
```

| Field                    | Description                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `role`                   | Must be `"hub"`                                                                        |
| `botname`                | Unique name for this bot in the network                                                |
| `listen.host`            | Bind address. Use `0.0.0.0` for all interfaces or a specific IP                        |
| `listen.port`            | TCP port for leaf connections                                                          |
| `password_env`           | Env var holding the shared secret. Never sent in plaintext (scrypt-hashed on the wire) |
| `max_leaves`             | Maximum simultaneous leaf connections (default 10)                                     |
| `sync_permissions`       | Push permission database to leaves on connect                                          |
| `sync_channel_state`     | Push channel user lists and modes to leaves                                            |
| `sync_bans`              | Push shared ban/exempt lists to leaves                                                 |
| `ping_interval_ms`       | How often the hub pings leaves (default 30s)                                           |
| `link_timeout_ms`        | Disconnect leaves that don't respond within this window (default 90s)                  |
| `max_auth_failures`      | Auth failures per IP before temporary ban (default 5)                                  |
| `auth_window_ms`         | Sliding window for counting failures (default 60s)                                     |
| `auth_ban_duration_ms`   | Initial ban duration; doubles on each re-ban, capped at 24h (default 5min)             |
| `auth_ip_whitelist`      | CIDR strings whose IPs bypass auth rate limiting (default `[]`)                        |
| `handshake_timeout_ms`   | Time to wait for HELLO before closing (default 10s)                                    |
| `max_pending_handshakes` | Max concurrent unauthenticated connections per IP (default 3)                          |

---

## Leaf setup

In each leaf bot's `config/bot.json`:

```json
"botlink": {
  "enabled": true,
  "role": "leaf",
  "botname": "leaf-west",
  "hub": {
    "host": "192.168.1.10",
    "port": 5051
  },
  "password_env": "HEX_BOTLINK_PASSWORD",
  "reconnect_delay_ms": 5000,
  "reconnect_max_delay_ms": 60000,
  "ping_interval_ms": 30000,
  "link_timeout_ms": 90000
}
```

| Field                    | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| `role`                   | Must be `"leaf"`                                                  |
| `botname`                | Unique name for this leaf (must differ from hub and other leaves) |
| `hub.host`               | Hub bot's IP address or hostname                                  |
| `hub.port`               | Hub bot's link port                                               |
| `password_env`           | Env var holding the shared secret. Must match the hub's password  |
| `reconnect_delay_ms`     | Initial delay before reconnecting after disconnect (default 5s)   |
| `reconnect_max_delay_ms` | Maximum reconnect delay with exponential backoff (default 60s)    |

Leaves auto-connect on startup and auto-reconnect on disconnect (with exponential backoff). Authentication failures (`AUTH_FAILED`) do not trigger reconnect.

---

## What gets synced

When a leaf connects, the hub pushes its current state:

| Data             | Frame types                                   | Requires                                         |
| ---------------- | --------------------------------------------- | ------------------------------------------------ |
| Permissions      | `ADDUSER` for each user                       | `sync_permissions: true`                         |
| Channel state    | `CHAN` for each channel (users, modes, topic) | `sync_channel_state: true`                       |
| Ban/exempt lists | `CHAN_BAN_SYNC`, `CHAN_EXEMPT_SYNC`           | `sync_bans: true` + per-channel `shared` setting |

After initial sync, mutations are broadcast in real-time:

- Permission changes (`ADDUSER`, `DELUSER`, `SETFLAGS`) are broadcast to all leaves immediately.
- Ban list changes (`CHAN_BAN_ADD`, `CHAN_BAN_DEL`, `CHAN_EXEMPT_ADD`, `CHAN_EXEMPT_DEL`) are broadcast for shared channels.

### Enabling ban sharing for a channel

Use `.chanset` to mark a channel as shared:

```
.chanset #ops shared on
```

Only channels with `shared: on` participate in ban list sync.

---

## Commands

All botlink commands require `+m` (master) flags except `.whom`.

Available `.botlink` subcommands: `status`, `disconnect`, `reconnect`, `bans`, `ban`, `unban`.

### `.botlink status`

Show link status (hub or leaf role, connected leaves/hub).

### `.botlink disconnect <botname>`

Hub-only. Disconnect a specific leaf by botname.

### `.botlink reconnect`

Leaf-only. Force an immediate reconnect to the hub.

### `.botlink bans`

Hub-only. List all active link bans (both automatic from auth failures and manual).

### `.botlink ban <ip|cidr> [duration] [reason...]`

Hub-only. Manually ban an IP address or CIDR range from connecting. Duration is optional (e.g., `1h`, `30m`); omit for a permanent ban.

### `.botlink unban <ip|cidr>`

Hub-only. Remove a ban (automatic or manual) for an IP or CIDR range.

### `.bots`

List all linked bots with role and connection time.

```
Linked bots (3):
hub-east (hub, this bot)
leaf-west (leaf, connected 3600s ago)
leaf-south (leaf, connected 1200s ago)
```

### `.bottree`

Display the botnet topology as an ASCII tree.

```
hub-east (hub)
├─ leaf-west (leaf)
└─ leaf-south (leaf)
```

### `.whom`

No flag requirement. Show all users on the console (DCC sessions) across all linked bots.

```
Console (3 users):
  admin (admin) on hub-east — connected 7200s ago
  oper (oper) on leaf-west — connected 3600s ago
  mod (mod) on leaf-south — connected 1800s ago (idle 300s)
```

### `.bot <botname> <command>`

Execute a command on a specific remote bot. The command is relayed through the link and the result is returned. If `<botname>` matches the local bot, the command runs locally.

```
.bot leaf-west .status
[leaf-west] Connected to irc.example.net:6697 (TLS)...
```

### `.bsay <botname|*> <target> <message>`

Send an IRC message via another linked bot. Use `*` to send via all bots (including local).

```
.bsay leaf-west #channel Hello from the hub!
.bsay * #channel Broadcast to all bots!
```

### `.bannounce <message>`

Broadcast a message to all DCC console sessions across all linked bots.

### `.relay <botname>`

DCC-only. Proxy your console session to a remote bot. All input is forwarded to the target bot's command handler. Type `.relay end` to return.

```
.relay leaf-west
*** Relaying to leaf-west. Type .relay end to return.
.status
Connected to irc.example.net:6697 (TLS)...
.relay end
*** Relay ended. Back on hub-east.
```

---

## Command relay

Commands can be configured to execute on the hub instead of locally. This is useful for permission management — `.adduser`, `.deluser`, `.flags` should modify the hub's authoritative database.

Commands with `relayToHub: true` in their registration options are automatically intercepted on leaf bots and forwarded to the hub for execution. The hub verifies permissions using its own database and returns the result.

---

## Security

- Passwords are scrypt-hashed before transmission. Plaintext is never sent over the wire.
- Link connections are **unencrypted TCP**. For WAN deployments, use a VPN, SSH tunnel, or WireGuard.
- Do not expose the link port to the public internet without transport encryption.
- The hub is the single source of truth. A compromised hub compromises the entire botnet.

See `docs/SECURITY.md` section 9 for the full security model.

---

## Troubleshooting

**Leaf won't connect:**

- Check that the hub's `listen.port` is reachable from the leaf (firewall, NAT).
- Verify the `password_env` environment variable holds the same password on both sides.
- Check logs: `[botlink:leaf]` messages show connection attempts and errors.

**Leaf keeps reconnecting:**

- `AUTH_FAILED` in logs means password mismatch. Fix the `password_env` environment variable and restart.
- `DUPLICATE` means another leaf with the same `botname` is already connected. Each leaf needs a unique name.
- `FULL` means the hub hit `max_leaves`. Increase the limit or disconnect unused leaves.

**Permissions not syncing:**

- Verify `sync_permissions: true` on the hub.
- Check that the leaf received `SYNC_START`/`SYNC_END` in logs.

**Bans not syncing:**

- Verify `sync_bans: true` on the hub.
- Verify the channel has `.chanset #channel shared on`.
