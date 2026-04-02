import { describe, expect, it } from 'vitest';

import { BanListSyncer, SharedBanList } from '../../src/core/botlink-sharing';

// ---------------------------------------------------------------------------
// SharedBanList
// ---------------------------------------------------------------------------

describe('SharedBanList', () => {
  it('adds and retrieves bans', () => {
    const list = new SharedBanList();
    list.addBan('#test', '*!*@evil.host', 'admin', 1000);
    expect(list.getBans('#test')).toEqual([{ mask: '*!*@evil.host', setBy: 'admin', setAt: 1000 }]);
  });

  it('deduplicates bans by mask', () => {
    const list = new SharedBanList();
    list.addBan('#test', '*!*@evil.host', 'admin', 1000);
    list.addBan('#test', '*!*@evil.host', 'admin', 2000);
    expect(list.getBans('#test')).toHaveLength(1);
  });

  it('removes a ban by mask', () => {
    const list = new SharedBanList();
    list.addBan('#test', '*!*@evil.host', 'admin', 1000);
    list.removeBan('#test', '*!*@evil.host');
    expect(list.getBans('#test')).toHaveLength(0);
  });

  it('syncBans replaces the entire list', () => {
    const list = new SharedBanList();
    list.addBan('#test', '*!*@old', 'admin', 1000);
    list.syncBans('#test', [{ mask: '*!*@new', setBy: 'admin', setAt: 2000 }]);
    expect(list.getBans('#test')).toEqual([{ mask: '*!*@new', setBy: 'admin', setAt: 2000 }]);
  });

  it('handles exempts separately from bans', () => {
    const list = new SharedBanList();
    list.addBan('#test', '*!*@evil', 'admin', 1000);
    list.addExempt('#test', '*!*@good', 'admin', 1000);
    expect(list.getBans('#test')).toHaveLength(1);
    expect(list.getExempts('#test')).toHaveLength(1);
  });

  it('removeBan on unknown channel is a no-op', () => {
    const list = new SharedBanList();
    list.removeBan('#nonexistent', '*!*@x'); // should not throw
    expect(list.getBans('#nonexistent')).toEqual([]);
  });

  it('removeBan with non-existent mask is a no-op', () => {
    const list = new SharedBanList();
    list.addBan('#test', '*!*@evil.host', 'admin', 1000);
    list.removeBan('#test', '*!*@does-not-exist');
    expect(list.getBans('#test')).toHaveLength(1);
  });

  it('removeExempt on unknown channel is a no-op', () => {
    const list = new SharedBanList();
    list.removeExempt('#nonexistent', '*!*@x'); // should not throw
    expect(list.getExempts('#nonexistent')).toEqual([]);
  });

  it('removeExempt with non-existent mask is a no-op', () => {
    const list = new SharedBanList();
    list.addExempt('#test', '*!*@good.host', 'admin', 1000);
    list.removeExempt('#test', '*!*@does-not-exist');
    expect(list.getExempts('#test')).toHaveLength(1);
  });

  it('deduplicates exempts by mask', () => {
    const list = new SharedBanList();
    list.addExempt('#test', '*!*@good', 'admin', 1000);
    list.addExempt('#test', '*!*@good', 'admin', 2000);
    expect(list.getExempts('#test')).toHaveLength(1);
  });

  it('returns empty array for unknown channel', () => {
    const list = new SharedBanList();
    expect(list.getBans('#none')).toEqual([]);
    expect(list.getExempts('#none')).toEqual([]);
  });

  it('getChannels returns all channels with data', () => {
    const list = new SharedBanList();
    list.addBan('#a', '*!*@x', 'a', 0);
    list.addExempt('#b', '*!*@y', 'a', 0);
    expect(list.getChannels().sort()).toEqual(['#a', '#b']);
  });
});

// ---------------------------------------------------------------------------
// BanListSyncer
// ---------------------------------------------------------------------------

describe('BanListSyncer', () => {
  const alwaysShared = () => true;
  const neverShared = () => false;

  describe('buildSyncFrames', () => {
    it('builds CHAN_BAN_SYNC frames for shared channels', () => {
      const list = new SharedBanList();
      list.addBan('#shared', '*!*@evil', 'admin', 1000);
      list.addBan('#private', '*!*@bad', 'admin', 1000);

      const isShared = (ch: string) => ch === '#shared';
      const frames = BanListSyncer.buildSyncFrames(list, isShared);

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe('CHAN_BAN_SYNC');
      expect(frames[0].channel).toBe('#shared');
    });

    it('includes exempt sync frames', () => {
      const list = new SharedBanList();
      list.addBan('#ch', '*!*@evil', 'a', 0);
      list.addExempt('#ch', '*!*@good', 'a', 0);

      const frames = BanListSyncer.buildSyncFrames(list, alwaysShared);
      expect(frames).toHaveLength(2);
      expect(frames.map((f) => f.type).sort()).toEqual(['CHAN_BAN_SYNC', 'CHAN_EXEMPT_SYNC']);
    });

    it('returns empty array when no shared channels', () => {
      const list = new SharedBanList();
      list.addBan('#ch', '*!*@evil', 'a', 0);
      expect(BanListSyncer.buildSyncFrames(list, neverShared)).toEqual([]);
    });

    it('skips empty ban list for channels with only exempts', () => {
      const list = new SharedBanList();
      list.addExempt('#ch', '*!*@good', 'a', 0);

      const frames = BanListSyncer.buildSyncFrames(list, alwaysShared);
      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe('CHAN_EXEMPT_SYNC');
    });
  });

  describe('applyFrame', () => {
    it('applies CHAN_BAN_SYNC to replace ban list', () => {
      const list = new SharedBanList();
      list.addBan('#ch', '*!*@old', 'a', 0);

      BanListSyncer.applyFrame(
        {
          type: 'CHAN_BAN_SYNC',
          channel: '#ch',
          bans: [{ mask: '*!*@new', setBy: 'b', setAt: 1000 }],
        },
        list,
        alwaysShared,
      );

      expect(list.getBans('#ch')).toEqual([{ mask: '*!*@new', setBy: 'b', setAt: 1000 }]);
    });

    it('applies CHAN_BAN_ADD', () => {
      const list = new SharedBanList();
      BanListSyncer.applyFrame(
        {
          type: 'CHAN_BAN_ADD',
          channel: '#ch',
          mask: '*!*@evil',
          setBy: 'a',
          setAt: 0,
          enforce: false,
        },
        list,
        alwaysShared,
      );
      expect(list.getBans('#ch')).toHaveLength(1);
    });

    it('returns enforce action when enforce: true', () => {
      const list = new SharedBanList();
      const result = BanListSyncer.applyFrame(
        {
          type: 'CHAN_BAN_ADD',
          channel: '#ch',
          mask: '*!*@evil',
          setBy: 'a',
          setAt: 0,
          enforce: true,
        },
        list,
        alwaysShared,
      );
      expect(result).toEqual({ action: 'enforce_ban', channel: '#ch', mask: '*!*@evil' });
    });

    it('applies CHAN_BAN_DEL', () => {
      const list = new SharedBanList();
      list.addBan('#ch', '*!*@evil', 'a', 0);
      BanListSyncer.applyFrame(
        { type: 'CHAN_BAN_DEL', channel: '#ch', mask: '*!*@evil' },
        list,
        alwaysShared,
      );
      expect(list.getBans('#ch')).toHaveLength(0);
    });

    it('ignores frames for non-shared channels', () => {
      const list = new SharedBanList();
      BanListSyncer.applyFrame(
        {
          type: 'CHAN_BAN_ADD',
          channel: '#private',
          mask: '*!*@x',
          setBy: 'a',
          setAt: 0,
          enforce: false,
        },
        list,
        neverShared,
      );
      expect(list.getBans('#private')).toHaveLength(0);
    });

    it('handles CHAN_EXEMPT_SYNC', () => {
      const list = new SharedBanList();
      BanListSyncer.applyFrame(
        {
          type: 'CHAN_EXEMPT_SYNC',
          channel: '#ch',
          exempts: [{ mask: '*!*@good', setBy: 'a', setAt: 0 }],
        },
        list,
        alwaysShared,
      );
      expect(list.getExempts('#ch')).toHaveLength(1);
    });

    it('handles CHAN_EXEMPT_ADD and CHAN_EXEMPT_DEL', () => {
      const list = new SharedBanList();
      BanListSyncer.applyFrame(
        { type: 'CHAN_EXEMPT_ADD', channel: '#ch', mask: '*!*@good', setBy: 'a', setAt: 0 },
        list,
        alwaysShared,
      );
      expect(list.getExempts('#ch')).toHaveLength(1);

      // Add another exempt without setBy/setAt (exercises ?? fallbacks on wire data)
      BanListSyncer.applyFrame(
        { type: 'CHAN_EXEMPT_ADD', channel: '#ch', mask: '*!*@other' },
        list,
        alwaysShared,
      );
      expect(list.getExempts('#ch')).toHaveLength(2);

      BanListSyncer.applyFrame(
        { type: 'CHAN_EXEMPT_DEL', channel: '#ch', mask: '*!*@good' },
        list,
        alwaysShared,
      );
      expect(list.getExempts('#ch')).toHaveLength(1); // *!*@other remains
      BanListSyncer.applyFrame(
        { type: 'CHAN_EXEMPT_DEL', channel: '#ch', mask: '*!*@other' },
        list,
        alwaysShared,
      );
      expect(list.getExempts('#ch')).toHaveLength(0);
    });

    it('handles frames with missing fields gracefully', () => {
      const list = new SharedBanList();
      // CHAN_BAN_SYNC with missing bans array
      BanListSyncer.applyFrame({ type: 'CHAN_BAN_SYNC', channel: '#ch' }, list, alwaysShared);
      expect(list.getBans('#ch')).toEqual([]);

      // CHAN_BAN_ADD with missing/invalid mask is rejected (mask validation)
      BanListSyncer.applyFrame(
        { type: 'CHAN_BAN_ADD', channel: '#ch', enforce: false },
        list,
        alwaysShared,
      );
      expect(list.getBans('#ch')).toHaveLength(0);

      // CHAN_BAN_ADD with valid mask is accepted
      BanListSyncer.applyFrame(
        { type: 'CHAN_BAN_ADD', channel: '#ch', mask: '*!*@bad.host', enforce: false },
        list,
        alwaysShared,
      );
      expect(list.getBans('#ch')).toHaveLength(1);

      // CHAN_BAN_DEL with missing mask
      BanListSyncer.applyFrame({ type: 'CHAN_BAN_DEL', channel: '#ch' }, list, alwaysShared);

      // CHAN_EXEMPT_SYNC with missing exempts
      BanListSyncer.applyFrame({ type: 'CHAN_EXEMPT_SYNC', channel: '#ch' }, list, alwaysShared);
      expect(list.getExempts('#ch')).toEqual([]);

      // CHAN_EXEMPT_ADD with missing/invalid mask is rejected
      BanListSyncer.applyFrame({ type: 'CHAN_EXEMPT_ADD', channel: '#ch' }, list, alwaysShared);
      expect(list.getExempts('#ch')).toHaveLength(0);

      // CHAN_EXEMPT_DEL with missing mask
      BanListSyncer.applyFrame({ type: 'CHAN_EXEMPT_DEL', channel: '#ch' }, list, alwaysShared);

      // CHAN_BAN_ADD with missing channel
      const result = BanListSyncer.applyFrame({ type: 'CHAN_BAN_ADD' }, list, alwaysShared);
      expect(result).toBeNull();
    });

    it('returns null for unknown frame types', () => {
      const list = new SharedBanList();
      const result = BanListSyncer.applyFrame(
        { type: 'UNKNOWN_TYPE', channel: '#ch' },
        list,
        alwaysShared,
      );
      expect(result).toBeNull();
    });
  });

  describe('roundtrip', () => {
    it('build → apply produces equivalent ban lists', () => {
      const source = new SharedBanList();
      source.addBan('#dev', '*!*@evil.host', 'admin', 1000);
      source.addBan('#dev', '*!*@spam.net', 'oper', 2000);
      source.addExempt('#dev', '*!*@trusted.com', 'admin', 1500);

      const frames = BanListSyncer.buildSyncFrames(source, alwaysShared);

      const target = new SharedBanList();
      for (const frame of frames) {
        BanListSyncer.applyFrame(frame, target, alwaysShared);
      }

      expect(target.getBans('#dev')).toEqual(source.getBans('#dev'));
      expect(target.getExempts('#dev')).toEqual(source.getExempts('#dev'));
    });
  });
});
