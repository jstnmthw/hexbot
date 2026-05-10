# spotify-radio

A plugin that turns hexbot into a classic "now playing" IRC radio
announcer backed by Spotify. The operator starts a Spotify Jam in their
own client, runs `!radio on <jam-url>` in a channel, and the bot polls
the operator's currently-playing track and announces each transition
to the channel as `[radio] Now playing: Artist — Song • Tune In: <jam-url>`.

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
<hexbot> [radio] Radio is on — Tune In: https://spotify.link/b43IsXDr02b
<hexbot> [radio] Now playing: Mat Zo — Astatine • Tune In: https://spotify.link/b43IsXDr02b
<hexbot> [radio] Now playing: Dr. Dre, Snoop Dogg — Still D.R.E. • Tune In: https://spotify.link/b43IsXDr02b
-HexBot- [radio] Current DJ: alice • LIVE: 4m • Tune In: https://spotify.link/b43IsXDr02b
```

The last line is what `!radio` (no args) sends as a notice; `!listen`
sends the same line to the channel so others can pick up the URL.

To rename the `[radio]` tag, an owner runs
`.set spotify-radio announce_prefix <value>` (control bytes are stripped,
length is capped at 32, an empty value falls back to `[radio]`).

Every line points listeners at the Jam URL the operator pasted, not
the per-track Spotify page — the radio's job is to feed people into
the host's Jam so they can listen along.

## Operating it

- **Start a Jam in your Spotify client.** See Spotify's own
  documentation for how — typically: play music, click the device
  picker, choose "Start a Jam".
- **Get the share URL.** In Spotify's share menu, choose "Copy link".
  Paste the resulting `spotify.link/<token>` URL straight into
  `!radio on` — the bot accepts it. If you'd rather paste the
  canonical form, open the short link in a browser, cancel the
  "Open in Spotify?" prompt, and copy the
  `https://open.spotify.com/socialsession/<id>` URL from the address
  bar instead. Either form is fine; the bot strips `utm_*`, `ssp`,
  and other tracking params before announcing.
- **End the Jam** in your Spotify client when you're done, then run
  `!radio off` in the channel. The Jam link expires when you end the
  Jam in Spotify; clearing the bot's session matches that.
- **Session TTL.** Sessions auto-expire after 6 hours by default
  (override with `session_ttl_hours` in `plugins.json`). The bot
  announces TTL expiry so listeners aren't left looking at a dead link.

## Troubleshooting

| Symptom                                                  | Fix                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot won't load — `HEX_SPOTIFY_REFRESH_TOKEN not set`     | Run `pnpm run spotify:auth` on your workstation, paste the result into `config/bot.env`, restart.                                                                                                                            |
| `[radio] Authentication with Spotify failed.`            | The refresh token was revoked or scopes changed. Re-run `pnpm run spotify:auth`, update `bot.env`, then `.restart`.                                                                                                          |
| `NickServ verification required for this command.`       | The bot is configured to require NickServ identification for `+n`. Identify with NickServ, then retry.                                                                                                                       |
| Nothing happens when I run `!radio on`                   | Confirm the plugin is loaded (`!plugins`), confirm you have the `n` flag (`.flags <handle>`), confirm the URL is a `spotify.link/<token>` share short-link or a canonical `https://open.spotify.com/socialsession/<id>` URL. |
| `[radio] Too many errors talking to Spotify. Radio off.` | Network blip or Spotify outage. Check `journalctl` / bot log for the underlying status code; retry later.                                                                                                                    |
| Operator restarted bot mid-session — session is gone     | Sessions don't persist across restarts. Run `!radio on <url>` again. Spotify may also have rotated the refresh token during the previous run; if auth then fails, re-run `pnpm run spotify:auth`.                            |

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
- The plugin accepts two URL forms by default: the canonical
  `https://open.spotify.com/socialsession/<id>` and the share-menu
  short-link `https://spotify.link/<token>`. Both are
  Spotify-controlled namespaces — `spotify.link` is a vanity domain
  Spotify owns and CNAMEs at Branch.io's redirector. The bot does
  **not** follow the short link to inspect its target; the operator's
  account is `+n` and the threat model is the operator, not arbitrary
  third parties. Do **not** add `spotify.app.link` or other URL
  shorteners — `app.link` is Branch's shared subdomain (any Branch
  customer can register one), not a Spotify-owned namespace.
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

| Key                      | Default                                | Description                                                                                                                                                                                                             |
| ------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client_id_env`          | `HEX_SPOTIFY_CLIENT_ID`                | Env var holding the Spotify app's Client ID.                                                                                                                                                                            |
| `client_secret_env`      | `HEX_SPOTIFY_CLIENT_SECRET`            | Env var holding the app's Client Secret.                                                                                                                                                                                |
| `refresh_token_env`      | `HEX_SPOTIFY_REFRESH_TOKEN`            | Env var holding the refresh token from `pnpm run spotify:auth`.                                                                                                                                                         |
| `poll_interval_sec`      | `10`                                   | How often to poll Spotify (seconds). Floor is 10s (dispatcher constraint).                                                                                                                                              |
| `session_ttl_hours`      | `6`                                    | Maximum session duration before auto-end.                                                                                                                                                                               |
| `announce_prefix`        | `[radio]`                              | Prefix on every announcement line. Live-tunable: `.set spotify-radio announce_prefix "[FM]"` takes effect on the next announcement. Control bytes are stripped, capped at 32 characters, empty falls back to `[radio]`. |
| `allowed_link_hosts`     | `["open.spotify.com", "spotify.link"]` | Hostnames accepted by the URL validator. Both defaults are Spotify-controlled. **Do not add `spotify.app.link`** (Branch.io's shared subdomain — not Spotify-owned) or arbitrary URL shorteners. See "Security notes".  |
| `max_consecutive_errors` | `5`                                    | Error budget — session ends after this many consecutive poll failures.                                                                                                                                                  |
