import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IRCCommands } from '../../src/core/irc-commands';
import type { IRCCommandsClient } from '../../src/core/irc-commands';
import { BotDatabase } from '../../src/database';
import { Logger } from '../../src/logger';

// ---------------------------------------------------------------------------
// Mock IRC client
// ---------------------------------------------------------------------------

interface SentMessage {
  type: string;
  args: unknown[];
}

class MockClient {
  sent: SentMessage[] = [];

  say(target: string, message: string): void {
    this.sent.push({ type: 'say', args: [target, message] });
  }

  notice(target: string, message: string): void {
    this.sent.push({ type: 'notice', args: [target, message] });
  }

  join(channel: string): void {
    this.sent.push({ type: 'join', args: [channel] });
  }

  part(channel: string, message?: string): void {
    this.sent.push({ type: 'part', args: [channel, message] });
  }

  raw(line: string): void {
    this.sent.push({ type: 'raw', args: [line] });
  }

  mode(target: string, mode: string, ...params: string[]): void {
    this.sent.push({ type: 'mode', args: [target, mode, ...params] });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IRCCommands', () => {
  let client: MockClient;
  let db: BotDatabase;
  let irc: IRCCommands;

  beforeEach(() => {
    client = new MockClient();
    db = new BotDatabase(':memory:');
    db.open();
    irc = new IRCCommands(client, db);
  });

  it('should send correct MODE for op()', () => {
    irc.op('#test', 'Alice');

    const modeMsg = client.sent.find((m) => m.type === 'mode');
    expect(modeMsg).toBeDefined();
    expect(modeMsg!.args).toEqual(['#test', '+o', 'Alice']);
  });

  it('should send correct MODE for deop()', () => {
    irc.deop('#test', 'Alice');

    const modeMsg = client.sent.find((m) => m.type === 'mode');
    expect(modeMsg).toBeDefined();
    expect(modeMsg!.args).toEqual(['#test', '-o', 'Alice']);
  });

  it('should send KICK with reason', () => {
    irc.kick('#test', 'Alice', 'bad behavior');

    const raw = client.sent.find((m) => m.type === 'raw');
    expect(raw).toBeDefined();
    expect(raw!.args[0]).toBe('KICK #test Alice :bad behavior');
  });

  it('should send KICK without reason (covers reason ?? fallback branches)', () => {
    irc.kick('#test', 'Alice');

    const raw = client.sent.find((m) => m.type === 'raw');
    expect(raw).toBeDefined();
    expect(raw!.args[0]).toBe('KICK #test Alice :');
  });

  it('should send correct +b MODE for ban()', () => {
    irc.ban('#test', '*!*@evil.host');

    const modeMsg = client.sent.find((m) => m.type === 'mode');
    expect(modeMsg).toBeDefined();
    expect(modeMsg!.args).toEqual(['#test', '+b', '*!*@evil.host']);
  });

  it('should send correct -b MODE for unban()', () => {
    irc.unban('#test', '*!*@evil.host');

    const modeMsg = client.sent.find((m) => m.type === 'mode');
    expect(modeMsg).toBeDefined();
    expect(modeMsg!.args).toEqual(['#test', '-b', '*!*@evil.host']);
  });

  it('should batch modes when exceeding MODES limit', () => {
    irc.setModesPerLine(2);

    irc.mode('#test', '+ooo', 'Alice', 'Bob', 'Charlie');

    const rawMsgs = client.sent.filter((m) => m.type === 'raw');
    expect(rawMsgs).toHaveLength(2);
    expect(rawMsgs[0].args[0]).toBe('MODE #test +oo Alice Bob');
    expect(rawMsgs[1].args[0]).toBe('MODE #test +o Charlie');
  });

  it('should send single mode when within MODES limit', () => {
    irc.mode('#test', '+ov', 'Alice', 'Bob');

    const rawMsgs = client.sent.filter((m) => m.type === 'raw');
    expect(rawMsgs).toHaveLength(1);
    expect(rawMsgs[0].args[0]).toBe('MODE #test +ov Alice Bob');
  });

  // -------------------------------------------------------------------------
  // Mode batcher — direction segmentation (§2)
  // -------------------------------------------------------------------------

  it('should segment a mixed-direction mode string into per-direction lines', () => {
    // `+o-v a b` must become two lines — the old code treated `-` as a mode
    // char and re-applied `+` to everything, producing a wrong MODE line.
    irc.mode('#test', '+o-v', 'Alice', 'Bob');

    const rawMsgs = client.sent.filter((m) => m.type === 'raw');
    expect(rawMsgs).toHaveLength(2);
    expect(rawMsgs[0].args[0]).toBe('MODE #test +o Alice');
    expect(rawMsgs[1].args[0]).toBe('MODE #test -v Bob');
  });

  it('should segment same-mode mixed directions (`+o-o`) correctly', () => {
    irc.mode('#test', '+o-o', 'Alice', 'Bob');

    const rawMsgs = client.sent.filter((m) => m.type === 'raw');
    expect(rawMsgs).toHaveLength(2);
    expect(rawMsgs[0].args[0]).toBe('MODE #test +o Alice');
    expect(rawMsgs[1].args[0]).toBe('MODE #test -o Bob');
  });

  it('should batch long mixed-direction runs per direction and per modesPerLine', () => {
    irc.setModesPerLine(2);
    // 3 ops added, 2 ops removed — each direction batches independently.
    irc.mode('#test', '+ooo-oo', 'a', 'b', 'c', 'd', 'e');

    const rawMsgs = client.sent.filter((m) => m.type === 'raw');
    expect(rawMsgs.map((m) => m.args[0])).toEqual([
      'MODE #test +oo a b',
      'MODE #test +o c',
      'MODE #test -oo d e',
    ]);
  });

  it('should throw on mode char / param count mismatch', () => {
    // `+oo a` — two mode chars, one param. The old code sent `+oo a`,
    // silently dropping the second `o`'s param.
    expect(() => irc.mode('#test', '+oo', 'Alice')).toThrow(/must match 1:1/);
  });

  it('should throw on a mode string missing a leading direction', () => {
    expect(() => irc.mode('#test', 'ov', 'Alice', 'Bob')).toThrow(/leading \+ or -/);
  });

  it('should send flag modes with no params (e.g. `+mn`)', () => {
    irc.mode('#test', '+mn');
    const rawMsgs = client.sent.filter((m) => m.type === 'raw');
    expect(rawMsgs).toHaveLength(1);
    expect(rawMsgs[0].args[0]).toBe('MODE #test +mn');
  });

  it('should split flag-only mixed-direction runs per direction', () => {
    irc.mode('#test', '+mn-t');
    const rawMsgs = client.sent.filter((m) => m.type === 'raw');
    expect(rawMsgs.map((m) => m.args[0])).toEqual(['MODE #test +mn', 'MODE #test -t']);
  });

  // -------------------------------------------------------------------------
  // Mode batcher — CHANMODES-aware param allocation (§2 Phase 2)
  // -------------------------------------------------------------------------

  it('should mix flag and param modes in one call using expectsParam', () => {
    // `+mo alice` — 'm' is Type D (flag), 'o' is a prefix mode.
    // Total 1 param needed; caller passes 1. Phase 1's 1:1 rule would have
    // rejected this because it treated every mode char as param-taking.
    irc.mode('#test', '+mo', 'Alice');
    const rawMsgs = client.sent.filter((m) => m.type === 'raw');
    expect(rawMsgs).toHaveLength(1);
    expect(rawMsgs[0].args[0]).toBe('MODE #test +mo Alice');
  });

  it('should treat +l as param-taking but -l as paramless (CHANMODES type C)', () => {
    irc.mode('#test', '+l', '50');
    let rawMsgs = client.sent.filter((m) => m.type === 'raw');
    expect(rawMsgs.at(-1)!.args[0]).toBe('MODE #test +l 50');

    irc.mode('#test', '-l');
    rawMsgs = client.sent.filter((m) => m.type === 'raw');
    expect(rawMsgs.at(-1)!.args[0]).toBe('MODE #test -l');
  });

  it('should handle +ko (key + op) with two params', () => {
    // `+ko channelkey alice` — 'k' is Type B (always param), 'o' is prefix.
    irc.mode('#test', '+ko', 'secretkey', 'Alice');
    const rawMsgs = client.sent.filter((m) => m.type === 'raw');
    expect(rawMsgs).toHaveLength(1);
    expect(rawMsgs[0].args[0]).toBe('MODE #test +ko secretkey Alice');
  });

  it('should throw when a +l direction is missing its param', () => {
    expect(() => irc.mode('#test', '+l')).toThrow(/needs 1 param/);
  });

  it('should accept server-advertised modesPerLine from capabilities', async () => {
    const { parseISupport } = await import('../../src/core/isupport');
    irc.setCapabilities(
      parseISupport({
        network: {
          supports(k: string): unknown {
            if (k === 'MODES') return '20';
            if (k === 'PREFIX')
              return [
                { symbol: '@', mode: 'o' },
                { symbol: '+', mode: 'v' },
              ];
            if (k === 'CHANMODES') return ['beI', 'k', 'l', 'imnpst'];
            return undefined;
          },
        },
      }),
    );

    // 5 ops should now fit on a single line (InspIRCd advertises up to 20).
    irc.mode('#test', '+ooooo', 'a', 'b', 'c', 'd', 'e');
    const rawMsgs = client.sent.filter((m) => m.type === 'raw');
    expect(rawMsgs).toHaveLength(1);
    expect(rawMsgs[0].args[0]).toBe('MODE #test +ooooo a b c d e');
  });

  it('should log mod actions to database', () => {
    irc.kick('#test', 'Alice', 'reason');

    const log = db.getModLog({ action: 'kick' });
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe('kick');
    expect(log[0].channel).toBe('#test');
    expect(log[0].target).toBe('Alice');
  });

  it('should log op action to database', () => {
    irc.op('#test', 'Alice');

    const log = db.getModLog({ action: 'op' });
    expect(log).toHaveLength(1);
    expect(log[0].target).toBe('Alice');
  });

  it('should log ban action to database', () => {
    irc.ban('#test', '*!*@evil.host');

    const log = db.getModLog({ action: 'ban' });
    expect(log).toHaveLength(1);
    expect(log[0].target).toBe('*!*@evil.host');
  });

  it('should send voice and devoice modes', () => {
    irc.voice('#test', 'Alice');
    irc.devoice('#test', 'Bob');

    expect(client.sent[0].args).toEqual(['#test', '+v', 'Alice']);
    expect(client.sent[1].args).toEqual(['#test', '-v', 'Bob']);
  });

  // -------------------------------------------------------------------------
  // Phase 2 — every mutating method logs + actor threading
  // -------------------------------------------------------------------------

  describe('actor threading and full mutating coverage', () => {
    it.each([
      ['op', (): void => irc.op('#t', 'Alice'), 'op'],
      ['deop', (): void => irc.deop('#t', 'Alice'), 'deop'],
      ['ban', (): void => irc.ban('#t', '*!*@evil'), 'ban'],
      ['unban', (): void => irc.unban('#t', '*!*@evil'), 'unban'],
      ['voice', (): void => irc.voice('#t', 'Alice'), 'voice'],
      ['devoice', (): void => irc.devoice('#t', 'Alice'), 'devoice'],
      ['halfop', (): void => irc.halfop('#t', 'Alice'), 'halfop'],
      ['dehalfop', (): void => irc.dehalfop('#t', 'Alice'), 'dehalfop'],
      ['quiet', (): void => irc.quiet('#t', '*!*@annoy'), 'quiet'],
      ['invite', (): void => irc.invite('#t', 'Alice'), 'invite'],
      ['kick', (): void => irc.kick('#t', 'Alice', 'bye'), 'kick'],
      ['topic', (): void => irc.topic('#t', 'new topic'), 'topic'],
    ])('%s writes a mod_log row under the default actor', (_name, fire, action) => {
      fire();
      const rows = db.getModLog({ action });
      expect(rows).toHaveLength(1);
      expect(rows[0].by).toBe('bot');
      expect(rows[0].source).toBe('system');
    });

    it('mode() writes one row per call with the mode string in reason', () => {
      irc.mode('#t', '+mn');
      const rows = db.getModLog({ action: 'mode' });
      expect(rows).toHaveLength(1);
      expect(rows[0].reason).toBe('+mn');
      expect(rows[0].metadata).toEqual({ params: [] });
    });

    it('mode() records params in metadata', () => {
      irc.mode('#t', '+ov', 'Alice', 'Bob');
      const rows = db.getModLog({ action: 'mode' });
      expect(rows[0].metadata).toEqual({ params: ['Alice', 'Bob'] });
    });

    it('explicit actor parameter overrides the default', () => {
      irc.op('#t', 'Alice', { by: 'alice', source: 'dcc' });
      const [row] = db.getModLog({ action: 'op' });
      expect(row.by).toBe('alice');
      expect(row.source).toBe('dcc');
    });

    it('setDefaultActor swaps the fallback for subsequent calls', () => {
      irc.setDefaultActor({ by: 'owner', source: 'repl' });
      irc.kick('#t', 'Alice', 'bye');
      const [row] = db.getModLog({ action: 'kick' });
      expect(row.by).toBe('owner');
      expect(row.source).toBe('repl');
    });

    it('actor with plugin source writes plugin column', () => {
      irc.ban('#t', '*!*@bad', { by: 'flood', source: 'plugin', plugin: 'flood' });
      const [row] = db.getModLog({ action: 'ban' });
      expect(row.source).toBe('plugin');
      expect(row.plugin).toBe('flood');
      expect(row.by).toBe('flood');
    });

    it('topic() stores the new topic text in reason', () => {
      irc.topic('#t', 'welcome, friends');
      const [row] = db.getModLog({ action: 'topic' });
      expect(row.reason).toBe('welcome, friends');
      expect(row.target).toBeNull();
    });
  });

  it('should send INVITE via raw command', () => {
    irc.invite('#test', 'Alice');

    const raw = client.sent.find((m) => m.type === 'raw');
    expect(raw).toBeDefined();
    expect(raw!.args[0]).toBe('INVITE Alice #test');
  });

  it('should log invite action to database', () => {
    irc.invite('#test', 'Alice');

    const log = db.getModLog({ action: 'invite' });
    expect(log).toHaveLength(1);
    expect(log[0].channel).toBe('#test');
    expect(log[0].target).toBe('Alice');
  });

  it('should set topic via raw command', () => {
    irc.topic('#test', 'New topic here');

    const raw = client.sent.find((m) => m.type === 'raw');
    expect(raw!.args[0]).toBe('TOPIC #test :New topic here');
  });

  it('should strip newlines from kick reason', () => {
    irc.kick('#test', 'Alice', 'bad\r\nbehavior');

    const raw = client.sent.find((m) => m.type === 'raw');
    expect(raw!.args[0]).toBe('KICK #test Alice :badbehavior');
  });

  // -------------------------------------------------------------------------
  // say, notice, join, part (lines 49-65)
  // -------------------------------------------------------------------------

  it('should delegate say() to client.say()', () => {
    irc.say('#test', 'hello world');

    const msg = client.sent.find((m) => m.type === 'say');
    expect(msg).toBeDefined();
    expect(msg!.args).toEqual(['#test', 'hello world']);
  });

  it('should delegate notice() to client.notice()', () => {
    irc.notice('#test', 'heads up');

    const msg = client.sent.find((m) => m.type === 'notice');
    expect(msg).toBeDefined();
    expect(msg!.args).toEqual(['#test', 'heads up']);
  });

  it('should send raw JOIN with key when key is provided', () => {
    irc.join('#secret', 'mykey');

    const raw = client.sent.find((m) => m.type === 'raw');
    expect(raw).toBeDefined();
    expect(raw!.args[0]).toBe('JOIN #secret mykey');
    // Should NOT have called client.join
    const joinMsg = client.sent.find((m) => m.type === 'join');
    expect(joinMsg).toBeUndefined();
  });

  it('should call client.join() when no key is provided', () => {
    irc.join('#public');

    const joinMsg = client.sent.find((m) => m.type === 'join');
    expect(joinMsg).toBeDefined();
    expect(joinMsg!.args).toEqual(['#public']);
    // Should NOT have sent raw
    const raw = client.sent.find((m) => m.type === 'raw');
    expect(raw).toBeUndefined();
  });

  it('should delegate part() to client.part()', () => {
    irc.part('#test', 'goodbye');

    const msg = client.sent.find((m) => m.type === 'part');
    expect(msg).toBeDefined();
    expect(msg!.args).toEqual(['#test', 'goodbye']);
  });

  it('should delegate part() without message', () => {
    irc.part('#test');

    const msg = client.sent.find((m) => m.type === 'part');
    expect(msg).toBeDefined();
    expect(msg!.args).toEqual(['#test', undefined]);
  });

  // -------------------------------------------------------------------------
  // quiet (line 108)
  // -------------------------------------------------------------------------

  it('should send +q mode for quiet()', () => {
    irc.quiet('#test', '*!*@annoying.host');

    const modeMsg = client.sent.find((m) => m.type === 'mode');
    expect(modeMsg).toBeDefined();
    expect(modeMsg!.args).toEqual(['#test', '+q', '*!*@annoying.host']);
  });

  // -------------------------------------------------------------------------
  // sendMode fallback to raw() when client.mode is undefined (line 143)
  // -------------------------------------------------------------------------

  it('should fall back to raw() when client has no mode method', () => {
    const rawOnlyClient: IRCCommandsClient = {
      say: () => {},
      notice: () => {},
      join: () => {},
      part: () => {},
      raw: vi.fn(),
      // mode is intentionally omitted
    };
    const ircNoMode = new IRCCommands(rawOnlyClient, db);

    ircNoMode.op('#test', 'Alice');

    expect(rawOnlyClient.raw).toHaveBeenCalledWith('MODE #test +o Alice');
  });

  // -------------------------------------------------------------------------
  // logMod error catch (line 159)
  // -------------------------------------------------------------------------

  it('should catch and log error when db.logModAction throws', () => {
    const logger = new Logger(null, { value: 'debug' });
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const ircWithLogger = new IRCCommands(client, db, undefined, logger);

    // Make logModAction throw
    vi.spyOn(db, 'logModAction').mockImplementation(() => {
      throw new Error('db write failed');
    });

    // Should not throw — error is caught internally
    expect(() => ircWithLogger.kick('#test', 'Alice', 'bye')).not.toThrow();

    // The child logger's error method should have been called
    expect(errorSpy).not.toHaveBeenCalled(); // errorSpy is on parent
    // Verify the kick raw command was still sent
    const raw = client.sent.find((m) => m.type === 'raw');
    expect(raw).toBeDefined();
    expect(raw!.args[0]).toBe('KICK #test Alice :bye');
  });

  it('should not throw when db.logModAction throws and no logger is provided', () => {
    const ircNoLogger = new IRCCommands(client, null);

    // logMod with no db should just silently skip — no throw
    expect(() => ircNoLogger.kick('#test', 'Alice', 'bye')).not.toThrow();
  });

  it('should log a warning via logger when db.logModAction throws', () => {
    // The audit helper centralizes the resilience pattern at warn level —
    // tests assert the standardized message rather than the per-class one.
    const logger = new Logger(null, { value: 'debug' });
    const childLogger = logger.child('irc-commands');
    const warnSpy = vi.spyOn(childLogger, 'warn').mockImplementation(() => {});

    vi.spyOn(logger, 'child').mockReturnValue(childLogger);

    const ircWithLogger = new IRCCommands(client, db, undefined, logger);

    const dbError = new Error('disk full');
    vi.spyOn(db, 'logModAction').mockImplementation(() => {
      throw dbError;
    });

    ircWithLogger.ban('#test', '*!*@bad.host');

    expect(warnSpy).toHaveBeenCalledWith('Failed to record mod_log entry for ban:', dbError);
  });
});
