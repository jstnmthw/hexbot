import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext, CommandEntry } from '../../../src/command-handler';
import { CMD_EXEC_TIMEOUT_MS, executeCmdFrame } from '../../../src/core/botlink/cmd-exec';
import type { CommandRelay, LinkFrame, LinkPermissions } from '../../../src/core/botlink/types';

function makeEntry(): CommandEntry {
  return {
    name: 'status',
    options: { flags: '', description: '', usage: '', category: 'core' },
    handler: () => {},
  };
}

function makeRelay(execute: CommandRelay['execute']): CommandRelay {
  return {
    execute,
    getCommand: () => makeEntry(),
    setPreExecuteHook: () => {},
  };
}

const allowAll: LinkPermissions = {
  getUser: () => null,
  findByHostmask: () => null,
  checkFlagsByHandle: () => true,
};

function makeFrame(): LinkFrame {
  return { type: 'CMD', fromHandle: 'alice', ref: '42', command: 'status', args: '' };
}

describe('executeCmdFrame deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends exactly one timed-out result for a never-settling handler, and a late settle sends nothing more', async () => {
    let settleLate!: () => void;
    const relay = makeRelay(
      () =>
        new Promise<void>((resolve) => {
          settleLate = resolve;
        }),
    );
    const results: Array<[string, string[]]> = [];

    executeCmdFrame(makeFrame(), relay, allowAll, (ref, output) => {
      results.push([ref, output]);
    });

    // Just before the deadline: nothing sent yet.
    await vi.advanceTimersByTimeAsync(CMD_EXEC_TIMEOUT_MS - 1);
    expect(results).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(results).toEqual([['42', ['Command timed out.']]]);

    // A handler settling after the deadline must be a no-op, not a second
    // CMD_RESULT.
    settleLate();
    await vi.advanceTimersByTimeAsync(1000);
    expect(results).toHaveLength(1);
  });

  it('sends the normal result for a fast handler and clears the deadline timer', async () => {
    const relay = makeRelay(async (_cmd, ctx: CommandContext) => {
      ctx.reply('all good');
    });
    const results: Array<[string, string[]]> = [];

    executeCmdFrame(makeFrame(), relay, allowAll, (ref, output) => {
      results.push([ref, output]);
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([['42', ['all good']]]);

    // The deadline timer must be cleared when the handler settles first —
    // no pending timer left behind, and no second (timed-out) result.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(CMD_EXEC_TIMEOUT_MS * 2);
    expect(results).toHaveLength(1);
  });

  it('sends the error result exactly once for a throwing handler', async () => {
    const relay = makeRelay(async () => {
      throw new Error('boom');
    });
    const results: Array<[string, string[]]> = [];

    executeCmdFrame(makeFrame(), relay, allowAll, (ref, output) => {
      results.push([ref, output]);
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([['42', ['Error: boom']]]);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(CMD_EXEC_TIMEOUT_MS * 2);
    expect(results).toHaveLength(1);
  });
});
