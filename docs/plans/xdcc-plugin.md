# Plan: XDCC Plugin

## Summary

An XDCC plugin that replicates the behavior of **iroffer-dinoex** — the reference
implementation for IRC XDCC file servers. Users browse packs with `XDCC LIST`, request
files with `XDCC SEND #N`, and the bot queues requests, opens a TCP connection per
transfer, and streams the file. Supports active and passive DCC, DCC RESUME, a two-tier
queue (main + idle), per-pack and global bandwidth limits, pack groups, CRC/MD5
verification, auto-add directory monitoring, and a full admin command set. Pack and queue
state persists across restarts.

Reference: https://github.com/dinoex/iroffer-dinoex

## Feasibility

- **Alignment**: DCC is explicitly out of MVP scope in DESIGN.md §4.2, but the plugin
  system is now in place and the feature fits cleanly as a plugin. This is the most
  complex plugin in the system.
- **Dependencies**: All required core modules are built. DCC SEND uses Node.js `net` +
  `fs` + `crypto` (stdlib) — no new npm dependencies required. CTCP notices go via
  `api.raw()` or a new `ctcpRequest()` method.
- **Complexity**: **XL** (significant effort) — full iroffer feature parity is a large
  implementation. Phases are ordered so each is independently useful.
- **Risk areas**:
  - **CTCP via `api.raw()`**: irc-framework may mangle `\x01` bytes — must spike in
    Phase 3 before building further; may require adding `ctcpRequest()` to PluginAPI
  - **Path traversal**: all file paths must be jailed to `filedir`
  - **Resource exhaustion**: uncapped ports/transfers/queues
  - **State file corruption**: power-loss mid-write must not lose the pack list
  - **List flood**: sending large pack lists must be throttled

## Decisions

| Question     | Decision                                                           |
| ------------ | ------------------------------------------------------------------ |
| IP detection | Explicit config only — `ip` required; `init()` throws if not set   |
| Passive DCC  | Both active and passive supported                                  |
| DCC RESUME   | Included                                                           |
| CTCP method  | Spike first in Phase 3; add `ctcpRequest()` to PluginAPI if needed |

## Dependencies

- [x] `api.raw()`, `api.bind()`, `api.db`, `api.config`, `api.say()`, `api.notice()` — built
- [x] `msg`, `pub`, `ctcp`, `notice` bind types — built
- [x] Node.js `net`, `fs`, `crypto`, `path` stdlib — available
- [ ] `ctcpRequest(target, type, params)` on PluginAPI — may be needed (see Phase 3 spike)

---

## Phases

### Phase 1: Data model and pack storage

**Goal:** Define and implement the complete pack data model. All subsequent phases depend on this.

- [ ] Create `plugins/xdcc/` directory with `index.ts`, `config.json`
- [ ] Create `plugins/xdcc/packs.ts` — pack CRUD on top of `api.db`

  **Pack schema** (stored as `pack:<n>` → JSON):

  ```ts
  interface XdccPack {
    num: number;
    file: string; // absolute path
    desc: string; // description shown in list
    note?: string; // optional note shown below pack line
    group?: string; // group name
    groupDesc?: string; // group description
    gets: number; // total download count
    size: number; // bytes (from fs.stat)
    minspeed?: number; // kB/s; 0 = global default
    maxspeed?: number; // kB/s; 0 = global default
    lock?: string; // password, undefined = unlocked
    dlimitMax?: number; // daily download limit (0 = no limit)
    dlimitUsed?: number; // today's download count
    dlimitDesc?: string; // message shown when limit exceeded
    trigger?: string; // custom trigger word
    color?: string; // IRC color code for description
    md5?: string; // hex MD5 of file
    crc32?: string; // hex CRC32 of file
    addedAt: number; // unix timestamp
    modifiedAt: number; // file mtime at add time
  }
  ```

  Functions: `listPacks()`, `getPack(n)`, `addPack(fields)`, `updatePack(n, fields)`,
  `removePack(n)`, `incrementGets(n)`, `resetDailyLimits()`, `getNextNum()`,
  `renumber(from, to, dest)`, `sortPacks(field, dir)`

- [ ] Validate on add: file exists, path resolves inside `filedir` (jailed with
      `path.resolve` + `startsWith`), reject symlinks outside jail
- [ ] `pack_seq` key tracks next auto-assigned pack number
- [ ] **Verification**: add/remove/list/rename packs via unit tests; path traversal
      attempts return clear error

---

### Phase 2: State persistence

**Goal:** Pack list and queue state survive bot restarts.

- [ ] Create `plugins/xdcc/state.ts` — JSON state file at `statefile` path
  - `saveState(packs, mainQueue, idleQueue)` — atomic write (write to `.tmp`, rename)
  - `loadState(): { packs, mainQueue, idleQueue }` — called from `init()`
  - On load: re-stat all files, remove missing packs or log warning (configurable via
    `removelostfiles`)
- [ ] `init()` loads state before registering any binds
- [ ] `teardown()` saves state
- [ ] State is also saved after every pack add/remove, every queue change, and every
      completed transfer
- [ ] **Verification**: add packs, send bot a SIGTERM, restart, pack list intact; queue
      entries restored

---

### Phase 3: DCC transfer engine

**Goal:** Low-level DCC SEND over TCP for both active and passive modes.

- [ ] **Spike**: send raw CTCP DCC SEND via `api.raw()` and confirm `\x01` bytes arrive
      intact at a test client (HexChat/irssi). If mangled → add
      `ctcpRequest(target: string, type: string, params: string): void` to `PluginAPI` /
      `IRCBridge` before proceeding.
- [ ] Create `plugins/xdcc/dcc.ts` — shared DCC utilities
  - `ipToInt(ip: string): number` — dotted-decimal → 32-bit unsigned int
  - `intToIp(n: number): string` — reverse
  - `genToken(): string` — random 9-digit numeric string for passive DCC
  - `formatActiveSend(filename, ipInt, port, size, is64bit): string`
  - `formatPassiveSend(filename, size, token): string` — ip=0, port=0
  - `formatDccAccept(filename, port, position, token?): string`
  - **64-bit sizes**: when `mirc_dcc64: true`, size field is decimal `>2^32`; when false,
    cap at 4 GB and send 32-bit value
- [ ] Create `plugins/xdcc/port-pool.ts`
  - `acquire(): number | null`, `release(port: number): void`
  - Reads `tcprangestart` + `tcprangelimit` from config
- [ ] Create `plugins/xdcc/transfer.ts` — single transfer state machine
  - States: `pending` → `connecting` → `sending` → `done` | `failed` | `timeout`
  - **Active send**: `net.createServer()`, send CTCP DCC SEND, await connection
  - **Passive send**: send passive offer CTCP, await `DCC SEND filename ip port size token`
    reply CTCP, `net.createConnection()` outbound
  - **DCC RESUME active**:
    1. Receive `DCC RESUME filename port offset` → validate offset ≤ filesize
    2. Reply `DCC ACCEPT filename port offset`
    3. `fs.createReadStream({ start: offset })`
  - **DCC RESUME passive**:
    1. Receive `DCC RESUME filename 0 offset token`
    2. Reply `DCC ACCEPT filename 0 offset token`
    3. Wait for user's `DCC SEND filename ip port size token` reply
    4. Connect outbound, stream from `offset`
  - File streaming: `fs.createReadStream` with bandwidth bucket (`tx_bucket`)
    - Fill `tx_bucket` every 250 ms at `maxspeed * 256` bytes
    - Only send when `tx_bucket >= TXSIZE` (1460 bytes)
    - Global cap checked against rolling 120-second `xdccsent[]` array
  - Minspeed: check after 15 s; if below threshold, disconnect with notice
  - Connection timeout: 180 s; reminder notice every 30 s to user while pending
  - Track `bytesSent`, `startedAt` for speed calculation
  - Emit `progress`, `done`, `error`, `timeout` events
- [ ] **Verification**: active send transfers test file to HexChat; md5sum matches.
      Passive send accepted by HexChat. RESUME restarts from correct offset.

---

### Phase 4: Queue system

**Goal:** Two-tier queue replicating iroffer's main queue + idle queue.

- [ ] Create `plugins/xdcc/queue.ts`

  ```ts
  interface QueueEntry {
    nick: string;
    ident: string;
    hostname: string;
    packNum: number;
    mode: 'active' | 'passive';
    resumePos: number; // 0 = fresh transfer
    enqueuedAt: number;
    password?: string; // for locked packs
  }
  ```

  - **Main queue**: max `queuesize` entries, max `maxqueueditemsperperson` per nick
  - **Idle queue**: overflow when main queue full; max `idlequeuesize`, max
    `maxidlequeuedperperson` per nick
  - `enqueue(entry, tier: 'main'|'idle')`: returns `{ pos, tier }` or throws denial
  - `promote()`: move head of idle queue → tail of main queue when main queue has space
  - `dequeue()`: pop head of main queue when `activeCount < slotsmax`
  - `cancel(nick)`: remove all entries; abort active transfer
  - `getPosition(nick, packNum)`: returns `{ tier, pos, eta }` for XDCC QUEUE response
  - Denial messages (exact iroffer strings):
    - Duplicate: `"Denied, You already have that item queued."`
    - Too many: `"Denied, You already have N items queued, Try Again Later"`
    - Main full: `"Main queue of size N is Full, Try Again Later"`
    - Idle full: `"Idle queue of size N is Full, Try Again Later"`
  - Slot-full prefix: `"** All Slots Full, ..."` or `"** You can only have N transfer(s) at a time, ..."`
  - `smallfilebypass`: files ≤ `smallfilebypass` kB skip the queue entirely
  - `balanced_queue`: if set, interleave dequeue across different nicks fairly
  - Notify user of position on enqueue, and on `notifytime` interval
  - `requeue_sends`: on `loadState()`, re-enqueue packs whose transfers were in-flight

- [ ] Queue pump: `setInterval` every second in `init()`, calls `dequeue()` and starts
      transfers; cleared in `teardown()`
- [ ] **Verification**: 5 requests with `slotsmax: 2` — only 2 active; idle queue promoted
      correctly; `smallfilebypass` sends immediately

---

### Phase 5: User-facing XDCC commands

**Goal:** Full iroffer-compatible user command set. All triggered via PM (`msg` bind) or
optionally in-channel (`pub` bind) when `respondtochannelxdcc: true`.

All commands parsed from `XDCC <subcommand> [args]` private message.

- [ ] Create `plugins/xdcc/commands-user.ts`

  #### XDCC LIST [group|ALL]
  - Send pack list via NOTICE with configurable `slow_privmsg` rate (default 1 line/sec)
  - Format: header → group headers → pack lines → footer (see List Format below)
  - Optional group filter; `ALL` overrides `restrictlist`
  - Track pending list delivery per nick so XDCC STOP can cancel it
  - Store list-delivery timer handles in `activeLists: Map<nick, NodeJS.Timeout[]>`

  #### XDCC STOP
  - Cancel pending list delivery for this nick
  - Reply: `"LIST stopped (N lines deleted)"`

  #### XDCC SEND #N [password] / XDCC GET #N [password]
  - `GET` is alias for `SEND`
  - Validate in order:
    1. Host check against `downloadhost`/`nodownloadhost`
    2. Pack exists → `"** Invalid Pack Number, Try Again"`
    3. Channel restriction (`restrictsend`) → require nick in a known channel
    4. Pack locked + no/wrong password → `"** XDCC SEND denied, this pack is locked"`
    5. Already queued/transferring this pack → `"** You already requested that pack"`
    6. `nosend` active → `"** The Owner Has Requested That No New Connections Are Made..."`
    7. Transfer limits exceeded → daily/weekly/monthly cap message
    8. Pack daily limit exceeded → `dlimitDesc` or default message
    9. Max transfers per person → attempt queue
    10. All slots full / `holdqueue` → attempt queue (main → idle → deny)
  - On success, slot available: notice `"** Sending you pack #N ("desc"), which is XB. (resume supported)"`
  - On success, from queue: `"** Sending you queued pack #N ("desc"), which is XB. (resume supported)"`
  - `autosendpack`: if pack has custom trigger matched in channel, use alternate message

  #### XDCC CANCEL
  - Cancel active transfer for this nick
  - Reply: `"** Your DCC has been removed."` or `"You don't have a transfer running"`

  #### XDCC QUEUE
  - Show position and ETA: `"Queued Nh Nm for "desc", in position N of N. Nh Nm or more/less remaining. (at HH:MM)"`
  - If not queued: `"You don't appear to be in a queue"`

  #### XDCC REMOVE [N]
  - Remove self from main or idle queue at position N (or first match if omitted)
  - Reply: `"Removed you from the queue for "desc", you waited N minutes."`
  - If not found: `"You Don't Appear To Be In A Queue"`

  #### XDCC SEARCH <pattern>
  - Search pack descriptions and filenames for pattern (case-insensitive glob)
  - Reply each match: `" - Pack #N matches, "description""` as NOTICEs
  - Limit results to `max_find` (default: 5)
  - Min non-wildcard chars enforced if `atfind` configured

  #### XDCC INFO #N
  - Reply all pack fields (see INFO format below)
  - Denied if `disablexdccinfo` is set

  #### XDCC BATCH <spec> [password]
  - `spec` formats: group name, `group*pattern`, `N-M` range, `N,M,...` comma list
  - Enqueue all matching packs (up to queue limits)
  - Reply count of successfully queued items

  #### XDCC OPTION +/-FLAG
  - Flags: `ACTIVE` (force active DCC), `PASSIVE` (force passive), `QUIET` (suppress notices)
  - Store per-nick preferences in memory (lost on reload — intentional, matches iroffer)
  - Reply: `"Option PASSIVE/ACTIVE/QUIET set/cleared"`

  #### XDCC OWNER
  - Reply: `"Owner for this bot is: <owner_nick config>"`

  #### XDCC HELP
  - Reply list of available commands as NOTICEs

- [ ] **Channel triggers** (bind `pub`):
  - `!list [botnick]` → compact summary line:
    `"(XDCC) Packs:(N) Trigger:(/MSG bot XDCC LIST) Sends:(X/Y) Queues:(X/Y) Record:(X.XkB/s)"`
  - `!N` → treat as `XDCC SEND #N` if `channel_trigger: true`
  - `@find <pattern>` / `!find <pattern>` → `XDCC SEARCH` equivalent if `atfind` enabled
  - `!new` → show newest `new_trigger` packs if configured

- [ ] **Flood protection**:
  - Track request timestamps per nick in rolling array
  - Rate: `flood_protection_rate` commands per 10 seconds (default 6)
  - Auto-ignore: `autoignore_rate` requests/sec average (default 8); ignore for
    `autoignore_threshold`-based duration
  - Exempt nicks matching `autoignore_exclude` hostmasks

- [ ] **Verification**: all commands tested manually against a real IRC client; XDCC LIST
      renders correctly; flood protection activates after rapid requests

---

### Phase 6: Pack list format

**Goal:** Render the XDCC list in iroffer format — full/minimal/summary modes.

- [ ] Create `plugins/xdcc/list-format.ts`

  #### Header lines (full + summary modes)

  ```
  ** <headline> **                           (each configured headline)
  ** N packs **  X of Y slots open[, Queue: X/Y][, Min: X.Xk][, Record: X.Xk]
  ** Bandwidth Usage **  Current: X.XkB/s[, Cap: X.0kB/s][, Record: X.XkB/s]
  ** To request a file, type "/MSG <bot> XDCC SEND x" **
  ** To request details, type "/MSG <bot> XDCC INFO x" **
  ** To stop this listing, type "/MSG <bot> XDCC STOP" **
  ** To list a group, type "/MSG <bot> XDCC LIST group" **
  ** To list all packs, type "/MSG <bot> XDCC LIST ALL" **
  ```

  #### Group headers (when packs have groups)

  ```
  group: <groupname>  <group_desc>
  ```

  Using `group_seperator` (default: double-space) between name and desc.

  #### Pack line

  ```
  #N  Xx [size] [date] description [group] [X.XK Min] [X.XK Max] [N of N DL left]
   ^- note text
  ```

  - `#N` in bold (`\x02#N\x02`)
  - Gets count with `x` suffix
  - Size formatted: bytes → `B/kB/MB/GB` human-readable in brackets
  - Optional date if `show_date_added: true` (format: `YYYY-MM-DD`)
  - Description in configured `color` if set
  - Group suffix if `show_group_of_pack: true`
  - Per-pack minspeed/maxspeed suffixes if different from global
  - Daily limit suffix `[N of N DL left]` if `dlimitMax > 0`
  - Note on next line indented with `^-`
  - Hidden packs (`hidelockedpacks: true`) omitted if locked

  #### Footer lines (full mode)

  ```
  ** <creditline> **
  Total Offered: XB  Total Transferred: XB
  ```

  #### Summary mode: header + credit line only, no pack lines

  #### Minimal mode: pack lines only, no header/footer

- [ ] Throttled delivery: send notices at `slow_privmsg` rate (default 1/sec) using a
      per-nick timer; store handles for XDCC STOP cancellation
- [ ] `PSEND <channel> full|minimal|summary` admin command sends list to a channel
- [ ] **Verification**: LIST output matches iroffer format; groups render correctly; STOP
      cancels mid-list

---

### Phase 7: Admin commands

**Goal:** Full pack management and bot control via ops. Accessible via channel command
(flags: `o`) or PM from authorized hostmask.

- [ ] Create `plugins/xdcc/commands-admin.ts`
      All admin commands bound as `pub` with `o` flag, prefix `.xdcc`:

  #### Pack Information
  - `.xdcc xdl` — full list in admin format (like XDCC LIST but with file paths)
  - `.xdcc xds` — transfer/slot status
  - `.xdcc info #N` — full pack info (same as user XDCC INFO)
  - `.xdcc find <pattern>` — search packs

  #### Pack Add/Remove
  - `.xdcc add <filepath> [desc]` — add single file; auto-stat for size; validate inside `filedir`
  - `.xdcc adddir <dir>` — add all files in directory
  - `.xdcc addnew <dir>` — add only files not already in the pack list
  - `.xdcc addgroup <group> <dir>` — add dir with group name
  - `.xdcc remove #N [#M]` — remove pack(s); accepts range
  - `.xdcc removedir <dir>` — remove all packs from directory
  - `.xdcc removegroup <group>` — remove all packs in group
  - `.xdcc removematch <pattern>` — remove packs matching glob
  - `.xdcc removelost` — remove packs whose files no longer exist

  #### Pack Editing
  - `.xdcc chdesc #N [msg]` — change description (clear if no msg)
  - `.xdcc chnote #N [msg]` — change note
  - `.xdcc chfile #N <filepath>` — change file path
  - `.xdcc chmins #N <x>` — set per-pack minspeed (kB/s); 0 = global
  - `.xdcc chmaxs #N <x>` — set per-pack maxspeed (kB/s); 0 = global
  - `.xdcc chlimit #N <x>` — set daily download limit; 0 = unlimited
  - `.xdcc chlimitinfo #N [msg]` — set limit-exceeded message
  - `.xdcc chtrigger #N <word>` — set custom trigger word
  - `.xdcc deltrigger #N` — remove trigger from pack
  - `.xdcc chgets #N <x>` — manually set gets counter
  - `.xdcc lock #N <password>` — password-lock a pack
  - `.xdcc unlock #N` — unlock a pack
  - `.xdcc group #N <groupname>` — assign pack to group
  - `.xdcc groupdesc <group> <desc>` — set group description
  - `.xdcc color #N <colorcode>` — set pack description color

  #### Pack Organization
  - `.xdcc sort [field] [asc|desc]` — sort fields: name/desc/group/size/gets/added;
    default: name asc
  - `.xdcc renumber <from> [to] <dest>` — renumber pack(s) to new position(s)

  #### Announcements
  - `.xdcc announce #N [msg]` — announce pack to `announce_channel`
    Format: `"**<msg>** <sep><desc><sep>/MSG <bot> XDCC SEND #N"`
  - `.xdcc sannounce #N` — short announce: `"**#N** <sep><desc>"`
  - `.xdcc noannounce <minutes>` — suppress announces for N minutes

  #### Transfer/Queue Control
  - `.xdcc close [id]` — close active transfer by ID
  - `.xdcc closeu <nick>` — close all transfers for nick
  - `.xdcc rmq [pos]` — remove entry from main queue at position (or all)
  - `.xdcc rmiq [pos]` — remove entry from idle queue
  - `.xdcc rmallq` — clear all queues
  - `.xdcc slotsmax [n]` — get/set max concurrent transfers
  - `.xdcc queuesize [n]` — get/set main queue size
  - `.xdcc holdqueue [x]` — hold (x=1) or release (x=0) the queue

  #### Bot Control
  - `.xdcc status` — active transfers, queue depths, bandwidth usage
  - `.xdcc nosend <minutes> [msg]` — disable new transfers for N minutes
  - `.xdcc nolist <minutes>` — disable list responses for N minutes
  - `.xdcc cleargets` — reset all gets counters to 0
  - `.xdcc psend <channel> full|minimal|summary` — send list to channel

  #### Checksum
  - `.xdcc md5 [#N [#M]]` — compute MD5 for pack(s); store in pack record
  - `.xdcc crc [#N [#M]]` — compute CRC32 for pack(s); store in pack record

- [ ] **Verification**: add/remove/sort/renumber packs; announce to channel; close active transfer

---

### Phase 8: Pack list as DCC file (`XDCC SEND LIST`)

**Goal:** Support `XDCC SEND LIST` — transfer the rendered pack list as a text file via DCC.

- [ ] On `XDCC SEND LIST` (or `XDCC GET LIST`): render full pack list to a temp file
- [ ] Open active DCC SEND of the temp file; clean up temp file after transfer
- [ ] Also write list to `xdcclistfile` path on disk (plain text) after every pack change
- [ ] **Verification**: `XDCC SEND LIST` transfers a valid text file to HexChat

---

### Phase 9: CRC32 / MD5 verification + auto-add

**Goal:** Checksum verification and directory monitoring for new files.

- [ ] Create `plugins/xdcc/checksums.ts`
  - `computeMd5(filepath): Promise<string>` — streaming MD5 via `crypto`
  - `computeCrc32(filepath): Promise<string>` — streaming CRC32 (use `buffer-crc32`
    npm package, or implement with polynomial table)
  - `extractCrc32FromFilename(filename): string | null` — parse `[AABBCCDD]` from filename
  - `auto_crc_check`: if filename has embedded CRC32, verify on add; lock pack and log
    warning if mismatch
- [ ] Create `plugins/xdcc/autoadd.ts` — directory watcher using `fs.watch` +
      periodic `readdir` scan (every `autoadd_time` seconds)
  - Only add file after it hasn't changed for `autoadd_delay` seconds (stat mtime stable)
  - Apply `adddir_match` / `adddir_exclude` glob filters
  - Apply `adddir_min_size` filter
  - Assign group by `autoadd_group_match` pattern → group mapping
  - Sort new packs by `autoadd_sort` field
  - Announce new packs if `autoaddann` is set
  - `noautoadd <x>` admin command suspends auto-add for N minutes
- [ ] **Verification**: drop a file into watched dir; it appears in pack list after delay;
      CRC mismatch locks pack

---

### Phase 10: Transfer notifications (exact iroffer message strings)

**Goal:** All user-facing notices match iroffer verbatim.

Reference message strings (implement exactly):

- Queued main: `"Added you to the main queue for pack N ("desc") in position N. To Remove yourself at a later time type \"/MSG <bot> XDCC REMOVE N\"."`
- Queued idle: `"Added you to the idle queue for pack N ("desc") in position N."`
- Send starting: `"** Sending you pack #N ("desc"), which is XB. (resume supported)"`
- Send from queue: `"** Sending you queued pack #N ("desc"), which is XB. (resume supported)"`
- Pending reminder: `"** You have a DCC pending, Set your client to receive the transfer. Type \"/MSG <bot> XDCC CANCEL\" to abort the transfer. (N seconds remaining until timeout)"`
- Timeout: `"DCC Timeout (180 Sec Timeout)"`
- Completed: `"** Transfer Completed (N kB, Xh Xm Xs, X.X kB/sec[, md5sum: <hash>])"`
- Under min speed: `"Under Min Speed Requirement, X.XK/sec is less than X.XK/sec"`
- Punish (if `punishslowusers`): `"Punish-ignore activated for <nick>"`
- Removed from queue (pack removed): `"** Removed From Queue: Pack removed"`
- Removed from queue (left channel): `"** Removed From Queue: You are no longer on a known channel"`

- [ ] Create `plugins/xdcc/messages.ts` — all user-facing strings as typed functions
      (makes testing and localization straightforward)
- [ ] **Verification**: unit-test every message formatter against expected strings

---

### Phase 11: Tests

**Goal:** Automated coverage for all non-TCP logic.

- [ ] `tests/plugins/xdcc/packs.test.ts` — pack CRUD, path traversal rejection,
      auto-numbering, sort, renumber, daily limit reset
- [ ] `tests/plugins/xdcc/queue.test.ts` — enqueue/dequeue, main/idle promotion,
      per-nick limits, balanced queue, cancel, smallfilebypass, requeue_sends
- [ ] `tests/plugins/xdcc/dcc.test.ts` — `ipToInt`/`intToIp` roundtrip, all CTCP format
      strings (with `\x01` delimiters), 64-bit size encoding, port pool acquire/release
- [ ] `tests/plugins/xdcc/list-format.test.ts` — full/minimal/summary list rendering,
      group headers, pack line format (bold, gets, size, note, group suffix)
- [ ] `tests/plugins/xdcc/messages.test.ts` — all message formatters match expected
      iroffer strings
- [ ] `tests/plugins/xdcc/resume.test.ts` — active and passive RESUME CTCP handshake
      state machines; unknown token rejected; offset validated against filesize
- [ ] `tests/plugins/xdcc/checksums.test.ts` — MD5/CRC32 of known test files; embedded
      CRC32 extraction from filenames
- [ ] `tests/plugins/xdcc/state.test.ts` — save/load roundtrip; atomic write (no
      partial state); missing-file handling on load
- [ ] **Verification**: `pnpm test` green

---

## Config changes

New file `plugins/xdcc/config.json` (all keys, overridable via `plugins.json`):

```json
{
  "filedir": "",
  "ip": "",
  "statefile": "",
  "xdcclistfile": "",

  "owner_nick": "",
  "headline": [],
  "creditline": "",

  "slotsmax": 3,
  "queuesize": 10,
  "idlequeuesize": 5,
  "maxtransfersperperson": 1,
  "maxqueueditemsperperson": 1,
  "maxidlequeuedperperson": 1,
  "smallfilebypass": 0,
  "balanced_queue": false,
  "holdqueue": false,
  "requeue_sends": false,
  "notifytime": 5,

  "tcprangestart": 5000,
  "tcprangelimit": 100,
  "connect_timeout": 180,
  "mirc_dcc64": true,
  "passive_dcc": true,

  "transferminspeed": 0,
  "transfermaxspeed": 0,
  "overallmaxspeed": 0,
  "transferlimits": { "daily": 0, "weekly": 0, "monthly": 0 },
  "punishslowusers": 0,
  "no_minspeed_on_free": true,

  "announce_channel": "",
  "announce_seperator": "  ",
  "autoaddann": "",
  "autoaddann_short": false,
  "autoaddann_mask": "*",

  "autoadd_dir": [],
  "autoadd_time": 300,
  "autoadd_delay": 60,
  "autoadd_group_match": {},
  "autoadd_sort": "name",

  "adddir_match": "*",
  "adddir_exclude": [],
  "adddir_min_size": 0,
  "auto_crc_check": false,
  "removelostfiles": false,

  "respondtochannelxdcc": false,
  "respondtochannellist": true,
  "restrictsend": false,
  "need_voice": false,
  "downloadhost": [],
  "nodownloadhost": [],
  "restrictlist": false,
  "hidelockedpacks": false,
  "disablexdccinfo": false,
  "show_date_added": false,
  "show_group_of_pack": true,
  "group_seperator": "  ",

  "slow_privmsg": 1,
  "flood_protection_rate": 6,
  "autoignore_rate": 8,
  "autoignore_threshold": 10,
  "autoignore_exclude": [],

  "max_find": 5,
  "atfind": 3,
  "new_trigger": 0,
  "channel_trigger": true
}
```

**Required on init (throws if empty):**

- `filedir` — absolute path for all served files (all pack paths are jailed to this)
- `ip` — bot's publicly routable IPv4 address (run `curl ifconfig.me` on the host)
- `statefile` — absolute path for JSON state file (e.g. `/var/lib/n0xb0t/xdcc.state`)

---

## Database changes

All data stored in the plugin's scoped `api.db` KV store. The state file (`statefile`)
is the authoritative source for pack list and queues — `api.db` is used only for
aggregate stats that don't need to be in the state file:

- `stats:bytes_sent` → total bytes sent lifetime
- `stats:transfers_completed` → total completed transfers
- `stats:bandwidth_record` → highest observed per-second bandwidth

Pack data lives in `statefile` (JSON), not in `api.db`, because it needs atomic
multi-key writes (the entire pack list is saved as one JSON object).

---

## XDCC INFO output format

```
Pack Info for Pack #N:
Filename       /full/path/to/file
Sendname       filename.ext
Description    <desc>
Filesize       <bytes> [<human>B]
Minspeed       X.XkB/sec                 (if set)
Maxspeed       X.XkB/sec                 (if set)
Gets           N
md5sum         <hash>                    (if computed)
crc32          <hash>                    (if computed)
Last Modified  <date>
Pack Added     <date>
Note           <note>                    (if present)
is protected by password                 (if locked)
```

---

## Open questions

None — all design decisions resolved.
