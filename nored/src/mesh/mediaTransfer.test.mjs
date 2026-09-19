import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  acceptMediaChunk,
  assembleMediaBytes,
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
