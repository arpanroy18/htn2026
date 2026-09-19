import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import {
  acceptMediaChunk,
  assembleMediaBytes,
  base64ToBytes,
  bytesToBase64,
  createIncomingTransfer,
  isPacket,
  missingMediaChunks,
  splitMediaBytes,
} from './mediaTransfer.ts';

function manifest(overrides = {}) {
  return {
    version: 1,
    id: 'media-1',
    senderId: 'sender',
    recipientId: 'recipient',
    type: 'media-manifest',
    timestamp: 100,
    mediaKind: 'image',
    mimeType: 'image/jpeg',
    byteLength: 5000,
    chunkCount: 3,
    hash: 'abc123',
    width: 100,
    height: 80,
    ...overrides,
  };
}

describe('media packet validation', () => {
  it('accepts supported packet variants and rejects malformed packets', () => {
    assert.equal(isPacket(manifest()), true);
    assert.equal(
      isPacket({
        ...manifest(),
        id: 'retry',
        type: 'media-retry',
        transferId: 'media-1',
        missing: [1, 2],
      }),
      true,
    );
    assert.equal(
      isPacket({
        version: 1,
        id: 'sync-1',
        senderId: 'sender',
        recipientId: 'group-1',
        groupId: 'group-1',
        type: 'group-sync',
        timestamp: 100,
        name: 'Hallway Ops',
        members: [
          { id: 'sender', name: 'Ada' },
          { id: 'recipient', name: 'Taylor' },
        ],
      }),
      true,
    );
    assert.equal(
      isPacket({
        version: 1,
        id: 'game-1',
        senderId: 'sender',
        recipientId: 'recipient',
        timestamp: 100,
        type: 'game',
        gameId: 'mesh-ping',
        event: 'ping',
        targetId: 'recipient',
      }),
      true,
    );
    assert.equal(
      isPacket({
        version: 1,
        id: 'game-2',
        senderId: 'sender',
        recipientId: 'recipient',
        timestamp: 100,
        type: 'game',
        gameId: 'telephone',
        event: 'stroke',
        payload: 'x'.repeat(8001),
      }),
      false,
    );
    assert.equal(isPacket({ ...manifest(), chunkCount: 0 }), false);
    assert.equal(isPacket({ ...manifest(), type: 'unknown' }), false);
  });
});

describe('media base64 codec', () => {
  it('round-trips every payload length and matches Node for high bytes', () => {
    for (let length = 0; length <= 130; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + length) % 256);
      const encoded = bytesToBase64(bytes);
      assert.equal(encoded, Buffer.from(bytes).toString('base64'), `encode length ${length}`);
      assert.deepEqual(base64ToBytes(encoded), bytes, `round-trip length ${length}`);
    }
  });

  it('decodes payloads whose padding or whitespace was lost in transit', () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    const encoded = bytesToBase64(bytes);
    assert.ok(encoded.endsWith('='));
    assert.deepEqual(base64ToBytes(encoded.replace(/=+$/, '')), bytes);
    assert.deepEqual(base64ToBytes(`${encoded.slice(0, 4)}\n ${encoded.slice(4)}`), bytes);
  });

  it('rejects characters outside the base64 alphabet', () => {
    assert.throws(() => base64ToBytes('AAA*'), /Invalid base64 payload/);
    assert.throws(() => base64ToBytes('AA!A'), /Invalid base64 payload/);
  });
});

describe('media transfer chunking', () => {
  it('reassembles duplicate and out-of-order chunks without corrupting bytes', () => {
    const bytes = Uint8Array.from({ length: 5000 }, (_, index) => index % 251);
    const packet = manifest();
    const chunks = splitMediaBytes({ manifest: packet, bytes });
    const transfer = createIncomingTransfer(packet);

    assert.equal(chunks.length, 3);
    assert.equal(acceptMediaChunk(transfer, chunks[2]), true);
    assert.equal(acceptMediaChunk(transfer, chunks[0]), true);
    assert.deepEqual(missingMediaChunks(transfer), [1]);
    assert.equal(acceptMediaChunk(transfer, chunks[0]), true);
    assert.equal(acceptMediaChunk(transfer, chunks[1]), true);
    assert.deepEqual(assembleMediaBytes(transfer), bytes);
  });

  it('rejects chunks for another transfer and reports missing sequences', () => {
    const bytes = new Uint8Array(5000);
    const packet = manifest();
    const chunks = splitMediaBytes({ manifest: packet, bytes });
    const transfer = createIncomingTransfer(packet);

    assert.equal(
      acceptMediaChunk(transfer, { ...chunks[0], transferId: 'other' }),
      false,
    );
    assert.deepEqual(missingMediaChunks(transfer), [0, 1, 2]);
    assert.throws(() => assembleMediaBytes(transfer), /Missing 3 media chunks/);
  });

  it('detects a manifest size mismatch', () => {
    const bytes = new Uint8Array(16);
    const packet = manifest({ byteLength: 17, chunkCount: 1 });
    const [chunk] = splitMediaBytes({ manifest: packet, bytes });
    const transfer = createIncomingTransfer(packet);
    acceptMediaChunk(transfer, chunk);
    assert.throws(() => assembleMediaBytes(transfer), /size did not match/);
  });
});
