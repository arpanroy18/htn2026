export type Peer = {
  id: string;
  name: string;
  rssi?: number;
  lastSeen: number;
  nored?: boolean;
  identityConfirmed?: boolean;
  replacesId?: string;
};

type PacketBase = {
  version: 1;
  id: string;
  senderId: string;
  recipientId: string;
  timestamp: number;
};

export type TextPacket = PacketBase & {
  type: 'text';
  payload: string;
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

export type Packet =
  | TextPacket
  | MediaManifestPacket
  | MediaChunkPacket
  | MediaAckPacket
  | MediaRetryPacket;

export type DeviceIdentity = {
  id: string;
  name: string;
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
  sendPacket(peerId: string, packet: Packet): Promise<void>;
  onPeerDiscovered(callback: (peer: Peer) => void): Subscription;
  onPeerLost(callback: (peerId: string) => void): Subscription;
  onPacketReceived(callback: (peerId: string, packet: Packet) => void): Subscription;
  onStateChanged(callback: (state: TransportState) => void): Subscription;
  onLog(callback: (message: string) => void): Subscription;
}
