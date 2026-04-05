# Migration: Config secrets to `.env`

Before this change, secrets lived inline in `config/bot.json`. After it, secrets live in `.env` and are referenced from `bot.json` via `<field>_env` keys pointing at env var names.

This is a **hard cutover** — the loader no longer falls back to inline secret values. Once you pull the code change, `bot.json` must use `_env` references for every secret, and the env vars must be set at startup.

## Checklist (single-bot deployment)

1. **Extract current secrets.** Before pulling, copy these values from `config/bot.json` into a secure scratch file:
   - `services.password` — NickServ/SASL password
   - `botlink.password` — botlink shared secret (if enabled)
   - `chanmod.nick_recovery_password` — nick recovery password (if set)
   - `proxy.password` — SOCKS5 password (if set)

   Channel `+k` keys can stay inline — they're operational tokens, not passwords. No action needed.

2. **Pull the code change.**

3. **Create `config/bot.env`:**

   ```bash
   cp config/bot.env.example config/bot.env
   chmod 600 config/bot.env
   ```

   Fill in the values from step 1:

   ```
   HEX_NICKSERV_PASSWORD=...
   HEX_BOTLINK_PASSWORD=...
   HEX_CHANMOD_RECOVERY_PASSWORD=...
   HEX_PROXY_PASSWORD=...
   ```

4. **Update `config/bot.json`** — replace each inline secret with its `_env` counterpart:

   | Before                                         | After                                                           |
   | ---------------------------------------------- | --------------------------------------------------------------- |
   | `"password": "..."` in `services`              | `"password_env": "HEX_NICKSERV_PASSWORD"`                       |
   | `"password": "..."` in `botlink`               | `"password_env": "HEX_BOTLINK_PASSWORD"`                        |
   | `"nick_recovery_password": "..."` in `chanmod` | `"nick_recovery_password_env": "HEX_CHANMOD_RECOVERY_PASSWORD"` |
   | `"password": "..."` in `proxy`                 | `"password_env": "HEX_PROXY_PASSWORD"`                          |

   Channel entries with inline `key` fields stay as-is. The `HEX_` prefix namespaces these vars so they won't collide with other services on the host.

5. **Restart the bot.** Startup validation will fail loudly with the exact env var name if anything is missed:

   ```
   [config] HEX_NICKSERV_PASSWORD must be set (services.sasl is true). Set it in .env or disable SASL.
   ```

6. **Rotate secrets** (recommended). The previous values were in a plaintext JSON file on disk; treat them as compromised and rotate NickServ/botlink passwords after migration.

## Multi-bot deployment

One env file + one bot config per bot, grouped by network:

```bash
tsx --env-file=config/libera/chanbot.env src/index.ts --config=config/libera/chanbot.json
tsx --env-file=config/rizon/enforcer.env src/index.ts --config=config/rizon/enforcer.json
```

Give each bot its own database path (`"database": "./data/libera-chanbot.db"`) too.

## Rollback

Revert the commit and restore inline secrets from step 1's scratch file to `config/bot.json`. There's no automated rollback path — the JSON schema is different after migration.

## What did NOT change

- TLS certificate / key paths (`irc.tls_cert`, `irc.tls_key`) remain in `bot.json`. They're filesystem paths, not secrets.
- The runtime config shape seen by plugins and core code is unchanged — `services.password`, `botlink.password`, etc. still appear on the resolved `BotConfig`. The resolver populates them from env.
