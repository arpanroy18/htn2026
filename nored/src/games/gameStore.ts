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
  | { kind: 'prompt'; authorId: string; round: number; text: string }
  | { kind: 'drawing'; authorId: string; round: number; strokes: DrawingPoint[][] }
  | { kind: 'guess'; authorId: string; round: number; text: string };

export type TelephoneEntryDraft =
  | { kind: 'prompt'; text: string }
  | { kind: 'drawing'; strokes: DrawingPoint[][] }
  | { kind: 'guess'; text: string };

export type TelephoneChain = {
  id: string;
  playerIds: string[];
  roundIndex: number;
  mode: 'prompt' | 'draw' | 'guess' | 'finished';
  chains: Record<string, TelephoneEntry[]>;
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
export const MAX_STROKE_POINTS = 80;
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
  roundIndex: number,
  playerCount: number,
): TelephoneChain['mode'] {
  if (roundIndex >= playerCount) return 'finished';
  if (roundIndex === 0) return 'prompt';
  return roundIndex % 2 === 1 ? 'draw' : 'guess';
}

export function createTelephoneGame(id: string, playerIds: string[]): TelephoneChain {
  return {
    id,
    playerIds,
    roundIndex: 0,
    mode: 'prompt',
    chains: Object.fromEntries(playerIds.map((playerId) => [playerId, []])),
  };
}

export function assignedTelephoneChain(game: TelephoneChain, playerId: string) {
  const playerIndex = game.playerIds.indexOf(playerId);
  if (playerIndex < 0) return undefined;
  const chainIndex =
    (playerIndex - game.roundIndex + game.playerIds.length) % game.playerIds.length;
  return game.playerIds[chainIndex];
}

export function telephoneRoundSubmissions(game: TelephoneChain) {
  return Object.values(game.chains).reduce(
    (count, entries) =>
      count + (entries.some((entry) => entry.round === game.roundIndex) ? 1 : 0),
    0,
  );
}

export function appendTelephoneEntry(
  game: TelephoneChain,
  input: {
    chainId: string;
    authorId: string;
    round: number;
    entry: TelephoneEntryDraft;
  },
): TelephoneChain {
  if (
    game.mode === 'finished' ||
    input.round !== game.roundIndex ||
    assignedTelephoneChain(game, input.authorId) !== input.chainId ||
    !game.chains[input.chainId] ||
    game.chains[input.chainId].some((entry) => entry.round === input.round)
  ) {
    return game;
  }
  const expectedKind =
    game.mode === 'prompt' ? 'prompt' : game.mode === 'draw' ? 'drawing' : 'guess';
  if (input.entry.kind !== expectedKind) return game;
  const entry = {
    ...input.entry,
    authorId: input.authorId,
    round: input.round,
  } as TelephoneEntry;
  const next: TelephoneChain = {
    ...game,
    chains: {
      ...game.chains,
      [input.chainId]: [...game.chains[input.chainId], entry],
    },
  };
  const submissionCount = telephoneRoundSubmissions(next);
  if (submissionCount >= game.playerIds.length) {
    next.roundIndex = game.roundIndex + 1;
    next.mode = nextTelephoneMode(next.roundIndex, game.playerIds.length);
  }
  return next;
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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clampBallSpeed(velocityX: number, velocityY: number) {
  const maxSpeed = 0.92;
  const speed = Math.hypot(velocityX, velocityY);
  let nextX = velocityX;
  let nextY = velocityY;
  if (speed > maxSpeed && speed > 0) {
    nextX *= maxSpeed / speed;
    nextY *= maxSpeed / speed;
  }
  if (Math.abs(nextX) < 0.28) {
    nextX = (nextX < 0 ? -1 : 1) * 0.28;
  }
  return { velocityX: nextX, velocityY: clamp(nextY, -0.72, 0.72) };
}

function stepPong(match: PongMatch, seconds: number): PongMatch {
  let ballX = match.ballX + match.velocityX * seconds;
  let ballY = match.ballY + match.velocityY * seconds;
  let velocityX = match.velocityX;
  let velocityY = match.velocityY;
  let leftScore = match.leftScore;
  let rightScore = match.rightScore;

  if (ballY <= 0.03 || ballY >= 0.97) {
    ballY = clamp(ballY, 0.03, 0.97);
    velocityY *= -1;
  }

  const paddleHalf = 0.14;
  if (
    velocityX < 0 &&
    ballX <= 0.08 &&
    ballX >= 0.02 &&
    Math.abs(ballY - match.leftY) <= paddleHalf
  ) {
    ballX = 0.08;
    velocityX = Math.abs(velocityX) * 1.03;
    velocityY += (ballY - match.leftY) * 0.8;
  } else if (
    velocityX > 0 &&
    ballX >= 0.92 &&
    ballX <= 0.98 &&
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

  const speed = clampBallSpeed(velocityX, velocityY);
  const winnerId =
    leftScore >= 5 ? match.hostId : rightScore >= 5 ? match.guestId : undefined;
  return {
    ...match,
    ballX,
    ballY,
    velocityX: speed.velocityX,
    velocityY: speed.velocityY,
    leftScore,
    rightScore,
    running: !winnerId,
    winnerId,
  };
}

export function advancePong(match: PongMatch, seconds: number): PongMatch {
  if (!match.running) return match;
  const dt = clamp(seconds, 0, 0.05);
  const steps = dt > 0.018 ? 2 : 1;
  const step = dt / steps;
  let current = match;
  for (let index = 0; index < steps; index += 1) {
    current = stepPong(current, step);
    if (!current.running) break;
  }
  return current;
}

export function encodePongState(match: PongMatch) {
  return [
    match.ballX.toFixed(3),
    match.ballY.toFixed(3),
    match.velocityX.toFixed(3),
    match.velocityY.toFixed(3),
    match.leftY.toFixed(3),
    match.rightY.toFixed(3),
    String(match.leftScore),
    String(match.rightScore),
    match.running ? '1' : '0',
  ].join(',');
}

export function applyPongState(match: PongMatch, payload?: string): PongMatch | undefined {
  if (!payload) return undefined;
  if (payload.startsWith('{')) {
    try {
      const next = JSON.parse(payload) as PongMatch;
      return next.id === match.id ? next : undefined;
    } catch {
      return undefined;
    }
  }
  const parts = payload.split(',');
  if (parts.length !== 9) return undefined;
  const values = parts.map(Number);
  if (values.some((value) => !Number.isFinite(value))) return undefined;
  const [
    ballX,
    ballY,
    velocityX,
    velocityY,
    leftY,
    rightY,
    leftScore,
    rightScore,
    runningFlag,
  ] = values;
  const winnerId =
    leftScore >= 5 ? match.hostId : rightScore >= 5 ? match.guestId : undefined;
  return {
    ...match,
    ballX: clamp(ballX, -0.05, 1.05),
    ballY: clamp(ballY, 0, 1),
    velocityX,
    velocityY,
    leftY: clamp(leftY, 0.14, 0.86),
    rightY: clamp(rightY, 0.14, 0.86),
    leftScore,
    rightScore,
    running: runningFlag === 1 && !winnerId,
    winnerId,
  };
}

export function pongScoreChanged(previous: PongMatch | undefined, next: PongMatch) {
  return (
    previous?.id !== next.id ||
    previous.leftScore !== next.leftScore ||
    previous.rightScore !== next.rightScore ||
    previous.running !== next.running ||
    previous.winnerId !== next.winnerId
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
