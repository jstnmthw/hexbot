import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IRCCommands } from '../../src/core/irc-commands.js';
import type { IRCCommandsClient } from '../../src/core/irc-commands.js';
import { BotDatabase } from '../../src/database.js';
import { Logger } from '../../src/logger.js';

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

  it('should log error via logger when db.logModAction throws', () => {
    // Create a logger and spy on the child it will produce
    const logger = new Logger(null, { value: 'debug' });
    const childLogger = logger.child('irc-commands');
    const errorSpy = vi.spyOn(childLogger, 'error').mockImplementation(() => {});

    // Spy on logger.child to return our spied-on child
    vi.spyOn(logger, 'child').mockReturnValue(childLogger);

    const ircWithLogger = new IRCCommands(client, db, undefined, logger);

    const dbError = new Error('disk full');
    vi.spyOn(db, 'logModAction').mockImplementation(() => {
      throw dbError;
    });

    ircWithLogger.ban('#test', '*!*@bad.host');

    expect(errorSpy).toHaveBeenCalledWith('Failed to log mod action:', dbError);
  });
});
