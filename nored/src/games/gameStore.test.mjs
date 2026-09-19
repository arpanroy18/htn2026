import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  advancePong,
  appendTelephoneEntry,
  appendStroke,
  assignedTelephoneChain,
  applyPongState,
  createTelephoneGame,
  createPongMatch,
  decodeDrawing,
  decodeStroke,
  encodeDrawing,
  encodePongState,
  encodeStroke,
  nextTelephoneMode,
  makeGamePacket,
} from './gameStore.ts';
import {
  applyChessMove,
  INITIAL_CHESS_FEN,
  legalTargets,
} from './chessGame.ts';

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

describe('draw-and-guess telephone', () => {
  it('round-trips multiple compact strokes and alternates turns', () => {
    const strokes = [
      [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      [{ x: 30, y: 40 }, { x: 50, y: 60 }],
    ];
    assert.deepEqual(decodeDrawing(encodeDrawing(strokes)), strokes);
    assert.equal(nextTelephoneMode(0, 4), 'prompt');
    assert.equal(nextTelephoneMode(1, 4), 'draw');
    assert.equal(nextTelephoneMode(2, 4), 'guess');
    assert.equal(nextTelephoneMode(3, 4), 'draw');
    assert.equal(nextTelephoneMode(4, 4), 'finished');
  });

  it('rotates every chain through every player before reveal', () => {
    const players = ['a', 'b', 'c'];
    let game = createTelephoneGame('round-1', players);

    for (const player of players) {
      game = appendTelephoneEntry(game, {
        authorId: player,
        chainId: assignedTelephoneChain(game, player),
        round: 0,
        entry: { kind: 'prompt', text: `Prompt ${player}` },
      });
    }
    assert.equal(game.roundIndex, 1);
    assert.equal(game.mode, 'draw');
    assert.equal(assignedTelephoneChain(game, 'a'), 'c');

    for (const player of players) {
      game = appendTelephoneEntry(game, {
        authorId: player,
        chainId: assignedTelephoneChain(game, player),
        round: 1,
        entry: {
          kind: 'drawing',
          strokes: [[{ x: 0, y: 0 }, { x: 10, y: 10 }]],
        },
      });
    }
    assert.equal(game.roundIndex, 2);
    assert.equal(game.mode, 'guess');

    for (const player of players) {
      game = appendTelephoneEntry(game, {
        authorId: player,
        chainId: assignedTelephoneChain(game, player),
        round: 2,
        entry: { kind: 'guess', text: `Guess ${player}` },
      });
    }
    assert.equal(game.mode, 'finished');
    assert.deepEqual(
      game.chains.a.map((entry) => entry.authorId),
      ['a', 'b', 'c'],
    );
  });
});

describe('pong simulation', () => {
  it('moves the ball and awards a point when it leaves the court', () => {
    const match = createPongMatch('host', 'guest');
    const moved = advancePong(match, 0.1);
    assert.ok(moved.ballX > match.ballX);

    const scored = advancePong(
      { ...match, ballX: 0.99, velocityX: 1, leftScore: 4 },
      0.1,
    );
    assert.equal(scored.leftScore, 5);
    assert.equal(scored.winnerId, 'host');
    assert.equal(scored.running, false);
  });

  it('round-trips compact match snapshots', () => {
    const match = createPongMatch('host', 'guest');
    const encoded = encodePongState({ ...match, ballX: 0.31, leftScore: 2 });
    const next = applyPongState(match, encoded);
    assert.ok(next);
    assert.equal(next.ballX, 0.31);
    assert.equal(next.leftScore, 2);
    assert.equal(next.hostId, 'host');
  });
});

describe('standard chess rules', () => {
  it('validates legal targets and rejects illegal moves', () => {
    assert.deepEqual(legalTargets(INITIAL_CHESS_FEN, 'e2').sort(), ['e3', 'e4']);
    const match = {
      id: 'chess-1',
      whiteId: 'white',
      blackId: 'black',
      fen: INITIAL_CHESS_FEN,
      status: 'playing',
    };
    assert.equal(applyChessMove(match, { from: 'e2', to: 'e5' }), undefined);
    const next = applyChessMove(match, { from: 'e2', to: 'e4' });
    assert.ok(next);
    assert.equal(next.lastMove.from, 'e2');
    assert.equal(next.lastMove.to, 'e4');
  });

});
