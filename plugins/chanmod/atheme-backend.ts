// chanmod — Atheme ChanServ ProtectionBackend implementation
import type { PluginAPI } from '../../src/types';
import { ChanServBackendBase } from './chanserv-backend-base';
import { getBotNick } from './helpers';
import { type BackendAccess, accessAtLeast } from './protection-backend';

/**
 * Atheme ChanServ backend.
 *
 * Maps the ProtectionBackend interface to Atheme-specific ChanServ commands.
 * Commands are gated on the per-channel access tier (set via `.chanset chanserv_access`
 * and optionally downgraded by `verifyAccess()`).
 *
 * Access tier → available commands:
 * - op:       OP, UNBAN, INVITE, GETKEY, AKICK
 * - superop:  + DEOP others, FLAGS mgmt, SET
 * - founder:  + RECOVER, CLEAR (requires +R flag)
 *
 * Most of the scaffolding lives in {@link ChanServBackendBase}; only the
 * pieces specific to Atheme's command syntax (RECOVER is native, CLEAR,
 * MODE -k for key removal) and FLAGS-based access probe live here.
 */
export class AthemeBackend extends ChanServBackendBase {
  readonly name = 'atheme';

  constructor(api: PluginAPI, chanservNick: string) {
    super(api, chanservNick);
  }

  // ---------------------------------------------------------------------------
  // Action requests
  // ---------------------------------------------------------------------------

  requestRecover(channel: string): void {
    this.sendChanServ(`RECOVER ${channel}`);
    // Mark for post-RECOVER cleanup (+i +m removal) via the callback
    this.onRecoverCallback?.(channel);
  }

  /** Callback invoked when RECOVER is sent — used to schedule +i +m cleanup. */
  onRecoverCallback?: (channel: string) => void;

  requestClearBans(channel: string): void {
    this.sendChanServ(`CLEAR ${channel} BANS`);
  }

  requestRemoveKey(channel: string): void {
    // Atheme: SET #channel KEYDEL removes the key. MODE -k also works at op+.
    this.sendChanServ(`MODE ${channel} -k`);
  }

  // ---------------------------------------------------------------------------
  // Verify access
  // ---------------------------------------------------------------------------

  /**
   * Send a FLAGS probe to verify the bot's actual access level.
   *
   * Sends: `FLAGS #channel <bot_nick>`
   * Atheme responds with a NOTICE containing the flag string (e.g. "+AOehiortv").
   * We parse the response and downgrade the configured tier if it exceeds actual flags.
   *
   * The response listener is one-shot — it removes itself after the first match.
   */
  verifyAccess(channel: string): void {
    const botNick = getBotNick(this.api);
    this.sendChanServ(`FLAGS ${channel} ${botNick}`);
    this.api.log(`Atheme: verifying access for ${channel} via FLAGS probe`);
  }

  /**
   * Parse a ChanServ FLAGS response and update the access level.
   *
   * Expected format (Atheme NOTICE):
   *   "2 <nick> <flags>" (e.g. "2 hexbot +AOehiortv")
   * or error format for no access:
   *   "<nick> was not found..." or "No such entry"
   *
   * Called externally by the notice handler wired in the plugin init.
   */
  handleFlagsResponse(channel: string, flagString: string): void {
    const actual = this.flagsToTier(flagString);
    const configured = this.getAccess(channel);

    if (configured === 'none') {
      // Auto-detect: if we have real flags, set the access level automatically
      if (actual !== 'none') {
        const key = this.api.ircLower(channel);
        this.accessLevels.set(key, actual);
        this.autoDetectedChannels.add(key);
        this.api.log(
          `Atheme: auto-detected access for ${channel} — flags '${flagString}' (tier: '${actual}')`,
        );
      }
      return;
    }

    if (!accessAtLeast(actual, configured)) {
      this.api.warn(
        `Atheme: configured access '${configured}' for ${channel} exceeds actual flags '${flagString}' (effective: '${actual}') — downgrading`,
      );
      this.setAccess(channel, actual);
    } else {
      this.api.log(
        `Atheme: access verified for ${channel} — flags '${flagString}' (tier: '${actual}')`,
      );
    }
  }

  /**
   * Map an Atheme flag string to an access tier.
   *
   * +R +F → founder
   * +a +f +s (SOP-level flags without +R) → superop
   * +o → op
   * anything else → none
   */
  flagsToTier(flagString: string): BackendAccess {
    if (!flagString || flagString === '(none)') return 'none';
    const flags = flagString.replace(/[^a-zA-Z]/g, '');
    if (flags.includes('R') || flags.includes('F')) return 'founder';
    if (flags.includes('f') || flags.includes('s') || flags.includes('a')) return 'superop';
    if (flags.includes('o')) return 'op';
    return 'none';
  }
}
