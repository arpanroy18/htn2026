import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { peerName } from '@/mesh/chatStore';
import { useMeshUi } from '@/mesh/MeshUiContext';
import { useRouterService } from '@/mesh/RouterContext';
import {
  type GameId,
  type GamePacket,
  type Packet,
} from '@/transport';

import {
  advancePong,
  appendTelephoneEntry,
  appendStroke,
  applyPongState,
  assignedTelephoneChain,
  createTelephoneGame,
  createPongMatch,
  decodeDrawing,
  encodeDrawing,
  encodePongState,
  encodeStroke,
  isGamePacket,
  makeGamePacket,
  participantPayload,
  pongScoreChanged,
  type ChessMatch,
  type DrawingPoint,
  type GameParticipant,
  type PongMatch,
  type TelephoneChain,
  type TelephoneRound,
} from './gameStore';
import { clearPongFrame, emitPongFrame } from './pongRuntime';
import {
  applyChessMove,
  chessColorForPlayer,
  INITIAL_CHESS_FEN,
  playerCanMove,
} from './chessGame';

type ActionResult = { ok: true } | { ok: false; error: string };

type PingResult = {
  peerId: string;
  rttMs: number;
  measuredAt: number;
  attempts: number;
};

export type GameInvitation = {
  id: string;
  gameId: GameId;
  fromId: string;
  fromName: string;
};

type GameUi = {
  joinedGames: Record<GameId, boolean>;
  participants: Record<GameId, GameParticipant[]>;
  pingResults: Record<string, PingResult>;
  batonHolderId?: string;
  telephoneRound?: TelephoneRound;
  pongMatch?: PongMatch;
  telephoneChain?: TelephoneChain;
  chessMatch?: ChessMatch;
  pendingInvite?: GameInvitation;
  joinGame: (gameId: GameId, notifyPeerId?: string) => Promise<ActionResult>;
  leaveGame: (gameId: GameId) => Promise<void>;
  invitePlayer: (gameId: GameId, peerId: string) => Promise<ActionResult>;
  acceptInvite: () => Promise<ActionResult>;
  dismissInvite: () => void;
  startPong: () => Promise<ActionResult>;
  movePongPaddle: (position: number) => void;
  startTelephoneChain: () => Promise<ActionResult>;
  submitTelephonePrompt: (text: string) => Promise<ActionResult>;
  submitTelephoneDrawing: (strokes: DrawingPoint[][]) => Promise<ActionResult>;
  submitTelephoneGuess: (text: string) => Promise<ActionResult>;
  startChess: () => Promise<ActionResult>;
  moveChess: (from: string, to: string, promotion?: string) => Promise<ActionResult>;
  resignChess: () => Promise<ActionResult>;
  pingPeer: (peerId: string) => Promise<ActionResult>;
  passBaton: (peerId: string) => Promise<ActionResult>;
  startTelephoneRound: () => Promise<ActionResult>;
  submitStroke: (points: DrawingPoint[]) => Promise<ActionResult>;
};

const GameContext = createContext<GameUi | null>(null);

const emptyJoined: Record<GameId, boolean> = {
  'mesh-ping': false,
  pong: false,
  telephone: false,
  chess: false,
};

const emptyParticipants: Record<GameId, GameParticipant[]> = {
  'mesh-ping': [],
  pong: [],
  telephone: [],
  chess: [],
};

export function GameProvider({ children }: { children: ReactNode }) {
  const { identity, noredPeers, visibleNoredPeers, peers } = useMeshUi();
  const meshRouter = useRouterService();
  const [joinedGames, setJoinedGames] = useState(emptyJoined);
  const [participants, setParticipants] = useState(emptyParticipants);
  const [pingResults, setPingResults] = useState<Record<string, PingResult>>({});
  const [batonHolderId, setBatonHolderId] = useState<string>();
  const [telephoneRound, setTelephoneRound] = useState<TelephoneRound>();
  const [pongMatch, setPongMatch] = useState<PongMatch>();
  const [telephoneChain, setTelephoneChain] = useState<TelephoneChain>();
  const [chessMatch, setChessMatch] = useState<ChessMatch>();
  const [pendingInvite, setPendingInvite] = useState<GameInvitation>();
  const joinedRef = useRef(joinedGames);
  const peersRef = useRef(peers);
  const noredPeersRef = useRef(noredPeers);
  const visibleNoredPeersRef = useRef(visibleNoredPeers);
  const participantsRef = useRef(participants);
  const telephoneRoundRef = useRef(telephoneRound);
  const pongMatchRef = useRef(pongMatch);
  const telephoneChainRef = useRef(telephoneChain);
  const chessMatchRef = useRef(chessMatch);
  const pendingPings = useRef(new Map<string, { peerId: string; startedAt: number }>());
  const lastPongInputAt = useRef(0);
  const lastSentPaddleY = useRef(-1);

  useEffect(() => {
    joinedRef.current = joinedGames;
  }, [joinedGames]);

  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);

  useEffect(() => {
    noredPeersRef.current = noredPeers;
  }, [noredPeers]);

  useEffect(() => {
    visibleNoredPeersRef.current = visibleNoredPeers;
  }, [visibleNoredPeers]);

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  useEffect(() => {
    telephoneRoundRef.current = telephoneRound;
  }, [telephoneRound]);

  useEffect(() => {
    pongMatchRef.current = pongMatch;
  }, [pongMatch]);

  useEffect(() => {
    telephoneChainRef.current = telephoneChain;
  }, [telephoneChain]);

  useEffect(() => {
    chessMatchRef.current = chessMatch;
  }, [chessMatch]);

  const upsertParticipant = useCallback(
    (gameId: GameId, id: string, name?: string) => {
      const participant: GameParticipant = {
        id,
        name: name?.trim() || peerName(peersRef.current, id, 'Nearby player'),
        lastSeen: Date.now(),
      };
      setParticipants((current) => {
        const existing = current[gameId].findIndex((item) => item.id === id);
        const next = current[gameId].slice();
        if (existing >= 0) next[existing] = participant;
        else next.push(participant);
        return { ...current, [gameId]: next };
      });
    },
    [],
  );

  const sendToPeers = useCallback(async (packet: GamePacket, peerIds?: string[]) => {
    const allowed = new Set(
      visibleNoredPeersRef.current
        .filter((peer) => peer.identityConfirmed)
        .map((peer) => peer.id),
    );
    const requested = peerIds ?? [...allowed];
    const targets = requested.filter((id) => allowed.has(id) && meshRouter.hasSession(id));
    if (targets.length === 0) return false;
    const settled = await Promise.allSettled(
      targets.map((peerId) =>
        meshRouter.sendDirect(peerId, { ...packet, recipientId: peerId }),
      ),
    );
    return settled.some((result) => result.status === 'fulfilled');
  }, [meshRouter]);

  useEffect(() => {
    let frame = 0;
    let lastTime = 0;
    let lastSend = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const current = pongMatchRef.current;
      if (!current?.running) {
        lastTime = 0;
        return;
      }
      if (!lastTime) lastTime = now;
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;
      const next = advancePong(current, dt);
      pongMatchRef.current = next;
      emitPongFrame(next);
      if (pongScoreChanged(current, next)) setPongMatch(next);
      if (current.hostId === identity.id && now - lastSend >= 180) {
        lastSend = now;
        const packet = makeGamePacket({
          senderId: identity.id,
          recipientId: next.guestId,
          gameId: 'pong',
          event: 'pong-state',
          roundId: next.id,
          payload: encodePongState(next),
        });
        void sendToPeers(packet, [next.guestId]);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [identity.id, sendToPeers]);

  useEffect(() => {
    const subscription = meshRouter.onApplicationPacket((packet: Packet) => {
      if (!isGamePacket(packet) || packet.senderId === identity.id) return;

      if (packet.event === 'invite') {
        if (packet.targetId !== identity.id) return;
        setPendingInvite({
          id: packet.id,
          gameId: packet.gameId,
          fromId: packet.senderId,
          fromName:
            packet.payload?.trim() ||
            peerName(peersRef.current, packet.senderId, 'A nearby player'),
        });
        return;
      }

      if (packet.event === 'join') {
        upsertParticipant(packet.gameId, packet.senderId, packet.payload);
        if (joinedRef.current[packet.gameId]) {
          const reply = makeGamePacket({
            senderId: identity.id,
            recipientId: packet.senderId,
            gameId: packet.gameId,
            event: 'join',
            payload: participantPayload(identity.name),
          });
          void sendToPeers(reply, [packet.senderId]);
        }
        return;
      }

      if (packet.event === 'leave') {
        setParticipants((current) => ({
          ...current,
          [packet.gameId]: current[packet.gameId].filter(
            (participant) => participant.id !== packet.senderId,
          ),
        }));
        return;
      }

      if (!joinedRef.current[packet.gameId]) return;
      if (packet.event !== 'pong-state' && packet.event !== 'pong-input') {
        upsertParticipant(packet.gameId, packet.senderId);
      }

      if (packet.gameId === 'pong') {
        if (packet.event === 'pong-start' && packet.payload) {
          try {
            const next = JSON.parse(packet.payload) as PongMatch;
            if (
              next.hostId === packet.senderId &&
              next.guestId === identity.id &&
              next.id === packet.roundId
            ) {
              pongMatchRef.current = next;
              lastSentPaddleY.current = next.rightY;
              setPongMatch(next);
              emitPongFrame(next);
            }
          } catch {
            // Ignore malformed match data.
          }
        } else if (
          packet.event === 'pong-input' &&
          pongMatchRef.current?.hostId === identity.id &&
          pongMatchRef.current.guestId === packet.senderId
        ) {
          const position = Number(packet.payload);
          if (Number.isFinite(position)) {
            const current = pongMatchRef.current;
            const next = {
              ...current,
              rightY: Math.max(0.14, Math.min(0.86, position)),
            };
            pongMatchRef.current = next;
            emitPongFrame(next);
          }
        } else if (
          packet.event === 'pong-state' &&
          pongMatchRef.current?.guestId === identity.id &&
          packet.senderId === pongMatchRef.current.hostId &&
          packet.payload
        ) {
          const local = pongMatchRef.current;
          const remote = applyPongState(local, packet.payload);
          if (remote && remote.id === local.id) {
            const dx = remote.ballX - local.ballX;
            const dy = remote.ballY - local.ballY;
            const close = dx * dx + dy * dy < 0.012;
            const next: PongMatch = {
              ...remote,
              rightY: local.rightY,
              ballX: close ? local.ballX + dx * 0.45 : remote.ballX,
              ballY: close ? local.ballY + dy * 0.45 : remote.ballY,
            };
            pongMatchRef.current = next;
            emitPongFrame(next);
            if (pongScoreChanged(local, next)) setPongMatch(next);
          }
        }
        return;
      }

      if (packet.gameId === 'telephone') {
        if (packet.event === 'round-start' && packet.roundId && packet.payload) {
          try {
            const playerIds = JSON.parse(packet.payload);
            if (
              Array.isArray(playerIds) &&
              playerIds.length >= 3 &&
              playerIds.length <= 8 &&
              playerIds.every((id) => typeof id === 'string') &&
              playerIds.includes(identity.id)
            ) {
              const next = createTelephoneGame(packet.roundId, playerIds);
              telephoneChainRef.current = next;
              setTelephoneChain(next);
            }
          } catch {
            // Ignore malformed round data.
          }
          return;
        }

        setTelephoneChain((current) => {
          if (
            !current ||
            current.id !== packet.roundId ||
            typeof packet.sequence !== 'number' ||
            !packet.targetId
          ) {
            return current;
          }
          let entry;
          if (packet.event === 'telephone-prompt' && current.mode === 'prompt') {
            const text = packet.payload?.trim().slice(0, 80);
            if (!text) return current;
            entry = { kind: 'prompt' as const, text };
          } else if (packet.event === 'telephone-drawing' && current.mode === 'draw') {
            const strokes = decodeDrawing(packet.payload);
            if (!strokes.length) return current;
            entry = { kind: 'drawing' as const, strokes };
          } else if (packet.event === 'telephone-guess' && current.mode === 'guess') {
            const text = packet.payload?.trim().slice(0, 80);
            if (!text) return current;
            entry = { kind: 'guess' as const, text };
          } else {
            return current;
          }
          const next = appendTelephoneEntry(current, {
            authorId: packet.senderId,
            chainId: packet.targetId,
            round: packet.sequence,
            entry,
          });
          telephoneChainRef.current = next;
          return next;
        });
        return;
      }

      if (packet.gameId === 'chess') {
        if (packet.event === 'chess-start' && packet.payload) {
          try {
            const next = JSON.parse(packet.payload) as ChessMatch;
            if (
              next.whiteId === packet.senderId &&
              next.blackId === identity.id &&
              next.fen === INITIAL_CHESS_FEN
            ) {
              chessMatchRef.current = next;
              setChessMatch(next);
            }
          } catch {
            // Ignore malformed match data.
          }
        } else if (
          packet.event === 'chess-move' &&
          packet.payload &&
          chessMatchRef.current &&
          packet.roundId === chessMatchRef.current.id
        ) {
          try {
            const move = JSON.parse(packet.payload) as {
              from: string;
              to: string;
              promotion?: string;
            };
            const current = chessMatchRef.current;
            const senderColor = chessColorForPlayer(current, packet.senderId);
            if (!senderColor || !playerCanMove(current, packet.senderId)) return;
            const next = applyChessMove(current, move);
            if (next) {
              chessMatchRef.current = next;
              setChessMatch(next);
            }
          } catch {
            // Ignore malformed moves.
          }
        } else if (
          packet.event === 'chess-resign' &&
          chessMatchRef.current &&
          packet.roundId === chessMatchRef.current.id &&
          chessColorForPlayer(chessMatchRef.current, packet.senderId)
        ) {
          const current = chessMatchRef.current;
          const next: ChessMatch = {
            ...current,
            status: 'resigned',
            winnerId:
              packet.senderId === current.whiteId ? current.blackId : current.whiteId,
          };
          chessMatchRef.current = next;
          setChessMatch(next);
        }
        return;
      }

      if (packet.gameId === 'mesh-ping') {
        if (packet.event === 'ping' && packet.targetId === identity.id) {
          const pong = makeGamePacket({
            senderId: identity.id,
            recipientId: packet.senderId,
            gameId: 'mesh-ping',
            event: 'pong',
            targetId: packet.senderId,
            payload: packet.id,
          });
          void sendToPeers(pong, [packet.senderId]);
        } else if (
          packet.event === 'pong' &&
          packet.targetId === identity.id &&
          packet.payload
        ) {
          const pending = pendingPings.current.get(packet.payload);
          if (!pending || pending.peerId !== packet.senderId) return;
          pendingPings.current.delete(packet.payload);
          const rttMs = Date.now() - pending.startedAt;
          setPingResults((current) => ({
            ...current,
            [packet.senderId]: {
              peerId: packet.senderId,
              rttMs,
              measuredAt: Date.now(),
              attempts: (current[packet.senderId]?.attempts ?? 0) + 1,
            },
          }));
        } else if (packet.event === 'baton' && packet.targetId) {
          setBatonHolderId(packet.targetId);
        }
        return;
      }

      if (packet.event === 'round-start' && packet.roundId && packet.payload) {
        try {
          const playerIds = JSON.parse(packet.payload);
          if (
            Array.isArray(playerIds) &&
            playerIds.length >= 2 &&
            playerIds.length <= 8 &&
            playerIds.every((id) => typeof id === 'string')
          ) {
            setTelephoneRound({
              id: packet.roundId,
              playerIds,
              turnIndex: 0,
              strokes: [],
              finished: false,
            });
          }
        } catch {
          // Ignore malformed round data.
        }
      } else if (packet.event === 'stroke' && telephoneRoundRef.current) {
        setTelephoneRound((current) => (current ? appendStroke(current, packet) : current));
      } else if (
        packet.event === 'round-finish' &&
        telephoneRoundRef.current?.id === packet.roundId
      ) {
        setTelephoneRound((current) => (current ? { ...current, finished: true } : current));
      }
    });
    return () => subscription.remove();
  }, [identity.id, identity.name, meshRouter, sendToPeers, upsertParticipant]);

  const joinGame = useCallback(
    async (gameId: GameId, notifyPeerId?: string): Promise<ActionResult> => {
      setJoinedGames((current) => ({ ...current, [gameId]: true }));
      upsertParticipant(gameId, identity.id, identity.name);
      const packet = makeGamePacket({
        senderId: identity.id,
        gameId,
        event: 'join',
        payload: participantPayload(identity.name),
      });
      const targets = notifyPeerId ? [notifyPeerId] : undefined;
      const sent = await sendToPeers(packet, targets);
      return sent || noredPeersRef.current.length === 0
        ? { ok: true }
        : { ok: false, error: 'Could not reach a nearby player.' };
    },
    [identity.id, identity.name, sendToPeers, upsertParticipant],
  );

  const leaveGame = useCallback(
    async (gameId: GameId) => {
      const packet = makeGamePacket({
        senderId: identity.id,
        gameId,
        event: 'leave',
      });
      await sendToPeers(packet);
      setJoinedGames((current) => ({ ...current, [gameId]: false }));
      setParticipants((current) => ({ ...current, [gameId]: [] }));
      if (gameId === 'mesh-ping') setBatonHolderId(undefined);
      else if (gameId === 'pong') {
        pongMatchRef.current = undefined;
        clearPongFrame();
        setPongMatch(undefined);
      }
      else if (gameId === 'telephone') {
        setTelephoneRound(undefined);
        setTelephoneChain(undefined);
      } else if (gameId === 'chess') setChessMatch(undefined);
    },
    [identity.id, sendToPeers],
  );

  const invitePlayer = useCallback(
    async (gameId: GameId, peerId: string): Promise<ActionResult> => {
      const peer = visibleNoredPeersRef.current.find(
        (candidate) => candidate.id === peerId && candidate.identityConfirmed,
      );
      if (!peer) return { ok: false, error: 'That player is no longer nearby.' };
      if (peer.pendingLoss) return { ok: false, error: 'That player is out of range.' };
      if (!meshRouter.hasSession(peerId)) {
        return { ok: false, error: 'That player is reconnecting. Try again in a moment.' };
      }
      const packet = makeGamePacket({
        senderId: identity.id,
        recipientId: peerId,
        gameId,
        event: 'invite',
        targetId: peerId,
        payload: participantPayload(identity.name),
      });
      const sent = await sendToPeers(packet, [peerId]);
      return sent
        ? { ok: true }
        : { ok: false, error: 'The invitation could not be sent.' };
    },
    [identity.id, identity.name, meshRouter, sendToPeers],
  );

  const acceptInvite = useCallback(async (): Promise<ActionResult> => {
    if (!pendingInvite) return { ok: false, error: 'This invitation is no longer available.' };
    const { gameId, fromId } = pendingInvite;
    setPendingInvite(undefined);
    return joinGame(gameId, fromId);
  }, [joinGame, pendingInvite]);

  const dismissInvite = useCallback(() => setPendingInvite(undefined), []);

  const startPong = useCallback(async (): Promise<ActionResult> => {
    const guest = participantsRef.current.pong.find(
      (participant) => participant.id !== identity.id,
    );
    if (!guest) return { ok: false, error: 'Invite another player before starting.' };
    const match = createPongMatch(identity.id, guest.id);
    const packet = makeGamePacket({
      senderId: identity.id,
      recipientId: guest.id,
      gameId: 'pong',
      event: 'pong-start',
      roundId: match.id,
      payload: JSON.stringify(match),
    });
    const sent = await sendToPeers(packet, [guest.id]);
    if (!sent) return { ok: false, error: 'The match could not reach the other player.' };
    pongMatchRef.current = match;
    lastSentPaddleY.current = match.leftY;
    setPongMatch(match);
    emitPongFrame(match);
    return { ok: true };
  }, [identity.id, sendToPeers]);

  const movePongPaddle = useCallback(
    (position: number) => {
      const current = pongMatchRef.current;
      if (!current?.running) return;
      const clamped = Math.max(0.14, Math.min(0.86, position));
      if (current.hostId === identity.id) {
        const next = { ...current, leftY: clamped };
        pongMatchRef.current = next;
        emitPongFrame(next);
      } else if (current.guestId === identity.id) {
        const next = { ...current, rightY: clamped };
        pongMatchRef.current = next;
        emitPongFrame(next);
        const now = Date.now();
        if (now - lastPongInputAt.current < 90) return;
        if (Math.abs(clamped - lastSentPaddleY.current) < 0.008) return;
        lastPongInputAt.current = now;
        lastSentPaddleY.current = clamped;
        const packet = makeGamePacket({
          senderId: identity.id,
          recipientId: current.hostId,
          gameId: 'pong',
          event: 'pong-input',
          roundId: current.id,
          payload: clamped.toFixed(3),
        });
        void sendToPeers(packet, [current.hostId]);
      }
    },
    [identity.id, sendToPeers],
  );

  const startTelephoneChain = useCallback(async (): Promise<ActionResult> => {
    const others = participantsRef.current.telephone
      .filter((participant) => participant.id !== identity.id)
      .map((participant) => participant.id);
    const playerIds = [identity.id, ...others].slice(0, 8);
    if (playerIds.length < 3) {
      return { ok: false, error: 'Drawing Telephone needs at least three joined players.' };
    }
    const chain = createTelephoneGame(
      `${Date.now().toString(36)}-${identity.id.slice(0, 6)}`,
      playerIds,
    );
    const packet = makeGamePacket({
      senderId: identity.id,
      gameId: 'telephone',
      event: 'round-start',
      roundId: chain.id,
      payload: JSON.stringify(playerIds),
    });
    const sent = await sendToPeers(packet, others);
    if (!sent) return { ok: false, error: 'The round could not reach the other players.' };
    telephoneChainRef.current = chain;
    setTelephoneChain(chain);
    return { ok: true };
  }, [identity.id, sendToPeers]);

  const submitTelephoneEntry = useCallback(
    async (
      event: 'telephone-prompt' | 'telephone-drawing' | 'telephone-guess',
      expectedMode: TelephoneChain['mode'],
      payload: string,
    ): Promise<ActionResult> => {
      const current = telephoneChainRef.current;
      if (!current || current.mode !== expectedMode) {
        return { ok: false, error: 'That turn is no longer active.' };
      }
      const chainId = assignedTelephoneChain(current, identity.id);
      if (!chainId) return { ok: false, error: 'You are not part of this round.' };
      if (current.chains[chainId]?.some((entry) => entry.round === current.roundIndex)) {
        return { ok: false, error: 'Your response for this round was already sent.' };
      }
      let entry;
      if (event === 'telephone-drawing') {
        const strokes = decodeDrawing(payload);
        if (!strokes.length) return { ok: false, error: 'Draw something first.' };
        entry = { kind: 'drawing' as const, strokes };
      } else {
        const text = payload.trim().slice(0, 80);
        if (!text) return { ok: false, error: 'Enter something first.' };
        entry = {
          kind: event === 'telephone-prompt' ? ('prompt' as const) : ('guess' as const),
          text,
        };
      }
      const packet = makeGamePacket({
        senderId: identity.id,
        gameId: 'telephone',
        event,
        roundId: current.id,
        targetId: chainId,
        sequence: current.roundIndex,
        payload,
      });
      const targets = current.playerIds.filter((id) => id !== identity.id);
      const sent = await sendToPeers(packet, targets);
      if (!sent) return { ok: false, error: 'Your turn could not be sent.' };
      const next = appendTelephoneEntry(current, {
        authorId: identity.id,
        chainId,
        round: current.roundIndex,
        entry,
      });
      telephoneChainRef.current = next;
      setTelephoneChain(next);
      return { ok: true };
    },
    [identity.id, sendToPeers],
  );

  const submitTelephonePrompt = useCallback(
    (text: string) => submitTelephoneEntry('telephone-prompt', 'prompt', text),
    [submitTelephoneEntry],
  );

  const submitTelephoneDrawing = useCallback(
    (strokes: DrawingPoint[][]) =>
      submitTelephoneEntry('telephone-drawing', 'draw', encodeDrawing(strokes)),
    [submitTelephoneEntry],
  );

  const submitTelephoneGuess = useCallback(
    (text: string) => submitTelephoneEntry('telephone-guess', 'guess', text),
    [submitTelephoneEntry],
  );

  const startChess = useCallback(async (): Promise<ActionResult> => {
    const opponent = participantsRef.current.chess.find(
      (participant) => participant.id !== identity.id,
    );
    if (!opponent) return { ok: false, error: 'Invite another player before starting.' };
    const match: ChessMatch = {
      id: `${Date.now().toString(36)}-${identity.id.slice(0, 6)}`,
      whiteId: identity.id,
      blackId: opponent.id,
      fen: INITIAL_CHESS_FEN,
      status: 'playing',
    };
    const packet = makeGamePacket({
      senderId: identity.id,
      recipientId: opponent.id,
      gameId: 'chess',
      event: 'chess-start',
      roundId: match.id,
      payload: JSON.stringify(match),
    });
    const sent = await sendToPeers(packet, [opponent.id]);
    if (!sent) return { ok: false, error: 'The match could not reach your opponent.' };
    chessMatchRef.current = match;
    setChessMatch(match);
    return { ok: true };
  }, [identity.id, sendToPeers]);

  const moveChess = useCallback(
    async (from: string, to: string, promotion = 'q'): Promise<ActionResult> => {
      const current = chessMatchRef.current;
      if (!current) return { ok: false, error: 'Start a match first.' };
      if (!playerCanMove(current, identity.id)) {
        return { ok: false, error: "It is not your turn." };
      }
      const move = { from, to, promotion };
      const next = applyChessMove(current, move);
      if (!next) return { ok: false, error: 'That move is not legal.' };
      const opponentId =
        identity.id === current.whiteId ? current.blackId : current.whiteId;
      const packet = makeGamePacket({
        senderId: identity.id,
        recipientId: opponentId,
        gameId: 'chess',
        event: 'chess-move',
        roundId: current.id,
        payload: JSON.stringify(move),
      });
      const sent = await sendToPeers(packet, [opponentId]);
      if (!sent) return { ok: false, error: 'The move could not reach your opponent.' };
      chessMatchRef.current = next;
      setChessMatch(next);
      return { ok: true };
    },
    [identity.id, sendToPeers],
  );

  const resignChess = useCallback(async (): Promise<ActionResult> => {
    const current = chessMatchRef.current;
    if (!current || current.status !== 'playing') {
      return { ok: false, error: 'There is no active match.' };
    }
    const opponentId =
      identity.id === current.whiteId ? current.blackId : current.whiteId;
    const packet = makeGamePacket({
      senderId: identity.id,
      recipientId: opponentId,
      gameId: 'chess',
      event: 'chess-resign',
      roundId: current.id,
    });
    const sent = await sendToPeers(packet, [opponentId]);
    if (!sent) return { ok: false, error: 'Your resignation could not be sent.' };
    const next: ChessMatch = {
      ...current,
      status: 'resigned',
      winnerId: opponentId,
    };
    chessMatchRef.current = next;
    setChessMatch(next);
    return { ok: true };
  }, [identity.id, sendToPeers]);

  const pingPeer = useCallback(
    async (peerId: string): Promise<ActionResult> => {
      if (!joinedRef.current['mesh-ping']) return { ok: false, error: 'Join first.' };
      const packet = makeGamePacket({
        senderId: identity.id,
        recipientId: peerId,
        gameId: 'mesh-ping',
        event: 'ping',
        targetId: peerId,
      });
      pendingPings.current.set(packet.id, { peerId, startedAt: Date.now() });
      const sent = await sendToPeers(packet, [peerId]);
      if (!sent) {
        pendingPings.current.delete(packet.id);
        return { ok: false, error: 'Ping could not be sent.' };
      }
      return { ok: true };
    },
    [identity.id, sendToPeers],
  );

  const passBaton = useCallback(
    async (peerId: string): Promise<ActionResult> => {
      if (!joinedRef.current['mesh-ping']) return { ok: false, error: 'Join first.' };
      if (batonHolderId && batonHolderId !== identity.id) {
        return { ok: false, error: 'Another player has the baton.' };
      }
      const packet = makeGamePacket({
        senderId: identity.id,
        gameId: 'mesh-ping',
        event: 'baton',
        targetId: peerId,
      });
      const sent = await sendToPeers(packet);
      if (!sent) return { ok: false, error: 'Baton could not be sent.' };
      setBatonHolderId(peerId);
      return { ok: true };
    },
    [batonHolderId, identity.id, sendToPeers],
  );

  const startTelephoneRound = useCallback(async (): Promise<ActionResult> => {
    if (!joinedRef.current.telephone) return { ok: false, error: 'Join first.' };
    const others = participantsRef.current.telephone
      .filter((participant) => participant.id !== identity.id)
      .map((participant) => participant.id);
    const playerIds = [identity.id, ...others].slice(0, 8);
    if (playerIds.length < 2) {
      return { ok: false, error: 'At least one other joined player is required.' };
    }
    const packet = makeGamePacket({
      senderId: identity.id,
      gameId: 'telephone',
      event: 'round-start',
      roundId: `${Date.now().toString(36)}-${identity.id.slice(0, 6)}`,
      payload: JSON.stringify(playerIds),
    });
    const nextRound: TelephoneRound = {
      id: packet.roundId!,
      playerIds,
      turnIndex: 0,
      strokes: [],
      finished: false,
    };
    const sent = await sendToPeers(packet, others);
    if (!sent) return { ok: false, error: 'Round could not reach the other players.' };
    setTelephoneRound(nextRound);
    return { ok: true };
  }, [identity.id, sendToPeers]);

  const submitStroke = useCallback(
    async (points: DrawingPoint[]): Promise<ActionResult> => {
      const round = telephoneRoundRef.current;
      if (!round || round.finished) return { ok: false, error: 'No active round.' };
      if (round.playerIds[round.turnIndex] !== identity.id) {
        return { ok: false, error: 'Wait for your turn.' };
      }
      const payload = encodeStroke(points);
      if (points.length < 2 || !payload) {
        return { ok: false, error: 'Draw a line before sending.' };
      }
      const packet = makeGamePacket({
        senderId: identity.id,
        gameId: 'telephone',
        event: 'stroke',
        roundId: round.id,
        sequence: round.turnIndex,
        payload,
      });
      const targets = round.playerIds.filter((id) => id !== identity.id);
      const sent = await sendToPeers(packet, targets);
      if (!sent) return { ok: false, error: 'Drawing could not be sent.' };
      const next = appendStroke(round, packet);
      setTelephoneRound(next);
      if (next.finished) {
        const finish = makeGamePacket({
          senderId: identity.id,
          gameId: 'telephone',
          event: 'round-finish',
          roundId: round.id,
        });
        void sendToPeers(finish, targets);
      }
      return { ok: true };
    },
    [identity.id, sendToPeers],
  );

  const value = useMemo(
    () => ({
      joinedGames,
      participants,
      pingResults,
      batonHolderId,
      telephoneRound,
      pongMatch,
      telephoneChain,
      chessMatch,
      pendingInvite,
      joinGame,
      leaveGame,
      invitePlayer,
      acceptInvite,
      dismissInvite,
      startPong,
      movePongPaddle,
      startTelephoneChain,
      submitTelephonePrompt,
      submitTelephoneDrawing,
      submitTelephoneGuess,
      startChess,
      moveChess,
      resignChess,
      pingPeer,
      passBaton,
      startTelephoneRound,
      submitStroke,
    }),
    [
      batonHolderId,
      acceptInvite,
      chessMatch,
      dismissInvite,
      invitePlayer,
      joinGame,
      joinedGames,
      leaveGame,
      participants,
      passBaton,
      pendingInvite,
      pongMatch,
      pingPeer,
      pingResults,
      moveChess,
      movePongPaddle,
      resignChess,
      startChess,
      startPong,
      startTelephoneChain,
      startTelephoneRound,
      submitTelephoneDrawing,
      submitTelephoneGuess,
      submitTelephonePrompt,
      submitStroke,
      telephoneChain,
      telephoneRound,
    ],
  );

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGames() {
  const value = useContext(GameContext);
  if (!value) throw new Error('useGames must be used inside GameProvider');
  return value;
}
