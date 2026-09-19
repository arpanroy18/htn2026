export type Peer = {
  id: string;
  name: string;
  rssi?: number;
  lastSeen: number;
  nored?: boolean;
  identityConfirmed?: boolean;
  replacesId?: string;
  avatarIcon?: string;
  avatarColor?: number;
};

export type DeviceIdentity = {
  id: string;
  name: string;
  avatarIcon?: string;
  avatarColor?: number;
};

export type BluetoothState =
  | 'unsupported'
  | 'unauthorized'
  | 'poweredOff'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'unknown';

export type NativeLog = {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
};

export type PacketEvent = {
  peerId: string;
  packet: string;
};

export type NoredBluetoothModuleEvents = {
  onPeerDiscovered: (peer: Peer) => void;
  onPeerLost: (event: { peerId: string }) => void;
  onStateChanged: (event: { state: BluetoothState }) => void;
  onLog: (event: NativeLog) => void;
  onPacketReceived: (event: PacketEvent) => void;
};
