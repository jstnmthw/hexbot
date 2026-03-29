// HexBot — ctcp plugin
// Handles CTCP VERSION, PING, and TIME requests with fixed responses.
// Responses are not user-configurable
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { PluginAPI } from '../../src/types';

export const name = 'ctcp';
export const version = '1.0.0';
export const description = 'Replies to CTCP VERSION, PING, and TIME requests.';

export function init(api: PluginAPI): void {
  let versionString: string;
  try {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as {
      name?: string;
      version?: string;
    };
    /* v8 ignore start -- ?? fallbacks: package.json always has name and version in the test environment */
    versionString = `${pkg.name ?? 'hexbot'} v${pkg.version ?? '?'}`;
    /* v8 ignore stop */
    /* v8 ignore start -- catch only fires if package.json is missing or malformed */
  } catch {
    versionString = 'HexBot';
  }
  /* v8 ignore stop */

  api.bind('ctcp', '-', 'VERSION', (ctx) => {
    api.ctcpResponse(ctx.nick, 'VERSION', versionString);
  });

  api.bind('ctcp', '-', 'PING', (ctx) => {
    api.ctcpResponse(ctx.nick, 'PING', ctx.text);
  });

  api.bind('ctcp', '-', 'TIME', (ctx) => {
    api.ctcpResponse(ctx.nick, 'TIME', new Date().toString());
  });
}
