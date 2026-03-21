import { describe, it, expect, beforeEach } from 'vitest';
import { IRCCommands } from '../../src/core/irc-commands.js';
import { BotDatabase } from '../../src/database.js';

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
});
