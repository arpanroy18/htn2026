import { NativeModule, requireNativeModule } from 'expo';

import type {
  DeviceIdentity,
  NoredBluetoothModuleEvents,
  Peer,
} from './NoredBluetooth.types';

declare class NoredBluetoothModule extends NativeModule<NoredBluetoothModuleEvents> {
  isSupported(): boolean;
  requiredPermissions(): string[];
  start(): Promise<void>;
  stop(): Promise<void>;
  getIdentity(): DeviceIdentity;
  setDisplayName(name: string): Promise<DeviceIdentity>;
  getPeers(): Peer[];
}

export default requireNativeModule<NoredBluetoothModule>('NoredBluetooth');
