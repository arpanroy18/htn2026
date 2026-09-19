import { PermissionsAndroid, Platform } from 'react-native';

import NoredBluetooth from '@/../modules/nored-bluetooth';
import type { Peer as NativePeer } from '@/../modules/nored-bluetooth';
import { isPacket } from '@/mesh/mediaTransfer';

import type {
  DeviceIdentity,
  MeshTransport,
  Packet,
  Peer,
  Subscription,
  TransportState,
} from './MeshTransport';

function normalizePeerId(id: string) {
  return id.trim().toLowerCase();
}

function normalizeIdentity(identity: DeviceIdentity): DeviceIdentity {
  return { ...identity, id: normalizePeerId(identity.id) };
}

function normalizeRssi(rssi: unknown): number | undefined {
  if (typeof rssi !== 'number' || !Number.isFinite(rssi) || rssi === 127 || rssi > 20 || rssi < -127) {
    return undefined;
  }
  return rssi;
}

function normalizePeer(peer: Peer): Peer {
  return {
    ...peer,
    id: normalizePeerId(peer.id),
    rssi: normalizeRssi(peer.rssi),
    replacesId: peer.replacesId ? normalizePeerId(peer.replacesId) : undefined,
  };
}

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
    return normalizeIdentity(NoredBluetooth.getIdentity());
  }

  async setDisplayName(name: string) {
    return normalizeIdentity(await NoredBluetooth.setDisplayName(name));
  }

  async getPeers(): Promise<Peer[]> {
    return (await NoredBluetooth.getPeers()).map(normalizePeer);
  }

  async sendPacket(peerId: string, packet: Packet): Promise<void> {
    await NoredBluetooth.sendPacket(
      normalizePeerId(peerId),
      JSON.stringify({
        ...packet,
        senderId: normalizePeerId(packet.senderId),
        recipientId: normalizePeerId(packet.recipientId),
      }),
    );
  }

  onPeerDiscovered(callback: (peer: Peer) => void): Subscription {
    return NoredBluetooth.addListener('onPeerDiscovered', (peer: NativePeer) =>
      callback(normalizePeer(peer)),
    );
  }

  onPeerLost(callback: (peerId: string) => void): Subscription {
    return NoredBluetooth.addListener('onPeerLost', ({ peerId }) =>
      callback(normalizePeerId(peerId)),
    );
  }

  onPacketReceived(callback: (peerId: string, packet: Packet) => void): Subscription {
    return NoredBluetooth.addListener('onPacketReceived', (event: { peerId: string; packet: string }) => {
      try {
        const packet = JSON.parse(event.packet) as unknown;
        if (!isPacket(packet)) return;
        callback(normalizePeerId(event.peerId), {
          ...packet,
          senderId: normalizePeerId(packet.senderId),
          recipientId: normalizePeerId(packet.recipientId),
        });
      } catch {
        // Drop malformed frames; native logs already recorded the parse failure.
      }
    });
  }

  onStateChanged(callback: (state: TransportState) => void): Subscription {
    return NoredBluetooth.addListener('onStateChanged', ({ state }) => callback(state));
  }

  onLog(callback: (message: string) => void): Subscription {
    return NoredBluetooth.addListener('onLog', ({ message }) => callback(message));
  }
}

export const meshTransport: MeshTransport = new NoredBleTransport();
