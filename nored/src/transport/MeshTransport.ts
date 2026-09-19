export type Peer = {
  id: string;
  name: string;
  rssi?: number;
  lastSeen: number;
};

export type Packet = {
  version: 1;
  id: string;
  senderId: string;
  type: 'text';
  timestamp: number;
  payload: string;
};

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
