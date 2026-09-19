import { PermissionsAndroid, Platform } from 'react-native';

import NoredBluetooth from '@/../modules/nored-bluetooth';
import type { Peer as NativePeer } from '@/../modules/nored-bluetooth';

import type {
  MeshTransport,
  Packet,
  Peer,
  Subscription,
  TransportState,
} from './MeshTransport';

class NoredBleTransport implements MeshTransport {
  async start() {
    if (!NoredBluetooth.isSupported()) {
      throw new Error('Bluetooth LE is not supported on this device.');
    }
    if (Platform.OS === 'android') {
      const permissions = NoredBluetooth.requiredPermissions();
      const results = await PermissionsAndroid.requestMultiple(
        permissions as (typeof PermissionsAndroid.PERMISSIONS)[keyof typeof PermissionsAndroid.PERMISSIONS][],
      );
      const resultByPermission = results as Record<string, string>;
      const denied = permissions.find(
        (permission) => resultByPermission[permission] !== PermissionsAndroid.RESULTS.GRANTED,
      );
      if (denied) throw new Error('Nearby Bluetooth permission was not granted.');
    }
    await NoredBluetooth.start();
  }

  stop() {
    return NoredBluetooth.stop();
  }

  getIdentity() {
    return NoredBluetooth.getIdentity();
  }

  setDisplayName(name: string) {
    return NoredBluetooth.setDisplayName(name);
  }

  async getPeers(): Promise<Peer[]> {
    return NoredBluetooth.getPeers();
  }

  async sendPacket(_peerId: string, _packet: Packet): Promise<void> {
    throw new Error('Packet transport is enabled after the physical discovery checkpoint.');
  }

  onPeerDiscovered(callback: (peer: Peer) => void): Subscription {
    return NoredBluetooth.addListener('onPeerDiscovered', (peer: NativePeer) => callback(peer));
  }

  onPeerLost(callback: (peerId: string) => void): Subscription {
    return NoredBluetooth.addListener('onPeerLost', ({ peerId }) => callback(peerId));
  }

  onPacketReceived(_callback: (peerId: string, packet: Packet) => void): Subscription {
    return { remove() {} };
  }

  onStateChanged(callback: (state: TransportState) => void): Subscription {
    return NoredBluetooth.addListener('onStateChanged', ({ state }) => callback(state));
  }

  onLog(callback: (message: string) => void): Subscription {
    return NoredBluetooth.addListener('onLog', ({ message }) => callback(message));
  }
}

export const meshTransport: MeshTransport = new NoredBleTransport();
