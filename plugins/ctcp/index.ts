// n0xb0t — ctcp plugin
// Handles CTCP VERSION, PING, and TIME requests with fixed responses.
// Responses are not user-configurable — like Eggdrop's built-in CTCP handling.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { PluginAPI } from '../../src/types.js';

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
    versionString = `${pkg.name ?? 'n0xb0t'} v${pkg.version ?? '?'}`;
  } catch {
    versionString = 'n0xb0t';
  }

  api.bind('ctcp', '-', 'VERSION', (ctx) => {
    api.ctcpResponse(ctx.nick, 'VERSION', versionString);
  });

  api.bind('ctcp', '-', 'PING', (ctx) => {
    api.ctcpResponse(ctx.nick, 'PING', ctx.text);
  });

  api.bind('ctcp', '-', 'TIME', (ctx) => {
    api.ctcpResponse(ctx.nick, 'TIME', new Date().toString());
  });

  api.log('Loaded');
}
