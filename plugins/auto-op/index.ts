// auto-op — Automatically op/voice users based on their permission flags.
// User joins → bot checks hostmask → optionally verifies via NickServ → applies modes.

import type { PluginAPI, HandlerContext } from '../../src/types.js';

export const name = 'auto-op';
export const version = '1.0.0';
export const description = 'Auto-op/voice users on join based on permission flags';

let api: PluginAPI;

export function init(pluginApi: PluginAPI): void {
  api = pluginApi;

  const opFlags = (api.config.op_flags as string[] | undefined) ?? ['n', 'm', 'o'];
  const voiceFlags = (api.config.voice_flags as string[] | undefined) ?? ['v'];
  const notifyOnFail = (api.config.notify_on_fail as boolean | undefined) ?? false;

  api.bind('join', '-', '*', async (ctx: HandlerContext) => {
    const { nick, ident, hostname, channel } = ctx;

    if (!channel) return;

    // Don't op/voice the bot itself
    const botNick = (api.botConfig as Record<string, unknown>).irc as Record<string, unknown> | undefined;
    const configuredNick = botNick?.nick as string | undefined;
    if (configuredNick && nick.toLowerCase() === configuredNick.toLowerCase()) return;

    // Build full hostmask and look up in permissions
    const fullHostmask = `${nick}!${ident}@${hostname}`;
    const user = api.permissions.findByHostmask(fullHostmask);
    if (!user) return; // Unknown user — do nothing

    // Determine what flags this user has for this channel
    const globalFlags = user.global;
    const channelFlags = user.channels[channel] ?? '';
    const allFlags = globalFlags + channelFlags;

    // Check if user should get ops
    const shouldOp = opFlags.some((f) => allFlags.includes(f));
    // Check if user should get voice (only if not being opped)
    const shouldVoice = !shouldOp && voiceFlags.some((f) => allFlags.includes(f));

    if (!shouldOp && !shouldVoice) return;

    // Check if NickServ verification is required
    const identityConfig = (api.botConfig as Record<string, unknown>).identity as Record<string, unknown> | undefined;
    const requireAccFor = (identityConfig?.require_acc_for as string[] | undefined) ?? [];

    // Determine if this specific action requires ACC verification
    const flagToApply = shouldOp ? '+o' : '+v';
    const needsVerification = requireAccFor.includes(flagToApply) && api.services.isAvailable();

    if (needsVerification) {
      api.log(`Verifying ${nick} via NickServ before applying ${flagToApply} in ${channel}`);

      const result = await api.services.verifyUser(nick);

      if (!result.verified) {
        api.log(`Verification failed for ${nick} in ${channel} — not applying ${flagToApply}`);
        if (notifyOnFail) {
          api.notice(nick, `Auto-op: NickServ verification failed. Please identify and rejoin.`);
        }
        return;
      }

      api.log(`Verified ${nick} (account: ${result.account}) — applying ${flagToApply} in ${channel}`);
    }

    // Apply the mode
    if (shouldOp) {
      api.op(channel, nick);
      api.log(`Opped ${nick} in ${channel}`);
    } else if (shouldVoice) {
      api.voice(channel, nick);
      api.log(`Voiced ${nick} in ${channel}`);
    }
  });

  api.log('Loaded');
}

export function teardown(): void {
  // Binds are auto-removed by the loader
}
