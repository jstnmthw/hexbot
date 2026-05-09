# spotify-radio

A plugin that turns hexbot into a classic "now playing" IRC radio
announcer backed by Spotify. The operator starts a Spotify Jam in their
own client, runs `!radio on <jam-url>` in a channel, and the bot polls
the operator's currently-playing track and announces each transition
to the channel as `[radio] Now playing: Song — Artist • Join: <link>`.

This plugin **announces** tracks and **rebroadcasts** the Jam link.
It does not create Jams (Spotify has no Jam API), and it does not
stream audio (Spotify TOS prohibits that).

## Prerequisites

- Spotify **Premium** account on the host that will play the music.
  Jam hosting requires Premium, and (per Spotify's Feb 2026 developer
  policy) newly created developer client IDs require Premium for
  development-mode access.
- Hexbot user with the `n` flag (owner) — the on/off commands are
  owner-only.
- Ability to run `pnpm` on a workstation that can open a browser.

## Setup — workstation side

1. Register an app at <https://developer.spotify.com/dashboard>. When asked
   "Which API/SDKs are you planning to use?", select **Web API** only —
   the plugin does not use the Web Playback SDK, mobile SDKs, or Ads API.
2. Add `http://127.0.0.1:8888/callback` to the app's Redirect URIs.
3. Copy the Client ID and Client Secret.
4. On your local workstation:
   ```sh
   HEX_SPOTIFY_CLIENT_ID=...your-client-id... \
   HEX_SPOTIFY_CLIENT_SECRET=...your-client-secret... \
   pnpm run spotify:auth
   ```
5. Open the printed URL in your browser, complete the Spotify login,
   and authorise hexbot. The terminal will print a `HEX_SPOTIFY_REFRESH_TOKEN=...`
   line — copy that value.

If you cannot open a browser on the host running the auth script,
complete the authorize flow on another device, copy the `code` query
parameter from the redirect URL, and run:

```sh
HEX_SPOTIFY_CLIENT_ID=... HEX_SPOTIFY_CLIENT_SECRET=... \
  pnpm run spotify:auth -- --code <auth-code>
```

## Setup — bot side

1. Add the three values to `config/bot.env` on the bot host:
   ```env
   HEX_SPOTIFY_CLIENT_ID=...
   HEX_SPOTIFY_CLIENT_SECRET=...
   HEX_SPOTIFY_REFRESH_TOKEN=...
   ```
2. Enable the plugin in `config/plugins.json`:
   ```json
   {
     "spotify-radio": {
       "enabled": true,
       "channels": ["#radio"]
     }
   }
   ```
3. Restart the bot, or toggle the plugin live with
   `.set core plugins.spotify-radio.enabled true` from REPL/DCC.

## Usage

| Command           | Flags | Behavior                                                              |
| ----------------- | ----- | --------------------------------------------------------------------- |
| `!radio`          | —     | Print session status (notice to you).                                 |
| `!radio on <url>` | `n`   | Start a session in the current channel; rebroadcast the Jam link.     |
| `!radio off`      | `n`   | Stop the current session and announce that the radio is off.          |
| `!listen`         | —     | Print the current session status to the channel (so others can join). |

Example output:

```
<hexbot> [radio] Radio is on — join the Jam: https://open.spotify.com/socialsession/abc123
<hexbot> [radio] Now playing: Still D.R.E. — Dr. Dre, Snoop Dogg • https://open.spotify.com/track/...
<hexbot> [radio] Now playing: California Love — 2Pac, Dr. Dre • https://open.spotify.com/track/...
```

## Operating it

- **Start a Jam in your Spotify client.** See Spotify's own
  documentation for how — typically: play music, click the device
  picker, choose "Start a Jam".
- **Get the canonical Jam URL.** Spotify's "Copy link" share button
  gives a `spotify.link/...` short URL — the bot will not accept
  these (their target is decoded by client-side JavaScript and cannot
  be server-side validated; see "Security notes"). To get the URL the
  bot wants:
  1. Paste the `spotify.link/...` URL into a browser.
  2. When the "Open Spotify?" prompt appears, **cancel** it.
  3. The page falls back to `https://open.spotify.com/socialsession/<id>?...`.
  4. Copy that URL from the address bar — that's what you paste into
     `!radio on`. The bot strips `utm_*`, `ssp`, and other tracking
     query params before announcing.
- **End the Jam** in your Spotify client when you're done, then run
  `!radio off` in the channel. The Jam link expires when you end the
  Jam in Spotify; clearing the bot's session matches that.
- **Session TTL.** Sessions auto-expire after 6 hours by default
  (override with `session_ttl_hours` in `plugins.json`). The bot
  announces TTL expiry so listeners aren't left looking at a dead link.

## Troubleshooting

| Symptom                                                  | Fix                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bot won't load — `HEX_SPOTIFY_REFRESH_TOKEN not set`     | Run `pnpm run spotify:auth` on your workstation, paste the result into `config/bot.env`, restart.                                                                                                                                                                              |
| `[radio] Authentication with Spotify failed.`            | The refresh token was revoked or scopes changed. Re-run `pnpm run spotify:auth`, update `bot.env`, then `.restart`.                                                                                                                                                            |
| `NickServ verification required for this command.`       | The bot is configured to require NickServ identification for `+n`. Identify with NickServ, then retry.                                                                                                                                                                         |
| Nothing happens when I run `!radio on`                   | Confirm the plugin is loaded (`!plugins`), confirm you have the `n` flag (`.flags <handle>`), confirm the URL matches `https://open.spotify.com/socialsession/<id>` (see "Operating it" for how to obtain that URL — Spotify's "Copy link" gives a short URL the bot rejects). |
| `[radio] Too many errors talking to Spotify. Radio off.` | Network blip or Spotify outage. Check `journalctl` / bot log for the underlying status code; retry later.                                                                                                                                                                      |
| Operator restarted bot mid-session — session is gone     | Sessions don't persist across restarts. Run `!radio on <url>` again. Spotify may also have rotated the refresh token during the previous run; if auth then fails, re-run `pnpm run spotify:auth`.                                                                              |

## Limitations & design notes

- **No Jam discovery.** Spotify exposes no API for creating or listing
  Jams. The link is pasted manually.
- **No listener count.** Spotify exposes no API for that either.
- **No audio streaming.** Forbidden by Spotify TOS. The bot is metadata
  only.
- **One session at a time, bot-wide.** A second `!radio on` while a
  session is live in another channel is refused, not auto-replaced.
- **State does not persist.** Restarting the bot or reloading the
  plugin ends the session.
- **No playback control.** `!radio skip` etc. would require the
  `user-modify-playback-state` scope, which is intentionally not
  requested. Re-run `pnpm run spotify:auth` with that scope manually
  if you want it (this would also require code changes).

## Security notes

- The refresh token is a long-lived credential equivalent to giving
  hexbot read access to your Spotify playback state. Treat it like any
  other password — never paste it into IRC, never check it into git,
  never put it in `plugins.json`.
- Revoke at any time via <https://www.spotify.com/account/apps/>.
- The plugin only accepts `https://open.spotify.com/socialsession/<id>`
  URLs by default. `spotify.link` shorts are **not** in the default allowlist
  because their target is decoded by client-side JavaScript and cannot
  be server-side validated — accepting them turns `!radio on` into a
  potential phishing vector. Operators may opt in by adding
  `"spotify.link"` to `allowed_link_hosts` in `plugins.json`, accepting
  that risk.
- Refresh-token rotation is held in memory only. If Spotify rotates
  the token mid-session, the new value is used for the rest of the
  process lifetime and is **not** written back to `bot.env`. After a
  restart, if Spotify has fully rotated the original token, re-run
  `pnpm run spotify:auth`.
- All track metadata from Spotify is run through `stripFormatting`
  before being announced — a maliciously-named track cannot inject IRC
  control codes into the announcement line.

## Configuration reference

`plugins/spotify-radio/config.json` defaults (overridable from
`plugins.json` except for the three `_env` fields):

| Key                      | Default                     | Description                                                                                                                                                                                 |
| ------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client_id_env`          | `HEX_SPOTIFY_CLIENT_ID`     | Env var holding the Spotify app's Client ID.                                                                                                                                                |
| `client_secret_env`      | `HEX_SPOTIFY_CLIENT_SECRET` | Env var holding the app's Client Secret.                                                                                                                                                    |
| `refresh_token_env`      | `HEX_SPOTIFY_REFRESH_TOKEN` | Env var holding the refresh token from `pnpm run spotify:auth`.                                                                                                                             |
| `poll_interval_sec`      | `10`                        | How often to poll Spotify (seconds). Floor is 10s (dispatcher constraint).                                                                                                                  |
| `session_ttl_hours`      | `6`                         | Maximum session duration before auto-end.                                                                                                                                                   |
| `announce_prefix`        | `[radio]`                   | Prefix on every announcement line.                                                                                                                                                          |
| `allowed_link_hosts`     | `["open.spotify.com"]`      | Hostnames accepted by the URL validator. **Do not add `spotify.link`** unless you accept the phishing risk — it is a redirector whose target the bot cannot validate. See "Security notes". |
| `max_consecutive_errors` | `5`                         | Error budget — session ends after this many consecutive poll failures.                                                                                                                      |
