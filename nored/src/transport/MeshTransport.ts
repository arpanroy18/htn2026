import type { WirePacket } from '../mesh/protocol';
export type Peer = {
  id: string;
  name: string;
  rssi?: number;
  lastSeen: number;
  nored?: boolean;
  identityConfirmed?: boolean;
  /** Native link state: a GATT client write path or subscribed central currently exists. */
  connected?: boolean;
  /** Set in JS when native reports peer lost; kept visible during grace period. */
  pendingLoss?: boolean;
  replacesId?: string;
  avatarIcon?: string;
  avatarColor?: number;
};

type PacketBase = {
  version: 1;
  id: string;
  senderId: string;
  recipientId: string;
  timestamp: number;
  groupId?: string;
  hops?: number;
  ttlHops?: number;
};

export type TextPacket = PacketBase & {
  type: 'text';
  payload: string;
};

export type GroupMember = {
  id: string;
  name: string;
};

export type GroupSyncPacket = PacketBase & {
  type: 'group-sync';
  groupId: string;
  name: string;
  members: GroupMember[];
};

export type MediaKind = 'image' | 'audio';

export type MediaManifestPacket = PacketBase & {
  type: 'media-manifest';
  mediaKind: MediaKind;
  mimeType: string;
  byteLength: number;
  chunkCount: number;
  hash: string;
  width?: number;
  height?: number;
  durationMs?: number;
};

export type MediaChunkPacket = PacketBase & {
  type: 'media-chunk';
  transferId: string;
  sequence: number;
  total: number;
  payload: string;
};

export type MediaAckPacket = PacketBase & {
  type: 'media-ack';
  transferId: string;
};

export type MediaRetryPacket = PacketBase & {
  type: 'media-retry';
  transferId: string;
  missing: number[];
};

export type AlertSeverity = 'INFO' | 'HELP' | 'DANGER';

export type AlertPacket = PacketBase & {
  type: 'alert';
  body: string;
  severity: AlertSeverity;
  hasLocation?: boolean;
  hops?: number;
  ttlHops?: number;
};

export type GameId = 'mesh-ping' | 'pong' | 'telephone' | 'chess';

export type GameEvent =
  | 'invite'
  | 'join'
  | 'leave'
  | 'ping'
  | 'pong'
  | 'baton'
  | 'round-start'
  | 'stroke'
  | 'round-finish'
  | 'pong-start'
  | 'pong-input'
  | 'pong-state'
  | 'telephone-prompt'
  | 'telephone-drawing'
  | 'telephone-guess'
  | 'chess-start'
  | 'chess-move'
  | 'chess-resign';

export type GamePacket = PacketBase & {
  type: 'game';
  gameId: GameId;
  event: GameEvent;
  roundId?: string;
  targetId?: string;
  sequence?: number;
  payload?: string;
};

export type Packet =
  | TextPacket
  | GroupSyncPacket
  | MediaManifestPacket
  | MediaChunkPacket
  | MediaAckPacket
  | MediaRetryPacket
  | AlertPacket
  | GamePacket;

export type DeviceIdentity = {
  id: string;
  name: string;
  avatarIcon?: string;
  avatarColor?: number;
};

export type TransportState =
  | 'unsupported'
  | 'unauthorized'
  | 'poweredOff'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'unknown';

export type Subscription = { remove(): void };

export interface MeshTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  getIdentity(): DeviceIdentity;
  setDisplayName(name: string): Promise<DeviceIdentity>;
  getPeers(): Promise<Peer[]>;
  sendPacket(peerId: string, packet: WirePacket): Promise<void>;
  onPeerDiscovered(callback: (peer: Peer) => void): Subscription;
  onPeerLost(callback: (peerId: string) => void): Subscription;
  onPacketReceived(callback: (peerId: string, packet: WirePacket) => void): Subscription;
  onStateChanged(callback: (state: TransportState) => void): Subscription;
  onLog(callback: (message: string) => void): Subscription;
}
