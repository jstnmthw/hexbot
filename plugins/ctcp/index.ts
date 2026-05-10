// HexBot — ctcp plugin
// Handles CTCP VERSION, PING, and TIME requests with fixed responses.
// Responses are not user-configurable.
//
// Loop protection: replies go out via `api.ctcpResponse`, which uses
// irc-framework's NOTICE-based CTCP reply (RFC 2812 §3.3.2). NOTICEs must
// not auto-reply, so two HexBots staring at each other can't spiral into
// a CTCP-flood. Do NOT reimplement these as PRIVMSG.
import type { PluginAPI } from '../../src/types';

export const name = 'ctcp';
export const version = '1.0.0';
export const description = 'Replies to CTCP VERSION, PING, and TIME requests.';

/**
 * Plugin entry point. Reads `version` from the bot-supplied
 * `api.botConfig.version` (sourced from `package.json` at boot by core)
 * to construct the VERSION reply, then registers ctcp binds for VERSION /
 * PING / TIME. SECURITY.md §4.1 prohibits plugin filesystem access — this
 * plugin used to crack open `package.json` itself; routing through the
 * api removes the last legitimate `node:fs` import in the plugin tree.
 */
export function init(api: PluginAPI): void {
  // Lowercase bot name matches the prior `package.json`-derived behavior
  // (`pkg.name` is "hexbot"). Keeping the casing stable avoids surprising
  // downstream tooling that scrapes CTCP VERSION replies.
  const versionString = `hexbot v${api.botConfig.version}`;

  api.bind('ctcp', '-', 'VERSION', (ctx) => {
    api.ctcpResponse(ctx.nick, 'VERSION', versionString);
  });

  // CTCP PING echoes the requester's payload verbatim so they can
  // measure round-trip time against their own clock — replacing
  // `ctx.text` with anything else (timestamp, "PONG", etc.) would
  // break the spec and most clients. The `ctcpResponse` helper
  // CTCP-quotes the payload; do not pre-encode it here.
  api.bind('ctcp', '-', 'PING', (ctx) => {
    api.ctcpResponse(ctx.nick, 'PING', ctx.text);
  });

  // CTCP TIME format is intentionally unspecified by the de-facto
  // spec — `new Date().toString()` matches what mIRC and irssi emit.
  api.bind('ctcp', '-', 'TIME', (ctx) => {
    api.ctcpResponse(ctx.nick, 'TIME', new Date().toString());
  });
}

/**
 * Plugin teardown. Binds are auto-reaped by the loader; the explicit
 * export exists to make the no-cleanup case unambiguous and to satisfy
 * tooling that expects the symbol.
 */
export function teardown(): void {}
