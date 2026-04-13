# DCC CHAT + Console

HexBot supports **passive DCC CHAT** for remote administration. Users with sufficient flags connect directly from their IRC client, enter a password, and share a live console with other connected admins.

---

## Authentication model

DCC CHAT uses **per-user passwords**, the same model Eggdrop has used for 30 years. The hostmask in the DCC handshake tells the bot _which_ handle is claiming to connect; the password proves it. This closes the known spoofing gap on networks where a single vhost persists across nick changes (e.g. Rizon), and it works uniformly on services-free networks like EFNet.

Key properties:

- Passwords are hashed with scrypt before storage — the bot never keeps plaintext.
- Hostmask patterns continue to gate **in-channel** flag checks (`.op`, `.say`, plugin `pub` binds) — prompting on every channel message is not a workable UX.
- DCC CHAT has its own socket-local prompt channel, so it can always ask for a password without looking clumsy.

---

## Requirements

- **Bot must have a public IPv4 address** — passive DCC means users connect _to the bot_, not the other way around. A VPS or dedicated server works; a home connection behind NAT requires port forwarding.
- **Required flags** — configurable, default `+m` (master). Users without the required flags are rejected before the password prompt.
- **A per-user password** — set by an admin via `.chpass` before the user can connect.
- Tested clients: **irssi**, **WeeChat**, **HexChat**, **mIRC**

---

## Prerequisites: register yourself and set a password

A DCC session requires three things: a matching hostmask, the required flags, and a password set by an admin. Step through these once.

### Owner bootstrap (headless / Docker)

If you're running in a container without REPL access, seed the owner's password from an env var instead. Add `password_env` to the owner block in `config/bot.json` and set the variable in `config/bot.env`:

```json
"owner": {
  "handle": "admin",
  "hostmask": "*!yourident@your.host.here",
  "password_env": "HEX_OWNER_PASSWORD"
}
```

```
HEX_OWNER_PASSWORD=choose-a-strong-password
```

On first boot the bot reads the env var, hashes it with scrypt, and stores it. Subsequent boots leave the stored hash alone, so rotations via `.chpass` persist across restarts (same lifecycle as `MYSQL_ROOT_PASSWORD`). If DCC is enabled and the owner has no password set — either from the env var or a previous `.chpass` — the bot logs a loud warning at startup so operators don't silently hit a DCC rejection later.

To force a re-seed from the env var (for example, after losing the password), clear the owner's `password_hash` row in the database and restart the bot.

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

### Step 3: Set a password

From the REPL:

```
hexbot> .chpass yourhandle <newpassword>
```

Passwords must be at least 8 characters. The bot confirms with `chpass: password for "yourhandle" has been updated.` You can rotate later from inside a DCC session with `.chpass <newpassword>` (self-form) or, as an owner, `.chpass <handle> <newpassword>`.

`.chpass` is rejected if issued over IRC PRIVMSG — passwords must never travel on the wire in the clear. The only valid transports are the REPL and an existing DCC session.

### Step 4: Verify

```
hexbot> .flags yourhandle
```

---

## Setup

### 1. Find your bot's public IP

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
sudo ufw allow 49152:49171/tcp

# firewalld (RHEL/Fedora)
sudo firewall-cmd --permanent --add-port=49152-49171/tcp
sudo firewall-cmd --reload

# raw iptables
sudo iptables -A INPUT -p tcp --dport 49152:49171 -j ACCEPT
```

### 3. Configure `config/bot.json`

```json
"dcc": {
  "enabled": true,
  "ip": "203.0.113.42",
  "port_range": [49152, 49171],
  "require_flags": "m",
  "max_sessions": 5,
  "idle_timeout_ms": 300000
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

> **Deprecated:** `nickserv_verify` is retained as a no-op for 0.3.0 and will be removed in 0.4.0. The bot now uses per-user password authentication, which closes the same spoofing gap without depending on services. If the field is still present and truthy, the bot logs a startup warning.

---

## Connecting

After the DCC CHAT handshake completes, the bot sends a single `Password: ` prompt on the socket. Type your password and press enter. On success the banner and console are shown; on failure the bot sends `DCC CHAT: bad password.` and closes the connection. Repeated failures from the same hostmask escalate into a temporary lockout (exponential backoff, matching the bot-link auth policy).

Sessions that have never had a password set are rejected with a one-line notice pointing at `.chpass`. Ask an admin to run `.chpass <handle> <newpassword>` from the REPL and try again.

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

On connect you will see a banner like:

```
  (HexBot ASCII art logo)

Hi yourhandle, I am hexbot. The local time is 12:00:00 AM (UTC) on April 12th, 2026.

Logged in as: yourhandle (yournick!~ident@your.host)
Your flags: +nm

Console: 1 other(s) here: adminhandle

Use .help for basic help.
Use .help <command> for help on a specific command.
Use .console to see who is currently on the console.

Commands start with '.' (like '.quit' or '.help')
Everything else goes out to the console.
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

- Authentication is **password-based**, following the Eggdrop model. The hostmask tells the bot _which_ handle is connecting; the password hash proves it. Scrypt is the KDF — no plaintext is ever stored.
- The password travels over the DCC TCP connection in the clear (same as NickServ IDENTIFY on most IRC networks). This is acceptable for the threat model — a passive eavesdropper on the socket already has a path to every subsequent console command. TLS DCC (DCC SCHAT) is out of scope; operators who need end-to-end encryption should run a bot-to-user tunnel at the transport layer.
- `.chpass` is rejected on the IRC PRIVMSG path — passwords only flow via REPL or an existing DCC session. Do not route command-by-DM as a workaround.
- Keep `require_flags` at `m` or `n` — do not lower it to `o` or `v` without understanding the risk.
- The bot only supports **passive DCC** — it opens the TCP port, the user connects. Active DCC (user opens port, bot dials out) is not supported and will be rejected with a notice.
- Repeated bad-password attempts from the same hostmask trigger a per-identity lockout with exponential backoff; this matches the bot-link auth policy.
- Sessions idle for longer than `idle_timeout_ms` are automatically disconnected. The prompt phase has a shorter 30-second timer — stalled prompts are killed quickly.

---

## Troubleshooting

### "No DCC CHAT offer received" / client shows nothing

The bot sends its offer as a CTCP message. Some clients suppress these. Check your client's DCC or CTCP log. In irssi: `/lastlog dcc`. In WeeChat: open the `irc.server.<name>` raw buffer.

### Bot sends a NOTICE instead of opening a chat

The NOTICE text will tell you why:

| Notice contains         | Cause                                                           | Fix                                                              |
| ----------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `passive DCC CHAT`      | Your client sent active DCC (non-zero ip/port)                  | Enable passive/reverse DCC in your client settings               |
| `user database`         | Your hostmask is not registered                                 | Add yourself with `.adduser` (see Prerequisites above)           |
| `insufficient flags`    | You don't have the required flags                               | Set your flags with `.flags handle +m`                           |
| `maximum sessions`      | `max_sessions` limit reached                                    | Wait for a session to end or increase `max_sessions`             |
| `active session`        | Your nick is already in an active session                       | Disconnect the existing session first                            |
| `already pending`       | A previous DCC offer is still waiting for your connection       | Wait for it to expire (30s) or reconnect                         |
| `no ports available`    | All ports in `port_range` are in use                            | Wait or widen `port_range`                                       |
| `no password set`       | The matched user has no `password_hash` on file                 | Ask an admin to run `.chpass <handle> <newpass>` from the REPL   |
| `bad password`          | You typed the wrong password at the prompt                      | Try again; after several failures the hostmask is locked out     |
| `too many failed`       | Per-hostmask lockout in effect after repeated password failures | Wait out the lockout (escalates exponentially); fix the password |
| `Password prompt timed` | You took longer than 30s to answer the prompt                   | Reconnect and type the password promptly                         |

### Connection times out after the offer

The bot opens a TCP port and waits 30 seconds for your client to connect. If your client cannot reach the port:

1. Confirm the bot's `ip` is the correct **public** IP (not a private/internal address).
2. Confirm the firewall allows inbound TCP on the configured port range.
3. Test reachability: `nc -zv <bot-ip> 49152` from your machine. If it times out, it's a firewall/routing issue, not a bot issue.
4. Check if the bot is behind a NAT (e.g., cloud VM with a private IP that maps to a public IP) — in that case, the `ip` field must be the **external** public IP, not the private one shown by `ip addr`.

### Client connects but immediately disconnects

This is usually a readline/encoding issue. Try a different IRC client. irssi and WeeChat have the most reliable DCC CHAT implementations.

### irssi: DCC CHAT not appearing

Make sure your irssi has DCC enabled. Check: `/set dcc_autoaccept`. You should see the offer in the status window and accept with `/dcc chat hexbot` or accept the incoming offer.
