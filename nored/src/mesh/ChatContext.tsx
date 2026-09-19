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

import { meshTransport, type Packet } from '@/transport';

import { useMeshUi } from './MeshUiContext';
import {
  appendMessage,
  emptyChatState,
  ensureDmThread,
  formatMessageClock,
  isTextPacket,
  makeTextPacket,
  markThreadRead,
  migrateDmPeer,
  patchMessage,
  peerName,
  queuedPackets,
  type ChatMessage,
  type ChatState,
  type ChatThread,
} from './chatStore';

type ChatUi = {
  threads: ChatThread[];
  threadFor: (threadId: string) => ChatThread | undefined;
  messagesFor: (threadId: string) => ChatMessage[];
  openDm: (peerId: string, name: string) => void;
  sendText: (peerId: string, body: string) => Promise<void>;
  markRead: (threadId: string) => void;
  clearActive: () => void;
};

const ChatContext = createContext<ChatUi | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const { identity, peers, noredPeers } = useMeshUi();
  const [state, setState] = useState<ChatState>(emptyChatState);
  const stateRef = useRef(state);
  const peersRef = useRef(peers);
  const seenIds = useRef(new Set<string>());
  const activeThread = useRef<string | null>(null);
  const peerAliases = useRef(new Map<string, string>());
  const flushing = useRef(new Set<string>());
  const lastFlushAt = useRef(new Map<string, number>());

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);

  const resolvePeerId = useCallback((value: string) => {
    let current = value.trim().toLowerCase();
    const visited = new Set<string>();
    while (!visited.has(current)) {
      visited.add(current);
      const next = peerAliases.current.get(current);
      if (!next) break;
      current = next;
    }
    return current;
  }, []);

  useEffect(() => {
    for (const peer of peers) {
      if (!peer.replacesId) continue;
      const previousId = resolvePeerId(peer.replacesId);
      const peerId = resolvePeerId(peer.id);
      if (previousId === peerId) continue;
      peerAliases.current.set(previousId, peerId);
      setState((current) => {
        const next = migrateDmPeer(current, previousId, peerId, peer.name);
        stateRef.current = next;
        return next;
      });
      if (activeThread.current === previousId) {
        activeThread.current = peerId;
      }
    }
  }, [peers, resolvePeerId]);

  const remember = useCallback((id: string) => {
    seenIds.current.add(id);
    if (seenIds.current.size > 500) {
      seenIds.current = new Set([...seenIds.current].slice(-250));
    }
  }, []);

  const ingest = useCallback(
    (packet: Packet, threadName: string, mine: boolean, status: ChatMessage['status'], unread: boolean) => {
      if (!isTextPacket(packet) || !packet.payload.trim()) return;
      remember(packet.id);
      const threadId = mine ? packet.recipientId : packet.senderId;
      const message: ChatMessage = {
        id: packet.id,
        threadId,
        senderId: packet.senderId,
        sender: mine ? 'You' : threadName,
        mine,
        kind: 'text',
        body: packet.payload,
        status: mine ? status : undefined,
        timestamp: packet.timestamp || Date.now(),
        time: formatMessageClock(packet.timestamp || Date.now()),
      };
      setState((current) => appendMessage(current, message, threadName, unread));
    },
    [remember],
  );

  const sendPacket = useCallback(async (peerId: string, packet: Packet) => {
    await meshTransport.sendPacket(peerId, packet);
  }, []);

  const flushPeer = useCallback(
    async (peerId: string) => {
      peerId = resolvePeerId(peerId);
      if (flushing.current.has(peerId)) return;
      const pending = queuedPackets(stateRef.current, peerId, identity.id);
      if (!pending.length) return;
      const last = lastFlushAt.current.get(peerId) ?? 0;
      if (Date.now() - last < 2000) return;
      flushing.current.add(peerId);
      lastFlushAt.current.set(peerId, Date.now());
      try {
        for (const packet of pending) {
          try {
            await sendPacket(peerId, packet);
            setState((current) => patchMessage(current, peerId, packet.id, { status: 'sent' }));
          } catch {
            break;
          }
        }
      } finally {
        flushing.current.delete(peerId);
      }
    },
    [identity.id, resolvePeerId, sendPacket],
  );

  useEffect(() => {
    const subscription = meshTransport.onPacketReceived((_peerId, packet) => {
      if (!isTextPacket(packet)) return;
      if (packet.senderId === identity.id) return;
      if (packet.recipientId && packet.recipientId !== identity.id) return;
      if (seenIds.current.has(packet.id)) return;
      const name = peerName(peersRef.current, packet.senderId, 'Nearby peer');
      const unread = activeThread.current !== packet.senderId;
      ingest(packet, name, false, undefined, unread);
    });
    return () => subscription.remove();
  }, [identity.id, ingest]);

  const sendablePeerKey = useMemo(
    () =>
      noredPeers
        .filter((peer) => peer.identityConfirmed)
        .map((peer) => peer.id)
        .sort()
        .join('\n'),
    [noredPeers],
  );

  useEffect(() => {
    const peerIds = sendablePeerKey.split('\n').filter(Boolean);
    if (!peerIds.length) return;
    const flush = () => peerIds.forEach((peerId) => void flushPeer(peerId));
    flush();
    const timer = setInterval(flush, 3000);
    return () => clearInterval(timer);
  }, [flushPeer, sendablePeerKey]);

  const openDm = useCallback((peerId: string, name: string) => {
    const resolvedId = resolvePeerId(peerId);
    setState((current) => ensureDmThread(current, resolvedId, name));
  }, [resolvePeerId]);

  const markRead = useCallback((threadId: string) => {
    const resolvedId = resolvePeerId(threadId);
    activeThread.current = resolvedId;
    setState((current) => markThreadRead(current, resolvedId));
  }, [resolvePeerId]);

  const clearActive = useCallback(() => {
    activeThread.current = null;
  }, []);

  const sendText = useCallback(
    async (peerId: string, body: string) => {
      peerId = resolvePeerId(peerId);
      const text = body.trim();
      if (!text) return;
      const name = peerName(noredPeers, peerId, peerName(peers, peerId, 'Nearby peer'));
      const packet = makeTextPacket({ senderId: identity.id, recipientId: peerId, body: text });
      const canSend = noredPeers.some(
        (peer) => peer.id === peerId && peer.identityConfirmed,
      );
      ingest(packet, name, true, 'queued', false);
      if (!canSend) return;
      try {
        await sendPacket(peerId, packet);
        setState((current) => patchMessage(current, peerId, packet.id, { status: 'sent' }));
      } catch {
        // It remains queued and will retry after the peer reconnects.
      }
    },
    [identity.id, ingest, noredPeers, peers, resolvePeerId, sendPacket],
  );

  const messagesFor = useCallback(
    (threadId: string) => state.messages[resolvePeerId(threadId)] ?? [],
    [resolvePeerId, state.messages],
  );

  const threads = useMemo(
    () =>
      state.threads.map((thread) => {
        const name = peerName(noredPeers, thread.peerId, peerName(peers, thread.peerId, thread.name));
        return name === thread.name ? thread : { ...thread, name };
      }),
    [noredPeers, peers, state.threads],
  );

  const threadFor = useCallback(
    (threadId: string) =>
      threads.find((thread) => thread.id === resolvePeerId(threadId)),
    [resolvePeerId, threads],
  );

  const value = useMemo(
    () => ({
      threads,
      threadFor,
      messagesFor,
      openDm,
      sendText,
      markRead,
      clearActive,
    }),
    [clearActive, markRead, messagesFor, openDm, sendText, threadFor, threads],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const value = useContext(ChatContext);
  if (!value) throw new Error('useChat must be used inside ChatProvider');
  return value;
}
