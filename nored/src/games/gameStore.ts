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

export const GAME_ROOM_ID = 'nored-game-room';
export const MAX_STROKE_POINTS = 24;

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
