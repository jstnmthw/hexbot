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
    const parsed: unknown = JSON.parse(readFileSync(resolve('package.json'), 'utf-8'));
    const pkg =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { name?: unknown; version?: unknown })
        : /* v8 ignore next */ {};
    const pkgName = typeof pkg.name === 'string' ? pkg.name : /* v8 ignore next */ 'HexBot';
    const pkgVersion = typeof pkg.version === 'string' ? pkg.version : /* v8 ignore next */ '0.0.0';
    versionString = `${pkgName} v${pkgVersion}`;
  } catch {
    versionString = 'HexBot';
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
}
