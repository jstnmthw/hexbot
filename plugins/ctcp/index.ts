// HexBot — ctcp plugin
// Handles CTCP VERSION, PING, and TIME requests with fixed responses.
// Responses are not user-configurable.
//
// Loop protection: replies go out via `api.ctcpResponse`, which uses
// irc-framework's NOTICE-based CTCP reply (RFC 2812 §3.3.2). NOTICEs must
// not auto-reply, so two HexBots staring at each other can't spiral into
// a CTCP-flood. Do NOT reimplement these as PRIVMSG.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { PluginAPI } from '../../src/types';

export const name = 'ctcp';
export const version = '1.0.0';
export const description = 'Replies to CTCP VERSION, PING, and TIME requests.';

/**
 * Plugin entry point. Reads `name` and `version` out of the bot's
 * `package.json` once (at load time) to construct the VERSION reply, then
 * registers ctcp binds for VERSION / PING / TIME.
 */
export function init(api: PluginAPI): void {
  let versionString: string;
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolve('package.json'), 'utf-8'));
    const pkg =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { name?: unknown; version?: unknown })
        : /* v8 ignore next */ {};
    const pkgName = typeof pkg.name === 'string' ? pkg.name : /* v8 ignore next */ 'HexBot';
    const pkgVersion = typeof pkg.version === 'string' ? pkg.version : /* v8 ignore next */ '0.0.0';
    versionString = `${pkgName} v${pkgVersion}`;
  } catch {
    // package.json missing or unreadable (test runs from temp dirs,
    // bundled deployments) — fall back to a bare name so the bot still
    // answers VERSION rather than going silent on the request.
    versionString = 'HexBot';
  }

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
