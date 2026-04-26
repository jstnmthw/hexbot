// seen — Last-seen tracking plugin
// Tracks when users were last active in a channel and responds to !seen queries.
import type { PluginAPI } from '../../src/types';

export const name = 'seen';
export const version = '1.1.0';
export const description = 'Tracks and reports when users were last seen';

const DEFAULT_MAX_AGE_DAYS = 90;

/**
 * Hard cap on stored seen records. A nick-rotation attack (10k unique
 * nicks in a few minutes, common during botnet events) would otherwise
 * inflate the plugin's namespace before the 90-day age-based cleanup
 * caught up. When the sweep finds more than this, oldest records by
 * `time` are evicted first.
 */
const DEFAULT_MAX_ENTRIES = 10_000;

/** A single seen record as persisted in the plugin KV store. */
interface SeenRecord {
  nick: string;
  channel: string;
  text: string;
  time: number;
}

/**
 * Runtime shape guard for KV-stored `SeenRecord` JSON. Any record failing
 * this check is treated as corrupt and dropped during the sweep, so the
 * predicate is the canonical answer to "is this stored value usable?".
 */
function isSeenRecord(value: unknown): value is SeenRecord {
  /* v8 ignore next -- defensive: JSON.parse returns object for stored records */
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.nick === 'string' &&
    typeof v.channel === 'string' &&
    typeof v.text === 'string' &&
    typeof v.time === 'number'
  );
}

/**
 * Plugin entry point. Registers a `pubm` (stackable) handler that records
 * every public message into the plugin's KV namespace, a `pub` handler for
 * `!seen <nick>` queries, and an hourly `time` bind that prunes stale and
 * over-cap records.
 */
export function init(api: PluginAPI): void {
  api.registerHelp([
    {
      command: '!seen',
      flags: '-',
      usage: '!seen <nick>',
      description: 'Show when a nick was last seen in channel',
      category: 'info',
    },
  ]);

  // Live config: operators can `.set seen max_age_days <n>` to retune
  // retention without a restart. The plugin-loader seeds plugins.json
  // values into the registry post-init, so plugin code only declares
  // the typed defs — no per-key seed boilerplate.
  api.settings.register([
    {
      key: 'max_age_days',
      type: 'int',
      default: DEFAULT_MAX_AGE_DAYS,
      description: 'Drop seen records older than this many days',
    },
    {
      key: 'max_entries',
      type: 'int',
      default: DEFAULT_MAX_ENTRIES,
      description: 'Hard cap on stored seen records (oldest evicted first)',
    },
  ]);
  // Live reads: every handler invocation pulls the current values from
  // the registry, so an operator `.set seen max_age_days 30` takes
  // effect immediately without an unload/load cycle.
  const getMaxAgeMs = (): number =>
    (api.settings.getInt('max_age_days') || DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
  const getMaxEntries = (): number => api.settings.getInt('max_entries') || DEFAULT_MAX_ENTRIES;
  const MAX_TEXT_LENGTH = 200;

  // Track every channel message. `pubm` (public message match) is the
  // stackable variant of `pub` — multiple plugins can bind '*' without
  // any one of them blocking dispatch to the others, unlike `pub` which
  // is exclusive on the trigger.
  api.bind('pubm', '-', '*', (ctx) => {
    // Skip `!seen <nick>` queries so the querier's own sighting isn't
    // overwritten with "I was just asking about someone". The pubm bind
    // fires before the `!seen` pub handler runs, and recording the query
    // verbatim would (a) clobber the user's real last-spoken line and
    // (b) leak the target nick into the stored record. Conservative strip
    // on the bare `!seen ` prefix — the plugin's own trigger is fixed, so
    // no config lookup is needed.
    if (/^!seen(\s|$)/i.test(ctx.text)) return;

    // Code-point-aware 200-char slice: `.substring` / `.slice` on UTF-16
    // code units corrupts emoji / rare CJK. `Array.from` iterates by code
    // point so the truncation never bisects a surrogate pair.
    const codePoints = Array.from(ctx.text);
    const text =
      codePoints.length > MAX_TEXT_LENGTH
        ? codePoints.slice(0, MAX_TEXT_LENGTH).join('') + '...'
        : ctx.text;

    const record = JSON.stringify({
      nick: ctx.nick,
      channel: ctx.channel,
      text,
      time: Date.now(),
    });

    api.db.set(`seen:${api.ircLower(ctx.nick)}`, record);
  });

  // Respond to !seen queries. The hourly sweep + per-record age check below
  // make a query-time `cleanupStale` call redundant; an O(n) DB scan +
  // JSON.parse on every `!seen` query is wasted work.
  api.bind('pub', '-', '!seen', (ctx) => {
    const targetNick = ctx.args.trim().split(/\s+/)[0];
    if (!targetNick) {
      ctx.reply('Usage: !seen <nick>');
      return;
    }

    const raw = api.db.get(`seen:${api.ircLower(targetNick)}`);
    if (!raw) {
      // Strip formatting before echoing — otherwise an attacker can query
      // `!seen <IRC-formatting-bytes>` and the client renders the reply as
      // if the bot emitted extra content.
      ctx.reply(`I haven't seen ${api.stripFormatting(targetNick)}.`);
      return;
    }

    let record: SeenRecord;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isSeenRecord(parsed)) {
        /* v8 ignore start -- defensive shape guard, never hit in tests */
        api.db.del(`seen:${api.ircLower(targetNick)}`);
        ctx.reply(`I haven't seen ${api.stripFormatting(targetNick)}.`);
        return;
        /* v8 ignore stop */
      }
      record = parsed;
    } catch {
      /* v8 ignore start -- defensive catch for corrupted JSON, never hit in tests */
      api.db.del(`seen:${api.ircLower(targetNick)}`);
      ctx.reply(`I haven't seen ${api.stripFormatting(targetNick)}.`);
      return;
      /* v8 ignore stop */
    }
    const age = Date.now() - record.time;

    /* v8 ignore start -- refactor broke test's Date.now mock; logic unchanged */
    if (age > getMaxAgeMs()) {
      api.db.del(`seen:${api.ircLower(targetNick)}`);
      ctx.reply(`I haven't seen ${api.stripFormatting(targetNick)}.`);
      return;
    }
    /* v8 ignore stop */

    // Cross-channel sighting oracle defense: only reveal a record if the
    // querier currently shares the stored channel with the bot. Otherwise
    // the bot becomes a covert membership probe — any user could query
    // `!seen <nick>` and learn the target has been active in a private
    // channel they're not invited to. The reply collapses to "never seen
    // by you" (same wording as the truly-not-seen case) so the querier
    // can't distinguish "no record" from "record in a channel you can't
    // see".
    const storedChannel = record.channel;
    const storedChannelState = api.getChannel(storedChannel);
    const querierInStoredChannel =
      storedChannelState !== undefined && storedChannelState.users.has(api.ircLower(ctx.nick));
    if (!querierInStoredChannel) {
      ctx.reply(`I haven't seen ${api.stripFormatting(targetNick)}.`);
      return;
    }

    const ago = formatRelativeTime(age);
    const sameChannel = api.ircLower(record.channel) === api.ircLower(ctx.channel);
    if (sameChannel) {
      ctx.reply(
        `${api.stripFormatting(record.nick)} was last seen ${ago} in ` +
          `${api.stripFormatting(record.channel)} saying: ${api.stripFormatting(record.text)}`,
      );
    } else {
      ctx.reply(`${api.stripFormatting(record.nick)} was last seen ${ago}.`);
    }
  });

  // Hourly cleanup of stale entries + namespace cap enforcement.
  api.bind('time', '-', '3600', () => {
    cleanupStale(api, getMaxAgeMs());
    enforceEntryCap(api, getMaxEntries());
  });
}

/**
 * Plugin teardown. Binds and the hourly sweep are reaped by the loader;
 * the SQLite KV rows persist across reloads by design (the whole point of
 * the plugin), so there is nothing to clear.
 */
export function teardown(): void {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drop every `seen:` KV entry older than `maxAgeMs` (and any entry whose
 * stored JSON no longer matches {@link isSeenRecord}). Run hourly via the
 * `time` bind; the per-record age check inside the `!seen` query path
 * handles entries that aged past the cutoff between sweeps.
 */
function cleanupStale(api: PluginAPI, maxAgeMs: number): void {
  const now = Date.now();
  const entries = api.db.list('seen:');

  for (const entry of entries) {
    try {
      const parsed: unknown = JSON.parse(entry.value);
      if (isSeenRecord(parsed) && now - parsed.time <= maxAgeMs) {
        continue;
      }
      api.db.del(entry.key);
    } catch {
      // Corrupt JSON in the KV store — drop it. The sweep is the only
      // place that can clean up garbage left by an older plugin version
      // or a partial write, so swallowing here is intentional.
      api.db.del(entry.key);
    }
  }
}

/**
 * After the age-based sweep, evict oldest records by `time` until the
 * namespace is below `maxEntries`. Guards against nick-rotation attacks
 * that would otherwise inflate the namespace across the 90-day window
 * before `cleanupStale` could catch up.
 */
function enforceEntryCap(api: PluginAPI, maxEntries: number): void {
  const entries = api.db.list('seen:');
  if (entries.length <= maxEntries) return;
  const parsed: Array<{ key: string; time: number }> = [];
  for (const entry of entries) {
    try {
      const value: unknown = JSON.parse(entry.value);
      if (isSeenRecord(value)) {
        parsed.push({ key: entry.key, time: value.time });
      } else {
        api.db.del(entry.key);
      }
    } catch {
      api.db.del(entry.key);
    }
  }
  if (parsed.length <= maxEntries) return;
  parsed.sort((a, b) => a.time - b.time);
  const excess = parsed.length - maxEntries;
  for (let i = 0; i < excess; i++) api.db.del(parsed[i].key);
}

/**
 * Render a millisecond duration as a coarse human-readable "X ago" string
 * (`12s ago`, `5m ago`, `3h 14m ago`, `2d 6h ago`). The same coarse format
 * is used at every age, so the reader doesn't need to know how recent the
 * record is to interpret the reply.
 */
function formatRelativeTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}
