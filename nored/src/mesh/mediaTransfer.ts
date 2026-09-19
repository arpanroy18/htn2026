import type {
  MediaChunkPacket,
  MediaManifestPacket,
  Packet,
} from '@/transport';

export const MEDIA_CHUNK_BYTES = 2048;
export const MEDIA_REASSEMBLY_TIMEOUT_MS = 10_000;

export type IncomingTransfer = {
  manifest: MediaManifestPacket;
  chunks: Map<number, Uint8Array>;
  updatedAt: number;
  retries: number;
};

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array) {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += BASE64_ALPHABET[(value >> 18) & 63];
    output += BASE64_ALPHABET[(value >> 12) & 63];
    output += second === undefined ? '=' : BASE64_ALPHABET[(value >> 6) & 63];
    output += third === undefined ? '=' : BASE64_ALPHABET[value & 63];
  }
  return output;
}

export function base64ToBytes(value: string) {
  const clean = value.replace(/\s/g, '');
  if (!clean || clean.length % 4 !== 0) throw new Error('Invalid base64 payload.');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const output = new Uint8Array((clean.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < clean.length; index += 4) {
    const a = BASE64_ALPHABET.indexOf(clean[index]);
    const b = BASE64_ALPHABET.indexOf(clean[index + 1]);
    const c = clean[index + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(clean[index + 2]);
    const d = clean[index + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(clean[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('Invalid base64 payload.');
    const combined = (a << 18) | (b << 12) | (c << 6) | d;
    if (offset < output.length) output[offset++] = (combined >> 16) & 255;
    if (offset < output.length) output[offset++] = (combined >> 8) & 255;
    if (offset < output.length) output[offset++] = combined & 255;
  }
  return output;
}

export function splitMediaBytes(input: {
  manifest: MediaManifestPacket;
  bytes: Uint8Array;
}): MediaChunkPacket[] {
  const chunks: MediaChunkPacket[] = [];
  const total = Math.ceil(input.bytes.byteLength / MEDIA_CHUNK_BYTES);
  for (let sequence = 0; sequence < total; sequence += 1) {
    const start = sequence * MEDIA_CHUNK_BYTES;
    const payload = input.bytes.slice(start, start + MEDIA_CHUNK_BYTES);
    chunks.push({
      version: 1,
      id: `${input.manifest.id}:chunk:${sequence}`,
      senderId: input.manifest.senderId,
      recipientId: input.manifest.recipientId,
      groupId: input.manifest.groupId,
      hops: input.manifest.hops,
      ttlHops: input.manifest.ttlHops,
      type: 'media-chunk',
      timestamp: input.manifest.timestamp,
      transferId: input.manifest.id,
      sequence,
      total,
      payload: bytesToBase64(payload),
    });
  }
  return chunks;
}

export function createIncomingTransfer(manifest: MediaManifestPacket): IncomingTransfer {
  return { manifest, chunks: new Map(), updatedAt: Date.now(), retries: 0 };
}

export function acceptMediaChunk(transfer: IncomingTransfer, packet: MediaChunkPacket) {
  if (
    packet.transferId !== transfer.manifest.id ||
    packet.senderId !== transfer.manifest.senderId ||
    packet.recipientId !== transfer.manifest.recipientId ||
    packet.total !== transfer.manifest.chunkCount ||
    packet.sequence < 0 ||
    packet.sequence >= packet.total
  ) {
    return false;
  }
  transfer.chunks.set(packet.sequence, base64ToBytes(packet.payload));
  transfer.updatedAt = Date.now();
  return true;
}

export function missingMediaChunks(transfer: IncomingTransfer) {
  const missing: number[] = [];
  for (let index = 0; index < transfer.manifest.chunkCount; index += 1) {
    if (!transfer.chunks.has(index)) missing.push(index);
  }
  return missing;
}

export function assembleMediaBytes(transfer: IncomingTransfer) {
  const missing = missingMediaChunks(transfer);
  if (missing.length) throw new Error(`Missing ${missing.length} media chunks.`);
  const output = new Uint8Array(transfer.manifest.byteLength);
  let offset = 0;
  for (let index = 0; index < transfer.manifest.chunkCount; index += 1) {
    const chunk = transfer.chunks.get(index);
    if (!chunk) throw new Error(`Missing media chunk ${index}.`);
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== transfer.manifest.byteLength) throw new Error('Media size did not match manifest.');
  return output;
}

function packetBaseIsValid(value: Partial<Packet>) {
  return (
    value.version === 1 &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.senderId === 'string' &&
    typeof value.recipientId === 'string' &&
    typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)
  );
}

export function isPacket(value: unknown): value is Packet {
  if (!value || typeof value !== 'object') return false;
  const packet = value as Partial<Packet>;
  if (!packetBaseIsValid(packet) || typeof packet.type !== 'string') return false;
  switch (packet.type) {
    case 'text':
      return typeof packet.payload === 'string';
    case 'media-manifest':
      return (
        (packet.mediaKind === 'image' || packet.mediaKind === 'audio') &&
        typeof packet.mimeType === 'string' &&
        typeof packet.byteLength === 'number' &&
        Number.isInteger(packet.byteLength) && packet.byteLength > 0 && packet.byteLength <= 1024 * 1024 &&
        typeof packet.chunkCount === 'number' &&
        Number.isInteger(packet.chunkCount) &&
        packet.chunkCount > 0 && packet.chunkCount <= 512 &&
        typeof packet.hash === 'string'
      );
    case 'media-chunk':
      return (
        typeof packet.transferId === 'string' &&
        typeof packet.sequence === 'number' && Number.isInteger(packet.sequence) &&
        typeof packet.total === 'number' && Number.isInteger(packet.total) &&
        packet.total > 0 && packet.total <= 512 && packet.sequence >= 0 && packet.sequence < packet.total &&
        typeof packet.payload === 'string' && packet.payload.length <= 2732 &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(packet.payload)
      );
    case 'media-ack':
      return typeof packet.transferId === 'string';
    case 'media-retry':
      return (
        typeof packet.transferId === 'string' &&
        Array.isArray(packet.missing) && packet.missing.length <= 512 &&
        packet.missing.every((item) => Number.isInteger(item) && item >= 0 && item < 512)
      );
    case 'alert':
      return (
        typeof packet.body === 'string' &&
        packet.body.length > 0 &&
        (packet.severity === 'INFO' ||
          packet.severity === 'HELP' ||
          packet.severity === 'DANGER')
      );
    case 'group-sync':
      return (
        typeof packet.groupId === 'string' &&
        packet.groupId.length > 0 &&
        typeof packet.name === 'string' &&
        packet.name.trim().length > 0 &&
        Array.isArray((packet as { members?: unknown }).members) &&
        (packet as { members: unknown[] }).members.length > 0 &&
        (packet as { members: unknown[] }).members.every((member) => {
          if (!member || typeof member !== 'object') return false;
          const entry = member as { id?: unknown; name?: unknown };
          return typeof entry.id === 'string' && entry.id.length > 0 && typeof entry.name === 'string';
        })
      );
    case 'game':
      return (
        (packet.gameId === 'mesh-ping' ||
          packet.gameId === 'pong' ||
          packet.gameId === 'telephone' ||
          packet.gameId === 'chess') &&
        (packet.event === 'invite' ||
          packet.event === 'join' ||
          packet.event === 'leave' ||
          packet.event === 'ping' ||
          packet.event === 'pong' ||
          packet.event === 'baton' ||
          packet.event === 'round-start' ||
          packet.event === 'stroke' ||
          packet.event === 'round-finish' ||
          packet.event === 'pong-start' ||
          packet.event === 'pong-input' ||
          packet.event === 'pong-state' ||
          packet.event === 'telephone-prompt' ||
          packet.event === 'telephone-drawing' ||
          packet.event === 'telephone-guess' ||
          packet.event === 'chess-start' ||
          packet.event === 'chess-move' ||
          packet.event === 'chess-resign') &&
        (packet.roundId === undefined || typeof packet.roundId === 'string') &&
        (packet.targetId === undefined || typeof packet.targetId === 'string') &&
        (packet.sequence === undefined ||
          (Number.isInteger(packet.sequence) && packet.sequence >= 0)) &&
        (packet.payload === undefined ||
          (typeof packet.payload === 'string' && packet.payload.length <= 8_000))
      );
    default:
      return false;
  }
}
