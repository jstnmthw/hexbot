// HexBot — Bot Link module barrel
//
// Single public surface for the botlink subsystem. External consumers
// should import from `./botlink` (or `../botlink`), not reach into
// individual files — this keeps the module boundary visible in the
// import graph and makes internal renames cheap.

export { BotLinkHub, isValidIP, isWhitelisted } from './hub';
export type { AuthBanEntry, LinkBan } from './hub';
export { BotLinkLeaf } from './leaf';
export {
  BotLinkProtocol,
  HUB_ONLY_FRAMES,
  MAX_FRAME_SIZE,
  hashPassword,
  sanitizeFrame,
} from './protocol';
export { executeCmdFrame } from './cmd-exec.js';
export { RateCounter } from './rate-counter.js';
export { FrameType, type FrameTypeName } from './frame-types.js';
export type {
  CommandRelay,
  LinkFrame,
  LinkPermissions,
  PartyLineUser,
  SocketFactory,
} from './types.js';
export { BotLinkAuthManager, normalizeIP } from './auth';
export type { AdmissionResult } from './auth';
export { BotLinkRelayRouter } from './relay-router';
export type { RelayRouterDeps } from './relay-router';
export { PendingRequestMap } from './pending';
export { BanListSyncer, SharedBanList } from './sharing';
export type { BanEntry } from './sharing';
export { ChannelStateSyncer, PermissionSyncer } from './sync';
export { handleProtectFrame } from './protect';
export type { ProtectHandlerDeps } from './protect';
export { handleRelayFrame } from './relay-handler';
export type {
  RelayCommandExecutor,
  RelayDCCView,
  RelayHandlerDeps,
  RelayPermissionsProvider,
  RelaySender,
  RelaySessionMap,
  RelayVirtualSession,
} from './relay-handler';
