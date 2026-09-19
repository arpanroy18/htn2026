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
import {
  meshTransport,
  type GameId,
  type GamePacket,
  type Packet,
} from '@/transport';

import {
  appendStroke,
  encodeStroke,
  isGamePacket,
  makeGamePacket,
  participantPayload,
  type DrawingPoint,
  type GameParticipant,
  type TelephoneRound,
} from './gameStore';

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
  pendingInvite?: GameInvitation;
  joinGame: (gameId: GameId) => Promise<ActionResult>;
  leaveGame: (gameId: GameId) => Promise<void>;
  invitePlayer: (gameId: GameId, peerId: string) => Promise<ActionResult>;
  acceptInvite: () => Promise<ActionResult>;
  dismissInvite: () => void;
  pingPeer: (peerId: string) => Promise<ActionResult>;
  passBaton: (peerId: string) => Promise<ActionResult>;
  startTelephoneRound: () => Promise<ActionResult>;
  submitStroke: (points: DrawingPoint[]) => Promise<ActionResult>;
};

const GameContext = createContext<GameUi | null>(null);

const emptyJoined: Record<GameId, boolean> = {
  'mesh-ping': false,
  telephone: false,
};

const emptyParticipants: Record<GameId, GameParticipant[]> = {
  'mesh-ping': [],
  telephone: [],
};

export function GameProvider({ children }: { children: ReactNode }) {
  const { identity, noredPeers, peers } = useMeshUi();
  const [joinedGames, setJoinedGames] = useState(emptyJoined);
  const [participants, setParticipants] = useState(emptyParticipants);
  const [pingResults, setPingResults] = useState<Record<string, PingResult>>({});
  const [batonHolderId, setBatonHolderId] = useState<string>();
  const [telephoneRound, setTelephoneRound] = useState<TelephoneRound>();
  const [pendingInvite, setPendingInvite] = useState<GameInvitation>();
  const joinedRef = useRef(joinedGames);
  const peersRef = useRef(peers);
  const noredPeersRef = useRef(noredPeers);
  const participantsRef = useRef(participants);
  const telephoneRoundRef = useRef(telephoneRound);
  const pendingPings = useRef(new Map<string, { peerId: string; startedAt: number }>());

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
    participantsRef.current = participants;
  }, [participants]);

  useEffect(() => {
    telephoneRoundRef.current = telephoneRound;
  }, [telephoneRound]);

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
      noredPeersRef.current
        .filter((peer) => peer.identityConfirmed)
        .map((peer) => peer.id),
    );
    const targets = (peerIds ?? [...allowed]).filter((id) => allowed.has(id));
    const settled = await Promise.allSettled(
      targets.map((peerId) =>
        meshTransport.sendPacket(peerId, { ...packet, recipientId: peerId }),
      ),
    );
    return settled.some((result) => result.status === 'fulfilled');
  }, []);

  useEffect(() => {
    const subscription = meshTransport.onPacketReceived((_fromPeerId, packet: Packet) => {
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
      upsertParticipant(packet.gameId, packet.senderId);

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
  }, [identity.id, identity.name, sendToPeers, upsertParticipant]);

  const joinGame = useCallback(
    async (gameId: GameId): Promise<ActionResult> => {
      setJoinedGames((current) => ({ ...current, [gameId]: true }));
      upsertParticipant(gameId, identity.id, identity.name);
      const packet = makeGamePacket({
        senderId: identity.id,
        gameId,
        event: 'join',
        payload: participantPayload(identity.name),
      });
      if (noredPeersRef.current.length === 0) return { ok: true };
      const sent = await sendToPeers(packet);
      return sent
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
      else setTelephoneRound(undefined);
    },
    [identity.id, sendToPeers],
  );

  const invitePlayer = useCallback(
    async (gameId: GameId, peerId: string): Promise<ActionResult> => {
      const peer = noredPeersRef.current.find(
        (candidate) => candidate.id === peerId && candidate.identityConfirmed,
      );
      if (!peer) return { ok: false, error: 'That player is no longer nearby.' };
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
    [identity.id, identity.name, sendToPeers],
  );

  const acceptInvite = useCallback(async (): Promise<ActionResult> => {
    if (!pendingInvite) return { ok: false, error: 'This invitation is no longer available.' };
    const gameId = pendingInvite.gameId;
    setPendingInvite(undefined);
    return joinGame(gameId);
  }, [joinGame, pendingInvite]);

  const dismissInvite = useCallback(() => setPendingInvite(undefined), []);

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
      pendingInvite,
      joinGame,
      leaveGame,
      invitePlayer,
      acceptInvite,
      dismissInvite,
      pingPeer,
      passBaton,
      startTelephoneRound,
      submitStroke,
    }),
    [
      batonHolderId,
      acceptInvite,
      dismissInvite,
      invitePlayer,
      joinGame,
      joinedGames,
      leaveGame,
      participants,
      passBaton,
      pendingInvite,
      pingPeer,
      pingResults,
      startTelephoneRound,
      submitStroke,
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
