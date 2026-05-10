// topic — IRC topic creator with color-coded themes + topic protection
// Sets channel topics using pre-built color theme borders.
// Also provides !topic lock / !topic unlock for topic protection.
import type { PluginAPI } from '../../src/types';
import { themeNames, themes } from './themes';

export const name = 'topic';
export const version = '2.1.0';
export const description =
  'Set channel topics with color-coded theme borders; optional topic protection via lock/unlock';

const PREVIEW_COOLDOWN_MS = 60_000;

// Conservative ceiling for topic length warnings. RFC 2812's 512-byte line cap
// minus the per-server `:nick!user@host TOPIC #channel :` framing and CRLF
// leaves ~390 usable bytes for the topic on most ircds. Honored only when
// the server doesn't advertise a more authoritative `TOPICLEN` via ISUPPORT.
const TOPIC_LENGTH_WARN_DEFAULT = 390;

/**
 * Resolve the topic length limit for `channel`. Honors the server's
 * ISUPPORT `TOPICLEN` value when present (some IRCds advertise 307, others
 * 500+) and falls back to the conservative {@link TOPIC_LENGTH_WARN_DEFAULT}
 * byte count when the capability is missing. The returned figure is
 * expressed in bytes — the topic-length comparison must be done with
 * `Buffer.byteLength(str, 'utf8')`, not `str.length`, so multi-byte code
 * points aren't silently over-permitted against a byte-counted server cap.
 */
function resolveTopicLenBytes(api: PluginAPI): number {
  const supports = api.getServerSupports();
  const raw = supports.TOPICLEN;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return TOPIC_LENGTH_WARN_DEFAULT;
}

/**
 * Plugin entry point. Registers per-channel topic-protection settings
 * (`topic_lock`, `topic_text`), the `!topic` / `!topics` op-only commands,
 * and a `topic` bind that re-enforces the locked text whenever the server
 * announces a topic change.
 */
export function init(api: PluginAPI): void {
  // `previewCooldown` lives inside `init()` as a const so a plugin
  // reload can't leak the old Map into bind closures that still reference
  // the prior module.
  const previewCooldown = new Map<string, number>();

  // Register per-channel settings for topic protection
  api.channelSettings.register([
    {
      key: 'topic_lock',
      type: 'flag',
      default: false,
      description: 'Restore topic if changed; use !topic unlock (+o) to allow changes',
    },
    {
      key: 'topic_text',
      type: 'string',
      default: '',
      description: 'The enforced topic text (set by !topic lock)',
    },
  ]);

  api.registerHelp([
    {
      command: '!topic',
      flags: 'o',
      usage: '!topic <theme> <text>',
      description: 'Set the channel topic with a color-coded theme',
      category: 'topic',
    },
    {
      command: '!topic preview',
      flags: 'o',
      usage: '!topic preview <theme> <text>',
      description: 'Preview a themed topic in channel without setting it',
      category: 'topic',
    },
    {
      command: '!topic lock',
      flags: 'o',
      usage: '!topic lock',
      description: 'Lock the current channel topic — restores it if changed by a non-op',
      category: 'topic',
    },
    {
      command: '!topic unlock',
      flags: 'o',
      usage: '!topic unlock',
      description: 'Disable topic protection',
      category: 'topic',
    },
    {
      command: '!topics',
      flags: 'o',
      usage: '!topics [preview [text]]',
      description: 'List available topic themes; preview renders all themes',
      category: 'topic',
    },
  ]);

  // !topic <theme> <text>            — set the channel topic (requires o flag)
  // !topic lock                      — lock the current live topic
  // !topic unlock                    — disable topic protection
  // !topic preview <theme> <text>    — preview the themed text in channel
  api.bind('pub', '+o', '!topic', (ctx) => {
    const args = ctx.args.trim();
    if (!args) {
      api.notice(
        ctx.nick,
        'Usage: !topic <theme> <text> | !topic lock | !topic unlock | !topic preview <theme> <text>',
      );
      return;
    }

    const parts = args.split(/\s+/);
    const firstArg = parts[0].toLowerCase();

    // Handle lock subcommand
    if (firstArg === 'lock') {
      const live = api.getChannel(ctx.channel)?.topic ?? '';
      if (!live) {
        api.notice(ctx.nick, 'Cannot lock: no topic is currently set.');
        return;
      }
      const topicLenBytes = resolveTopicLenBytes(api);
      const liveBytes = Buffer.byteLength(live, 'utf8');
      if (liveBytes > topicLenBytes) {
        api.notice(
          ctx.nick,
          `Warning: topic is ${liveBytes} bytes (server limit is ~${topicLenBytes}). It may be truncated by the server.`,
        );
      }
      api.channelSettings.set(ctx.channel, 'topic_text', live);
      api.channelSettings.set(ctx.channel, 'topic_lock', true);
      api.notice(ctx.nick, 'Topic locked.');
      // The factory forces by=pluginId; record the operator nick + the
      // locked text in metadata so audit queries can attribute the lock.
      api.audit.log('topic-lock', {
        channel: ctx.channel,
        reason: live,
        metadata: { lockedBy: ctx.nick },
      });
      return;
    }

    // Handle unlock subcommand
    if (firstArg === 'unlock') {
      api.channelSettings.set(ctx.channel, 'topic_lock', false);
      api.channelSettings.set(ctx.channel, 'topic_text', '');
      api.notice(ctx.nick, 'Topic protection disabled.');
      api.audit.log('topic-unlock', {
        channel: ctx.channel,
        metadata: { unlockedBy: ctx.nick },
      });
      return;
    }

    // Handle preview subcommand
    if (firstArg === 'preview') {
      if (parts.length < 3) {
        api.notice(ctx.nick, 'Usage: !topic preview <theme> <text>');
        return;
      }
      const themeName = parts[1].toLowerCase();
      const text = parts.slice(2).join(' ');

      const template = themes[themeName];
      if (!template) {
        api.notice(ctx.nick, `Unknown theme "${parts[1]}". Use !topics to see available themes.`);
        return;
      }

      // Strip IRC control codes from user-supplied text before
      // interpolating into the theme template. Although irc-bridge already
      // scrubs `\r\n\0`, mIRC color/bold codes pass through and would let a
      // `+o` caller sneak color into a topic template that didn't include
      // any. Strip them uniformly here.
      const formatted = template.replace('$text', () => api.stripFormatting(text));
      api.notice(ctx.nick, formatted);
      return;
    }

    // Normal topic set: !topic <theme> <text>
    const themeName = firstArg;
    if (parts.length < 2) {
      api.notice(ctx.nick, 'Usage: !topic <theme> <text>');
      return;
    }
    const text = parts.slice(1).join(' ');

    const template = themes[themeName];
    if (!template) {
      api.notice(ctx.nick, `Unknown theme "${parts[0]}". Use !topics to see available themes.`);
      return;
    }

    // Strip IRC control codes from user-supplied text before
    // interpolating into the theme template. Although irc-bridge already
    // scrubs `\r\n\0`, mIRC color/bold codes pass through and would let a
    // `+o` caller sneak color into a topic template that didn't include
    // any. Strip them uniformly here.
    const formatted = template.replace('$text', () => api.stripFormatting(text));

    const topicLenBytes = resolveTopicLenBytes(api);
    const formattedBytes = Buffer.byteLength(formatted, 'utf8');
    if (formattedBytes > topicLenBytes) {
      api.notice(
        ctx.nick,
        `Warning: topic is ${formattedBytes} bytes (server limit is ~${topicLenBytes}). It may be truncated by the server.`,
      );
    }

    api.topic(ctx.channel, formatted);
    api.notice(ctx.nick, `Topic set using theme "${themeName}".`);
  });

  // !topics — list available themes (requires +o, same as !topic)
  // !topics preview [text] — PM all themes rendered with sample text
  api.bind('pub', '+o', '!topics', (ctx) => {
    const args = ctx.args.trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase();

    if (subcommand === 'preview') {
      const cooldownKey = api.ircLower(ctx.nick);
      const cooldownExpires = previewCooldown.get(cooldownKey) ?? 0;
      if (Date.now() < cooldownExpires) {
        const secsLeft = Math.ceil((cooldownExpires - Date.now()) / 1000);
        api.notice(ctx.nick, `Preview cooldown active — try again in ${secsLeft}s.`);
        return;
      }
      const nowMs = Date.now();
      // Sweep on every invocation. Gated by `+o` flag so volume is
      // negligible; the prior `size > 1000` threshold left expired
      // entries lingering indefinitely below the bar.
      for (const [k, expires] of previewCooldown) {
        if (expires <= nowMs) previewCooldown.delete(k);
      }
      previewCooldown.set(cooldownKey, nowMs + PREVIEW_COOLDOWN_MS);

      const sampleText = parts.length > 1 ? parts.slice(1).join(' ') : 'Sample Topic Text';
      api.notice(ctx.nick, `Theme previews using: "${sampleText}"`);
      for (const themeName of themeNames) {
        // Function form of replace() — string-form replacements interpret
        // `$&`, `$1`, `$$`, etc. in `sampleText` as back-references, which
        // would let a caller leak adjacent template text into the preview.
        // Using a function bypasses back-ref expansion entirely.
        const formatted = themes[themeName].replace('$text', () => sampleText);
        api.notice(ctx.nick, `${themeName}: ${formatted}`);
      }
      api.notice(ctx.nick, `${themeNames.length} themes total. Use !topic <theme> <text> to set.`);
      return;
    }

    api.notice(
      ctx.nick,
      `Available themes: ${themeNames.join(', ')} — Use "!topics preview [text]" to preview all.`,
    );
  });

  // topic bind — enforce topic protection on unauthorized changes
  api.bind('topic', '-', '*', (ctx) => {
    const { channel } = ctx;

    const protect = api.channelSettings.getFlag(channel, 'topic_lock');
    if (!protect) return;

    const enforced = api.channelSettings.getString(channel, 'topic_text');
    if (!enforced) return; // no lock set
    // Reentrancy guard: when this handler restores the topic via
    // api.topic() below, the server echoes a TOPIC event back to us.
    // Returning early on a match prevents an infinite restore loop.
    if (ctx.text === enforced) return;

    const isAuthorized = api.permissions.checkFlags('o', ctx);
    if (isAuthorized) {
      // Authorized change — update the stored topic
      api.channelSettings.set(channel, 'topic_text', ctx.text);
      return;
    }

    // Skip restore when the bot lacks `+o` on the channel — TOPIC needs
    // ops on most ircds (or `+t` cleared, which on a locked channel
    // implies elevated threat), and attempting the mode burns a slot in
    // the outbound message queue on every unauthorized change. Without
    // this guard a takeover scenario (bot deopped, topic rewritten
    // repeatedly) would saturate the queue.
    const ch = api.getChannel(channel);
    const botNickLower = api.ircLower(api.botConfig.irc.nick);
    const botUser = ch?.users.get(botNickLower);
    const botHasOps = botUser?.modes.includes('o') ?? false;
    if (!botHasOps) return;

    // Restore the enforced topic
    api.topic(channel, enforced);
  });
}

// Binds are auto-cleaned by the plugin loader and `previewCooldown` now
// lives inside `init()` so teardown has nothing to do — the GC drops the
// old module's closure graph once nothing references it.
export function teardown(): void {}
