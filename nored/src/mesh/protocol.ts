import type { Packet, TextPacket, AlertPacket } from '../transport/MeshTransport';
import { isPacket } from './mediaTransfer.ts';

export const DAY = 86_400_000;
export const MAX_WIRE_BYTES = 4000; // Fits 255 frames at the minimum 20-byte ATT payload.
export const MAX_CONTROL_BYTES = 3000;
// Emergency alert contract (SPECS §3.2). The badge firmware mirrors these values;
// change them together (nored-badge/firmware/main/nored_router.c).
export const MAX_HOP_LIMIT = 10; // Also the hard ceiling isWirePacket enforces on every envelope.
export const EMERGENCY_BROADCAST_ID = 'emergency-broadcast';
export const ALERT_MAX_BODY = 280;
export const ALERT_TTL_HOPS = MAX_HOP_LIMIT;
export const ALERT_TTL_MS = 6 * 3_600_000;
export const ALERT_RATE_LIMIT_MS = 5000;
// Live emergencies still flood (including to badges) inside this window. Older stored
// alerts are inbox catch-up only — replaying them onto a badge when someone joins
// would flash every past alert as if it just happened.
export const ALERT_LIVE_MS = 60_000;
export const TEXT_TTL_HOPS = 5;
export type DeliveryAck = {
  version: 1; type: 'delivery-ack'; id: string; senderId: string;
  recipientId: string; timestamp: number; messageId: string; messagePath?: string[];
};
export type RoutedPayload = TextPacket | AlertPacket | DeliveryAck;
export type Envelope = {
  version: 1; type: 'mesh-data'; packet: RoutedPayload;
  expiresAt: number; hopCount: number; hopLimit: number; directOnly: boolean; path?: string[];
};
export type Control = {
  version: 1; senderId: string; recipientId: string;
} & (
  | { type: 'mesh-hello'; reply: boolean }
  | { type: 'mesh-inventory'; session: string; page: number; last: boolean; ids: string[] }
  | { type: 'mesh-receipt'; packetId: string }
);
type WithoutAddress<T> = T extends unknown ? Omit<T, 'version' | 'senderId' | 'recipientId'> : never;
export type ControlFields = WithoutAddress<Control>;
export type WirePacket = Packet | Envelope | Control;
export const wireBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(v) && !Object.prototype.hasOwnProperty.call(Object.prototype, v);
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const path = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.length <= MAX_HOP_LIMIT + 1 && v.every(id);
export const canonicalId = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);

export function isWirePacket(value: unknown): value is WirePacket {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (v.type === 'mesh-data') {
    const p = v.packet as RoutedPayload | undefined;
    return !!p && id(p.id) && id(p.senderId) && id(p.recipientId) && time(p.timestamp) &&
      (p.type === 'delivery-ack' ? p.version === 1 && id(p.messageId) &&
        (p.messagePath === undefined || path(p.messagePath)) :
        (p.type === 'text' || p.type === 'alert') && p.id.length <= 128 && isPacket(p) &&
        (p.type !== 'alert' || p.body.length <= ALERT_MAX_BODY)) &&
      time(v.expiresAt) && v.expiresAt > p.timestamp &&
      v.expiresAt - p.timestamp <= DAY &&
      Number.isInteger(v.hopCount) && Number.isInteger(v.hopLimit) &&
      Number(v.hopCount) >= 0 && Number(v.hopLimit) > 0 && Number(v.hopLimit) <= MAX_HOP_LIMIT &&
      Number(v.hopCount) <= Number(v.hopLimit) && typeof v.directOnly === 'boolean' &&
      (v.path === undefined || (path(v.path) && v.path.length <= Number(v.hopCount) + 1)) &&
      wireBytes(v) <= MAX_WIRE_BYTES;
  }
  if (typeof v.type === 'string' && v.type.startsWith('mesh-')) {
    if (!id(v.senderId) || !id(v.recipientId) || wireBytes(v) > MAX_CONTROL_BYTES) return false;
    if (v.type === 'mesh-hello') return typeof v.reply === 'boolean';
    if (v.type === 'mesh-receipt') return id(v.packetId);
    return v.type === 'mesh-inventory' && id(v.session) && Number.isInteger(v.page) &&
      Number(v.page) >= 0 && Number(v.page) < 1000 && typeof v.last === 'boolean' &&
      Array.isArray(v.ids) && v.ids.length <= 50 && v.ids.every(id);
  }
  return isPacket(v) && id(v.id) && id(v.senderId) && id(v.recipientId) && time(v.timestamp) &&
    (v.type !== 'alert' || v.body.length <= ALERT_MAX_BODY) &&
    wireBytes(v) <= MAX_WIRE_BYTES;
}

export function envelope(packet: RoutedPayload, directOnly = false): Envelope {
  return { version: 1, type: 'mesh-data', packet, directOnly,
    path: [packet.senderId],
    expiresAt: packet.timestamp + (packet.type === 'alert' ? ALERT_TTL_MS : DAY),
    hopCount: packet.type === 'alert' ? Math.max(0, packet.hops ?? 0) : 0,
    hopLimit: packet.type === 'text' ? TEXT_TTL_HOPS
      : packet.type === 'alert' ? Math.min(ALERT_TTL_HOPS, Math.max(1, packet.ttlHops ?? ALERT_TTL_HOPS))
      : MAX_HOP_LIMIT };
}
// Lower runs first. Alerts of every severity outrank all application traffic and the bulky
// inventory pages; only the tiny handshake/receipt/flow-control frames go ahead of them.
export function priority(packet: WirePacket): number {
  if (packet.type === 'mesh-inventory') return 2;
  if (packet.type.startsWith('mesh-') && packet.type !== 'mesh-data') return 0;
  const p = packet.type === 'mesh-data' ? packet.packet : packet;
  if (p.type === 'alert') return 1;
  if (p.type === 'text' || p.type === 'delivery-ack') return 2;
  if (p.type === 'media-ack' || p.type === 'media-retry') return 0;
  return p.type === 'media-manifest' && p.mediaKind === 'audio' ? 4 : 5;
}
