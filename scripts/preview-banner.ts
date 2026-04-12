#!/usr/bin/env tsx
// Preview the DCC CHAT login banner in your terminal.
// Mocks a DCC session, captures the IRC-formatted output, and translates
// mIRC color codes → ANSI escape sequences so it renders with colors.
//
// Usage:  pnpm exec tsx scripts/preview-banner.ts
//         pnpm exec tsx scripts/preview-banner.ts --flags nm --handle admin
import { PassThrough } from 'node:stream';

import { DCCSession } from '../src/core/dcc';
import type { DCCSessionManager } from '../src/core/dcc';

// ---------------------------------------------------------------------------
// CLI args (all optional)
// ---------------------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const handle = arg('handle', 'admin');
const flags = arg('flags', 'nmof');
const nick = arg('nick', handle);
const botNick = arg('bot', 'hexbot');
const version = arg('version', '0.2.3');

// ---------------------------------------------------------------------------
// IRC → ANSI translator
// ---------------------------------------------------------------------------

const IRC_TO_ANSI: Record<number, string> = {
  0: '\x1b[97m', // white
  1: '\x1b[30m', // black
  2: '\x1b[34m', // blue
  3: '\x1b[32m', // green
  4: '\x1b[31m', // red
  5: '\x1b[33m', // brown/maroon
  6: '\x1b[35m', // purple
  7: '\x1b[33m', // orange
  8: '\x1b[93m', // yellow
  9: '\x1b[92m', // light green
  10: '\x1b[36m', // teal/cyan
  11: '\x1b[96m', // light cyan
  12: '\x1b[94m', // light blue
  13: '\x1b[95m', // pink
  14: '\x1b[90m', // grey
  15: '\x1b[37m', // light grey
};

function ircToAnsi(line: string): string {
  let out = '';
  let i = 0;
  let boldOn = false;
  let ulOn = false;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\x0F') {
      // Reset all
      out += '\x1b[0m';
      boldOn = false;
      ulOn = false;
      i++;
    } else if (ch === '\x02') {
      // Bold toggle
      boldOn = !boldOn;
      out += boldOn ? '\x1b[1m' : '\x1b[22m';
      i++;
    } else if (ch === '\x1F') {
      // Underline toggle
      ulOn = !ulOn;
      out += ulOn ? '\x1b[4m' : '\x1b[24m';
      i++;
    } else if (ch === '\x03') {
      i++;
      // Read up to 2 digits for foreground
      let fg = '';
      if (i < line.length && /\d/.test(line[i])) {
        fg += line[i++];
        if (i < line.length && /\d/.test(line[i])) fg += line[i++];
      }
      if (fg) {
        const n = parseInt(fg, 10);
        out += IRC_TO_ANSI[n] ?? '';
        // Skip optional background ,NN
        if (i < line.length && line[i] === ',') {
          i++;
          if (i < line.length && /\d/.test(line[i])) i++;
          if (i < line.length && /\d/.test(line[i])) i++;
        }
      } else {
        // Bare \x03 = reset color
        out += '\x1b[39m';
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out + '\x1b[0m'; // reset at EOL
}

// ---------------------------------------------------------------------------
// Mock session and capture output
// ---------------------------------------------------------------------------

const socket = new PassThrough();
let buffer = '';

// Accumulate all writes into a single buffer
socket.on('data', (chunk: Buffer) => {
  buffer += chunk.toString();
});

const mockManager: DCCSessionManager = {
  getSessionList: () => [
    { handle, nick, connectedAt: Date.now() },
    { handle: 'alice', nick: 'alice', connectedAt: Date.now() - 120_000 },
  ],
  broadcast: () => {},
  announce: () => {},
  removeSession: () => {},
  notifyPartyPart: () => {},
  getBotName: () => botNick,
  getStats: () => ({
    channels: ['#hexbot', '#dev', '#ops'],
    pluginCount: 8,
    bindCount: 42,
    userCount: 5,
    uptime: 2 * 86400_000 + 3 * 3600_000 + 15 * 60_000 + 42_000,
  }),
  onRelayEnd: null,
};

const session = new DCCSession({
  manager: mockManager,
  user: { handle, hostmasks: [`${nick}!~${nick}@trusted.host`], global: flags, channels: {} },
  nick,
  ident: `~${nick}`,
  hostname: 'trusted.host',
  socket: socket as never, // PassThrough satisfies the Socket write path
  commandHandler: { execute: async () => {} } as never,
  idleTimeoutMs: 600_000,
});

session.start(version, botNick);

// Flush and print — split the accumulated buffer on \r\n
setTimeout(() => {
  const lines = buffer.split('\r\n');
  // Drop trailing empty entry from final \r\n
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    process.stdout.write(ircToAnsi(line) + '\n');
  }
  process.exit(0);
}, 50);
