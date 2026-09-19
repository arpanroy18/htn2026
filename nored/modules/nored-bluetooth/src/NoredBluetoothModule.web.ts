import { NativeModule, registerWebModule } from 'expo';

import { NoredBluetoothModuleEvents } from './NoredBluetooth.types';

class NoredBluetoothModule extends NativeModule<NoredBluetoothModuleEvents> {
  isSupported() {
    return false;
  }

  requiredPermissions() {
    return [];
  }

  async start() {
    throw new Error('Bluetooth LE is only available in an iOS or Android development build.');
  }

  async stop() {}

  getIdentity() {
    return { id: 'web-preview', name: 'Web preview' };
  }

  async setDisplayName(name: string) {
    return { id: 'web-preview', name };
  }

  getPeers() {
    return [];
  }

  async sendPacket(_peerId: string, _packet: string) {
    throw new Error('Bluetooth LE is only available in an iOS or Android development build.');
  }
}

export default registerWebModule(NoredBluetoothModule, 'NoredBluetoothModule');
