// HexBot — DCC welcome banner rendering
//
// Pure rendering: takes a snapshot of session + bot state and produces the
// lines that `DCCSession.showBanner()` used to print inline. Kept apart
// from `dcc.ts` so banner tweaks don't require reading the session state
// machine, and so unit tests can snapshot the output directly.
import { stripFormatting } from '../../utils/strip-formatting';
import { type ConsoleFlagLetter, formatFlags } from './console-flags';

/** Live stats surfaced in the DCC session banner. */
export interface BannerStats {
  channels: string[];
  pluginCount: number;
  bindCount: number;
  userCount: number;
  uptime: number; // milliseconds
}

// ---------------------------------------------------------------------------
// IRC formatting helpers (mIRC color codes)
// ---------------------------------------------------------------------------

const B = '\x02'; // bold toggle
const C = (n: number) => `\x03${String(n).padStart(2, '0')}`; // set color
const RC = '\x0F'; // reset all — avoids bare \x03 eating a following digit as a color code

const red = (s: string) => `${C(4)}${s}${RC}`;
const grey = (s: string) => `${C(14)}${s}${RC}`;
const lbl = (s: string, w = 10) => `${C(4)}${B}${s.padEnd(w)}${B}${RC}`; // teal bold, fixed-width

// ---------------------------------------------------------------------------
// Banner art — braille hex icon with colored "HEXBOT" text art
// ---------------------------------------------------------------------------

function bannerLogo(version: string): string[] {
  return [
    `⠀⠀⠀⠀⣠⣤⣶⣶⣶⣤⣄⡀⠀    `,
    `⠀⠀⣴⣾⣿⣿⣿⣿⣿⣧⡀⠈⠢⠀⠀ `,
    `⠀⣼⣿⣿⣿⣿⣿⣿⣿⡿⠁ ⠀⠀⠀  `,
    `⢰⡿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀  `,
    `⠘⣽⡿⠿⠿⣿⣿⣿⣿⣿⣦⣤⡀⠀⠀ `,
    `⠀⣟⠀⠀⠀⣸⣿⡏⠀⠀⠀⢹⠗⠀⠀  `,
    `⠀⣿⣷⣶⣾⡿⠁⠙⣄⣀⣀⣠⡀ ⠀   ${B}${red(`HexBot`)} v${version}${B}`,
    `⠀⠙⠙⢿⡿⣷⣶⣤⣿⣿⡿⠿⠃⠀⠀   ${grey('Hell is empty and all the bots are here.')}`,
    `⠀⠀⠀⠺⡏⡏⡏⡏⡏⠉⠁⠀⠀⠀⠀⠀`,
    `⠀⠀⠀⠀⠀⠀⠁⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀`,
  ];
}

export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

/**
 * Failed-login warning data surfaced at the top of the banner. Omitted or
 * null when there is nothing to warn about (clean session, or the
 * session was started via the preview / test entry points that bypass
 * the real auth pipeline).
 */
export interface BannerLoginSummary {
  failedSince: number;
  mostRecent: { timestamp: number; peer: string } | null;
  lockoutsSince: number;
  /** True when the window anchor is bot-start rather than a prior login. */
  usedBootFallback: boolean;
}

export interface BannerRenderOptions {
  handle: string;
  flags: string;
  nick: string;
  ident: string;
  hostname: string;
  consoleFlags: Set<ConsoleFlagLetter>;
  version: string;
  botNick: string;
  stats: BannerStats | null;
  /** Other active session handles — excludes the session that's being rendered. */
  otherSessions: string[];
  /** Failed-login warning block; omit for preview/test callers. */
  loginSummary?: BannerLoginSummary | null;
}

/** Truncate a peer string so it never overflows one terminal line. */
function truncatePeer(peer: string, max = 40): string {
  if (peer.length <= max) return peer;
  return `${peer.slice(0, max - 1)}…`;
}

/**
 * Render the welcome banner by calling `writeLine` for each line. Called
 * after the password prompt succeeds, or by the dev preview script.
 */
export function renderBanner(opts: BannerRenderOptions, writeLine: (line: string) => void): void {
  // Defensive stripFormatting on user-controlled identity fields. The IRC
  // bridge `sanitize()` strips CR/LF/NUL but leaves mIRC formatting bytes
  // (\x02 bold, \x03 color, \x0f reset, \x1f underline) intact. On
  // non-cloaked networks an attacker who controls their nick/ident/host
  // could otherwise inject color codes that repaint the operator's
  // terminal during the join announcement. Same posture for the
  // session-list strings — a misbehaving admin could store a handle with
  // embedded color which would leak into every other user's banner.
  const handle = stripFormatting(opts.handle);
  const nick = stripFormatting(opts.nick);
  const ident = stripFormatting(opts.ident);
  const hostname = stripFormatting(opts.hostname);
  const otherSessions = opts.otherSessions.map((s) => stripFormatting(s));

  const d = new Date();
  const time = d.toLocaleTimeString();
  const tz = d.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();
  const day = d.getDate();
  const ordinals: Record<Intl.LDMLPluralRule, string> = {
    zero: 'th',
    one: 'st',
    two: 'nd',
    few: 'rd',
    many: 'th',
    other: 'th',
  };
  const ordinal = ordinals[new Intl.PluralRules('en-US', { type: 'ordinal' }).select(day)];
  const date = `${d.toLocaleDateString('en-US', { month: 'long' })} ${day}${ordinal}, ${d.getFullYear()}`;
  const consoleLine =
    otherSessions.length > 0
      ? `${otherSessions.length} other(s) here: ${otherSessions.join(', ')}`
      : 'you are the only one here';

  // Logo
  writeLine('');
  for (const line of bannerLogo(opts.version)) {
    writeLine(line);
  }

  // Greeting
  writeLine('');
  writeLine(
    `Hi ${B}${handle}${B}, I am ${B}${opts.botNick}${B}. The local time is ${time} (${tz}) on ${date}.`,
  );

  // Owner-only notice
  if (opts.flags.includes('n')) {
    writeLine('');
    writeLine(`${red(`⊕`)} You are an owner of this bot.`);
  }

  // Failed-login warning — sits above the stats table so it lands in the
  // most prominent spot without shoving the logo around. Shown only when
  // there's something to warn about.
  const summary = opts.loginSummary ?? null;
  if (summary && (summary.failedSince > 0 || summary.lockoutsSince > 0)) {
    writeLine('');
    if (summary.failedSince > 0) {
      const anchor = summary.usedBootFallback ? 'since bot start' : 'since your last login';
      const noun = summary.failedSince === 1 ? 'failed login attempt' : 'failed login attempts';
      writeLine(`${red('⚠')} ${B}${summary.failedSince}${B} ${noun} ${anchor}`);
      if (summary.mostRecent) {
        const when = new Date(summary.mostRecent.timestamp * 1000).toLocaleTimeString();
        writeLine(`  └ most recent: ${when} from ${truncatePeer(summary.mostRecent.peer)}`);
      }
    }
    if (summary.lockoutsSince > 0) {
      const times = summary.lockoutsSince === 1 ? '1 time' : `${summary.lockoutsSince} times`;
      writeLine(`${red('⚠')} rate-limit triggered ${times} in that window`);
    }
  }

  // Stats table
  writeLine('');
  const flagDisplay = opts.flags ? `+${opts.flags}` : '+-';
  const consoleDisplay = (() => {
    const f = formatFlags(opts.consoleFlags);
    return f.length > 0 ? `+${f}` : '+-';
  })();
  writeLine(`  ${lbl('Session')}${B}${handle}${B} (${nick}!${ident}@${hostname})`);
  writeLine(`  ${lbl('Flags')}${flagDisplay}`);
  writeLine(`  ${lbl('ConFlags')}${consoleDisplay}`);
  if (opts.stats) {
    const chanList = opts.stats.channels.length > 0 ? opts.stats.channels.join(', ') : grey('none');
    writeLine(
      `  ${lbl('Channels')}${B}${opts.stats.channels.length}${B} joined ${grey('│')} ${chanList}`,
    );
    writeLine(
      `  ${lbl('Plugins')}${B}${opts.stats.pluginCount}${B} loaded ${grey('│')} ${B}${opts.stats.bindCount}${B} binds`,
    );
    writeLine(`  ${lbl('Users')}${B}${opts.stats.userCount}${B} registered`);
    writeLine(`  ${lbl('Uptime')}${formatUptime(opts.stats.uptime)}`);
  }
  writeLine(`  ${lbl('Online')}${consoleLine}`);

  // Quick-start commands
  writeLine('');
  writeLine(`Use ${B}.help${B} for basic help.`);
  writeLine(`Use ${B}.help${B} <command> for help on a specific command.`);
  writeLine(`Use ${B}.online${B} to see who is on the console.`);
  writeLine('');
  writeLine(`Commands start with '.' — everything else is console chat.`);
  writeLine('');
}
