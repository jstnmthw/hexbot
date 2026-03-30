# DCC CHAT + Botnet

HexBot supports **passive DCC CHAT** for remote administration. Users with sufficient flags connect directly from their IRC client, get a command prompt, and share a live party line ("botnet") with other connected admins.

---

## Requirements

- **Bot must have a public IPv4 address** — passive DCC means users connect _to the bot_, not the other way around. A VPS or dedicated server works; a home connection behind NAT requires port forwarding.
- **Required flags** — configurable, default `+m` (master). Users without the required flags are rejected.
- Tested clients: **irssi**, **WeeChat**, **HexChat**, **mIRC**

---

## Prerequisites: add yourself to the user database

The DCC handshake authenticates you by your IRC hostmask (`nick!ident@host`). Before you can connect, your hostmask must be registered in the permissions database with at least the flags required by `require_flags` (default `m`).

### Step 1: Find your hostmask

Join a channel the bot is in and run:

```
/whois yournick
```

Look for the `nick!ident@host` line, e.g. `admin!myident@my.vps.com`.

### Step 2: Add yourself

Bot commands (`.adduser`, `.flags`, etc.) are only available from the REPL or a DCC session — not via IRC private message. Start the bot with `--repl` and add yourself:

```
hexbot> .adduser yourhandle *!myident@my.vps.com m
```

Replace `*!myident@my.vps.com` with your actual hostmask pattern. Use `*` as a wildcard for parts that may vary (e.g., `*!*@my.static.ip`). For the owner, use flag `n` instead of `m`.

### Step 3: Verify

```
hexbot> .flags yourhandle
```

---

## Setup

### 1. Find your public IP

The bot's `ip` field must be the address your server is reachable on from the internet:

```bash
curl -4 ifconfig.me
# or
ip -4 addr show eth0 | grep 'inet ' | awk '{print $2}' | cut -d/ -f1
```

If running behind a load balancer or inside a private network, use the public-facing IP, not the private one.

### 2. Open firewall ports

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

### 3. Configure `config/bot.json`

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
*** Connected to HexBot v0.1.0 — Sun, 22 Mar 2026 00:00:00 GMT
*** Logged in as yourhandle (yournick!~ident@your.host)
*** Botnet: 1 other(s): adminhandle
*** Lines starting with . are commands (.help). Plain text is broadcast.
```

### Commands

Any line beginning with `.` is treated as a bot command — the same commands available in the REPL:

```
.help
.plugins
.reload chanmod
.say #channel hello
.flags yourhandle
```

Your permission flags are enforced — you can only run commands you have flags for.

### DCC-only commands

These work only inside a DCC session:

| Command    | Description                             |
| ---------- | --------------------------------------- |
| `.console` | List connected console users and uptime |
| `.who`     | Alias for `.console`                    |
| `.quit`    | Disconnect from the console             |
| `.exit`    | Alias for `.quit`                       |

### Console (shared session)

Any line that does **not** start with `.` is broadcast to all other connected users:

```
hello everyone
<yourhandle> hello everyone          ← echoed back to you
                                     ← other sessions see: <yourhandle> hello everyone
```

When users connect or disconnect you will see:

```
*** otheradmin has joined the console
*** otheradmin has left the console
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

---

## Troubleshooting

### "No DCC CHAT offer received" / client shows nothing

The bot sends its offer as a CTCP reply. Some clients suppress these. Check your client's DCC or CTCP log. In irssi: `/lastlog dcc`. In WeeChat: open the `irc.server.<name>` raw buffer.

### Bot sends a NOTICE instead of opening a chat

The NOTICE text will tell you why:

| Notice contains         | Cause                                                       | Fix                                                    |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| `passive`               | Your client sent active DCC (non-zero ip/port)              | Configure your client to use passive DCC               |
| `user database`         | Your hostmask is not registered                             | Add yourself with `.adduser` (see Prerequisites above) |
| `insufficient flags`    | You don't have the required flags                           | Set your flags with `.flags handle +m`                 |
| `maximum sessions`      | `max_sessions` limit reached                                | Wait for a session to end or increase `max_sessions`   |
| `already connected`     | Your nick is already in an active session                   | Disconnect the existing session first                  |
| `no ports available`    | All ports in `port_range` are in use                        | Wait or widen `port_range`                             |
| `NickServ verification` | `nickserv_verify: true` and NickServ said you're not logged | Identify with NickServ first                           |

### Connection times out after the offer

The bot opens a TCP port and waits 30 seconds for your client to connect. If your client cannot reach the port:

1. Confirm the bot's `ip` is the correct **public** IP (not a private/internal address).
2. Confirm the firewall allows inbound TCP on the configured port range.
3. Test reachability: `nc -zv <bot-ip> 50000` from your machine. If it times out, it's a firewall/routing issue, not a bot issue.
4. Check if the bot is behind a NAT (e.g., cloud VM with a private IP that maps to a public IP) — in that case, the `ip` field must be the **external** public IP, not the private one shown by `ip addr`.

### Client connects but immediately disconnects

This is usually a readline/encoding issue. Try a different IRC client. irssi and WeeChat have the most reliable DCC CHAT implementations.

### irssi: DCC CHAT not appearing

Make sure your irssi has DCC enabled. Check: `/set dcc_autoaccept`. You should see the offer in the status window and accept with `/dcc chat hexbot` or accept the incoming offer.
