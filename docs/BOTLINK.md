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
- All bots share the same link password (configure a strong, unique passphrase).
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
  "password": "my-strong-shared-secret",
  "max_leaves": 10,
  "sync_permissions": true,
  "sync_channel_state": true,
  "sync_bans": true,
  "ping_interval_ms": 30000,
  "link_timeout_ms": 90000
}
```

| Field                | Description                                                           |
| -------------------- | --------------------------------------------------------------------- |
| `role`               | Must be `"hub"`                                                       |
| `botname`            | Unique name for this bot in the network                               |
| `listen.host`        | Bind address. Use `0.0.0.0` for all interfaces or a specific IP       |
| `listen.port`        | TCP port for leaf connections                                         |
| `password`           | Shared secret. Never sent in plaintext (SHA-256 hashed on the wire)   |
| `max_leaves`         | Maximum simultaneous leaf connections (default 10)                    |
| `sync_permissions`   | Push permission database to leaves on connect                         |
| `sync_channel_state` | Push channel user lists and modes to leaves                           |
| `sync_bans`          | Push shared ban/exempt lists to leaves                                |
| `ping_interval_ms`   | How often the hub pings leaves (default 30s)                          |
| `link_timeout_ms`    | Disconnect leaves that don't respond within this window (default 90s) |

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
  "password": "my-strong-shared-secret",
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
| `password`               | Must match the hub's password exactly                             |
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

### `.botlink status`

Show link status (hub or leaf role, connected leaves/hub).

### `.botlink disconnect <botname>`

Hub-only. Disconnect a specific leaf by botname.

### `.botlink reconnect`

Leaf-only. Force an immediate reconnect to the hub.

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
  admin (Admin) on hub-east — connected 7200s ago
  oper (Oper) on leaf-west — connected 3600s ago
  mod (Mod) on leaf-south — connected 1800s ago (idle 300s)
```

### `.relay <botname>`

DCC-only. Proxy your console session to a remote bot. All input is forwarded to the target bot's command handler. Type `.relay end` to return.

```
.relay leaf-west
*** Relaying to leaf-west. Type .relay end to return.
.status
[leaf-west] Connected to irc.example.net:6697 (TLS)...
.relay end
*** Relay ended. Back on hub-east.
```

---

## Command relay

Commands can be configured to execute on the hub instead of locally. This is useful for permission management — `.adduser`, `.deluser`, `.flags` should modify the hub's authoritative database.

Commands with `relayToHub: true` in their registration options are automatically intercepted on leaf bots and forwarded to the hub for execution. The hub verifies permissions using its own database and returns the result.

---

## Security

- Passwords are SHA-256 hashed before transmission. Plaintext is never sent over the wire.
- Link connections are **unencrypted TCP**. For WAN deployments, use a VPN, SSH tunnel, or WireGuard.
- Do not expose the link port to the public internet without transport encryption.
- The hub is the single source of truth. A compromised hub compromises the entire botnet.

See `docs/SECURITY.md` section 9 for the full security model.

---

## Troubleshooting

**Leaf won't connect:**

- Check that the hub's `listen.port` is reachable from the leaf (firewall, NAT).
- Verify the password matches exactly on both sides.
- Check logs: `[botlink:leaf]` messages show connection attempts and errors.

**Leaf keeps reconnecting:**

- `AUTH_FAILED` in logs means password mismatch. Fix the password and restart.
- `DUPLICATE` means another leaf with the same `botname` is already connected. Each leaf needs a unique name.
- `FULL` means the hub hit `max_leaves`. Increase the limit or disconnect unused leaves.

**Permissions not syncing:**

- Verify `sync_permissions: true` on the hub.
- Check that the leaf received `SYNC_START`/`SYNC_END` in logs.

**Bans not syncing:**

- Verify `sync_bans: true` on the hub.
- Verify the channel has `.chanset #channel shared on`.
