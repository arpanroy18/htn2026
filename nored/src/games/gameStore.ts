import type { GameEvent, GameId, GamePacket, Packet } from '@/transport';

export type GameParticipant = {
  id: string;
  name: string;
  lastSeen: number;
};

export type DrawingPoint = { x: number; y: number };

export type DrawingStroke = {
  id: string;
  senderId: string;
  points: DrawingPoint[];
  sequence: number;
};

export type TelephoneRound = {
  id: string;
  playerIds: string[];
  turnIndex: number;
  strokes: DrawingStroke[];
  finished: boolean;
};

export type TelephoneEntry =
  | { kind: 'prompt'; authorId: string; text: string }
  | { kind: 'drawing'; authorId: string; strokes: DrawingPoint[][] }
  | { kind: 'guess'; authorId: string; text: string };

export type TelephoneChain = {
  id: string;
  playerIds: string[];
  turnIndex: number;
  mode: 'prompt' | 'draw' | 'guess' | 'finished';
  entries: TelephoneEntry[];
};

export type PongMatch = {
  id: string;
  hostId: string;
  guestId: string;
  leftY: number;
  rightY: number;
  ballX: number;
  ballY: number;
  velocityX: number;
  velocityY: number;
  leftScore: number;
  rightScore: number;
  running: boolean;
  winnerId?: string;
};

export type ChessMatch = {
  id: string;
  whiteId: string;
  blackId: string;
  fen: string;
  status: 'playing' | 'checkmate' | 'draw' | 'resigned';
  winnerId?: string;
  lastMove?: { from: string; to: string; promotion?: string };
};

export const GAME_ROOM_ID = 'nored-game-room';
export const MAX_STROKE_POINTS = 24;
export const MAX_DRAWING_STROKES = 8;

function createGameId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

export function makeGamePacket(input: {
  senderId: string;
  recipientId?: string;
  gameId: GameId;
  event: GameEvent;
  roundId?: string;
  targetId?: string;
  sequence?: number;
  payload?: string;
}): GamePacket {
  return {
    version: 1,
    id: createGameId(),
    senderId: input.senderId,
    recipientId: input.recipientId ?? GAME_ROOM_ID,
    type: 'game',
    timestamp: Date.now(),
    gameId: input.gameId,
    event: input.event,
    roundId: input.roundId,
    targetId: input.targetId,
    sequence: input.sequence,
    payload: input.payload,
  };
}

export function isGamePacket(packet: Packet): packet is GamePacket {
  return packet.type === 'game';
}

export function participantPayload(name: string) {
  return name.trim().slice(0, 40);
}

export function encodeStroke(points: DrawingPoint[]) {
  return points
    .slice(0, MAX_STROKE_POINTS)
    .map(({ x, y }) => `${Math.round(x)},${Math.round(y)}`)
    .join(';');
}

export function decodeStroke(payload?: string): DrawingPoint[] {
  if (!payload) return [];
  return payload
    .split(';')
    .slice(0, MAX_STROKE_POINTS)
    .map((pair) => {
      const [x, y] = pair.split(',').map(Number);
      return { x, y };
    })
    .filter(
      ({ x, y }) =>
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        x >= 0 &&
        x <= 100 &&
        y >= 0 &&
        y <= 100,
    );
}

export function encodeDrawing(strokes: DrawingPoint[][]) {
  return strokes
    .slice(0, MAX_DRAWING_STROKES)
    .map(encodeStroke)
    .filter(Boolean)
    .join('|');
}

export function decodeDrawing(payload?: string) {
  if (!payload) return [];
  return payload
    .split('|')
    .slice(0, MAX_DRAWING_STROKES)
    .map(decodeStroke)
    .filter((stroke) => stroke.length >= 2);
}

export function nextTelephoneMode(
  turnIndex: number,
  playerCount: number,
): TelephoneChain['mode'] {
  if (turnIndex >= playerCount) return 'finished';
  if (turnIndex === 0) return 'prompt';
  return turnIndex % 2 === 1 ? 'draw' : 'guess';
}

export function createPongMatch(hostId: string, guestId: string): PongMatch {
  return {
    id: createGameId(),
    hostId,
    guestId,
    leftY: 0.5,
    rightY: 0.5,
    ballX: 0.5,
    ballY: 0.5,
    velocityX: 0.42,
    velocityY: 0.28,
    leftScore: 0,
    rightScore: 0,
    running: true,
  };
}

export function advancePong(match: PongMatch, seconds: number): PongMatch {
  if (!match.running) return match;
  let ballX = match.ballX + match.velocityX * seconds;
  let ballY = match.ballY + match.velocityY * seconds;
  let velocityX = match.velocityX;
  let velocityY = match.velocityY;
  let leftScore = match.leftScore;
  let rightScore = match.rightScore;

  if (ballY <= 0.03 || ballY >= 0.97) {
    ballY = Math.max(0.03, Math.min(0.97, ballY));
    velocityY *= -1;
  }

  const paddleHalf = 0.14;
  if (
    velocityX < 0 &&
    ballX <= 0.08 &&
    ballX >= 0.035 &&
    Math.abs(ballY - match.leftY) <= paddleHalf
  ) {
    ballX = 0.08;
    velocityX = Math.abs(velocityX) * 1.03;
    velocityY += (ballY - match.leftY) * 0.8;
  } else if (
    velocityX > 0 &&
    ballX >= 0.92 &&
    ballX <= 0.965 &&
    Math.abs(ballY - match.rightY) <= paddleHalf
  ) {
    ballX = 0.92;
    velocityX = -Math.abs(velocityX) * 1.03;
    velocityY += (ballY - match.rightY) * 0.8;
  }

  if (ballX < 0) {
    rightScore += 1;
    ballX = 0.5;
    ballY = 0.5;
    velocityX = -0.42;
    velocityY = 0.22;
  } else if (ballX > 1) {
    leftScore += 1;
    ballX = 0.5;
    ballY = 0.5;
    velocityX = 0.42;
    velocityY = -0.22;
  }

  const winnerId =
    leftScore >= 5 ? match.hostId : rightScore >= 5 ? match.guestId : undefined;
  return {
    ...match,
    ballX,
    ballY,
    velocityX,
    velocityY,
    leftScore,
    rightScore,
    running: !winnerId,
    winnerId,
  };
}

export function appendStroke(
  round: TelephoneRound,
  packet: GamePacket,
): TelephoneRound {
  if (
    packet.event !== 'stroke' ||
    packet.roundId !== round.id ||
    packet.sequence !== round.turnIndex ||
    round.playerIds[round.turnIndex] !== packet.senderId ||
    round.strokes.some((stroke) => stroke.id === packet.id)
  ) {
    return round;
  }
  const points = decodeStroke(packet.payload);
  if (points.length < 2) return round;
  const nextIndex = round.turnIndex + 1;
  return {
    ...round,
    turnIndex: nextIndex,
    finished: nextIndex >= round.playerIds.length,
    strokes: [
      ...round.strokes,
      {
        id: packet.id,
        senderId: packet.senderId,
        sequence: packet.sequence,
        points,
      },
    ],
  };
}
