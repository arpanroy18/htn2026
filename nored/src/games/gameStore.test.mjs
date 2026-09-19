import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appendStroke,
  decodeStroke,
  encodeStroke,
  makeGamePacket,
} from './gameStore.ts';

describe('drawing telephone strokes', () => {
  it('encodes normalized points compactly and safely decodes them', () => {
    const encoded = encodeStroke([
      { x: 1.4, y: 2.6 },
      { x: 50, y: 75 },
      { x: 99.8, y: 100 },
    ]);

    assert.equal(encoded, '1,3;50,75;100,100');
    assert.deepEqual(decodeStroke(encoded), [
      { x: 1, y: 3 },
      { x: 50, y: 75 },
      { x: 100, y: 100 },
    ]);
    assert.deepEqual(decodeStroke('-1,2;hello;10,101;20,30'), [{ x: 20, y: 30 }]);
  });

  it('only accepts the expected player and turn sequence', () => {
    const round = {
      id: 'round-1',
      playerIds: ['a', 'b'],
      turnIndex: 0,
      strokes: [],
      finished: false,
    };
    const packet = makeGamePacket({
      senderId: 'a',
      gameId: 'telephone',
      event: 'stroke',
      roundId: 'round-1',
      sequence: 0,
      payload: '0,0;50,50',
    });

    const next = appendStroke(round, packet);
    assert.equal(next.turnIndex, 1);
    assert.equal(next.strokes.length, 1);
    assert.equal(next.finished, false);
    assert.equal(appendStroke(next, packet), next);
    assert.equal(appendStroke(round, { ...packet, senderId: 'b' }), round);

    const finished = appendStroke(next, {
      ...packet,
      id: 'stroke-2',
      senderId: 'b',
      sequence: 1,
    });
    assert.equal(finished.finished, true);
    assert.equal(finished.strokes.length, 2);
  });
});
