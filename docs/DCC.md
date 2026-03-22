# DCC CHAT + Botnet

hexbot supports **passive DCC CHAT** for remote administration. Users with sufficient flags connect directly from their IRC client, get a command prompt, and share a live party line ("botnet") with other connected admins.

---

## Requirements

- **Bot must have a public IPv4 address** — passive DCC means users connect _to the bot_, not the other way around. A VPS or dedicated server works; a home connection behind NAT requires port forwarding.
- **Required flags** — configurable, default `+m` (master). Users without the required flags are rejected.
- Tested clients: **irssi**, **WeeChat**, **HexChat**, **mIRC**

---

## Setup

### 1. Open firewall ports

Open the port range you configure in `bot.json` so incoming connections can reach the bot:

```bash
# ufw (Ubuntu/Debian)
sudo ufw allow 50000:50010/tcp

# firewalld (RHEL/Fedora)
sudo firewall-cmd --permanent --add-port=50000-50010/tcp
sudo firewall-cmd --reload

# raw iptables
sudo iptables -A INPUT -p tcp --dport 50000:50010 -j ACCEPT
```

### 2. Configure `config/bot.json`

```json
"dcc": {
  "enabled": true,
  "ip": "203.0.113.42",
  "port_range": [50000, 50010],
  "require_flags": "m",
  "max_sessions": 5,
  "idle_timeout_ms": 300000,
  "nickserv_verify": false
}
```

Replace `203.0.113.42` with the bot's **public** IPv4 address. This is what gets sent to the user's client — it must be reachable from outside.

| Key               | Type             | Default  | Description                                         |
| ----------------- | ---------------- | -------- | --------------------------------------------------- |
| `enabled`         | boolean          | `false`  | Enable DCC CHAT                                     |
| `ip`              | string           | —        | Bot's public IPv4 address                           |
| `port_range`      | [number, number] | —        | Inclusive range for passive DCC listeners           |
| `require_flags`   | string           | `"m"`    | Flags needed to connect (`m` = master, `n` = owner) |
| `max_sessions`    | number           | `5`      | Maximum concurrent DCC sessions                     |
| `idle_timeout_ms` | number           | `300000` | Idle disconnect timeout in ms (default 5 minutes)   |
| `nickserv_verify` | boolean          | `false`  | Require NickServ ACC before accepting session       |

---

## Connecting

### irssi

```
/dcc chat hexbot
```

### WeeChat

```
/dcc chat hexbot
```

### HexChat

Go to **Server → DCC Chat → Open DCC Chat** and enter the bot's nick, or type in the server window:

```
/dcc chat hexbot
```

### mIRC

```
/dcc chat hexbot
```

---

## Session interface

On connect you will see a banner:

```
*** Connected to Hexbot v0.1.0 — Sun, 22 Mar 2026 00:00:00 GMT
*** Logged in as yourhandle (yournick!~ident@your.host)
*** Botnet: 1 other(s): adminhandle
*** Lines starting with . are commands (.help). Plain text is broadcast.
hexbot>
```

### Commands

Any line beginning with `.` is treated as a bot command — the same commands available in the REPL:

```
hexbot> .help
hexbot> .plugins
hexbot> .reload chanmod
hexbot> .say #channel hello
hexbot> .flags yourhandle
```

Your permission flags are enforced — you can only run commands you have flags for.

### DCC-only commands

These work only inside a DCC session:

| Command   | Description                            |
| --------- | -------------------------------------- |
| `.botnet` | List connected botnet users and uptime |
| `.who`    | Alias for `.botnet`                    |
| `.quit`   | Disconnect from the botnet             |
| `.exit`   | Alias for `.quit`                      |

### Botnet (party line)

Any line that does **not** start with `.` is broadcast to all other connected users:

```
hexbot> hello everyone
<yourhandle> hello everyone          ← echoed back to you
                                     ← other sessions see: <yourhandle> hello everyone
```

When users connect or disconnect you will see:

```
*** otheradmin has joined the botnet
*** otheradmin has left the botnet
```

When the REPL is being used locally, you will see:

```
*** REPL: .reload chanmod
```

---

## Security notes

- Authentication is **hostmask-based** — the same system used for IRC flag checks. The IRC network already authenticated the user; their `nick!ident@host` is matched against the permissions database.
- Enable `nickserv_verify: true` on networks where you want an additional NickServ ACC check before opening a session.
- Keep `require_flags` at `m` or `n` — do not lower it to `o` or `v` without understanding the risk.
- The bot only supports **passive DCC** — it opens the TCP port, the user connects. Active DCC (user opens port, bot dials out) is not supported and will be rejected with a notice.
- Sessions idle for longer than `idle_timeout_ms` are automatically disconnected.
