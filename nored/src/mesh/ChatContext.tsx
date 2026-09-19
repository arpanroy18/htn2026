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
  addGroupMember,
  appendMessage,
  createId,
  emptyChatState,
  ensureDmThread,
  ensureGroupThread,
  formatMessageClock,
  groupCount,
  isTextPacket,
  makeTextPacket,
  markThreadRead,
  MAX_GROUP_MEMBERS,
  MAX_GROUPS,
  migrateDmPeer,
  patchMessage,
  peerName,
  queuedGroupPackets,
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
  createGroup: (name: string, memberIds: string[]) => ChatThread | null;
  inviteToGroup: (groupId: string, peerId: string) => Promise<boolean>;
  sendText: (threadId: string, body: string) => Promise<void>;
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
      const groupId = packet.groupId?.trim();
      const threadId = groupId || (mine ? packet.recipientId : packet.senderId);
      const sender = mine
        ? 'You'
        : peerName(peersRef.current, packet.senderId, threadName);
      const message: ChatMessage = {
        id: packet.id,
        threadId,
        senderId: packet.senderId,
        sender,
        mine,
        kind: 'text',
        body: packet.payload,
        status: mine ? status : undefined,
        timestamp: packet.timestamp || Date.now(),
        time: formatMessageClock(packet.timestamp || Date.now()),
      };
      setState((current) => {
        const withGroup = groupId
          ? ensureGroupThread(current, {
              id: groupId,
              name: packet.groupName || threadName,
              memberIds: [
                packet.senderId,
                packet.recipientId,
                ...(packet.groupMemberIds ?? []),
              ],
            })
          : current;
        return appendMessage(withGroup, message, packet.groupName || threadName, unread);
      });
    },
    [remember],
  );

  const sendPacket = useCallback(async (peerId: string, packet: Packet) => {
    await meshTransport.sendPacket(peerId, packet);
  }, []);

  const sendableIds = useCallback(() => {
    return new Set(
      noredPeers.filter((peer) => peer.identityConfirmed).map((peer) => peer.id),
    );
  }, [noredPeers]);

  const fanoutGroup = useCallback(
    async (thread: ChatThread, packet: Packet) => {
      const reachable = sendableIds();
      const targets = thread.memberIds.filter(
        (memberId) => memberId !== identity.id && reachable.has(memberId),
      );
      if (!targets.length) return false;
      let allSent = true;
      for (const target of targets) {
        try {
          await sendPacket(target, { ...packet, recipientId: target });
        } catch {
          allSent = false;
          break;
        }
      }
      return allSent;
    },
    [identity.id, sendPacket, sendableIds],
  );

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

  const flushGroup = useCallback(
    async (groupId: string) => {
      if (flushing.current.has(groupId)) return;
      const thread = stateRef.current.threads.find((item) => item.id === groupId);
      if (thread?.kind !== 'group') return;
      const pending = queuedGroupPackets(stateRef.current, groupId, identity.id);
      if (!pending.length) return;
      const last = lastFlushAt.current.get(groupId) ?? 0;
      if (Date.now() - last < 2000) return;
      flushing.current.add(groupId);
      lastFlushAt.current.set(groupId, Date.now());
      try {
        for (const packet of pending) {
          const sent = await fanoutGroup(thread, packet);
          if (!sent) break;
          setState((current) => patchMessage(current, groupId, packet.id, { status: 'sent' }));
        }
      } finally {
        flushing.current.delete(groupId);
      }
    },
    [fanoutGroup, identity.id],
  );

  useEffect(() => {
    const subscription = meshTransport.onPacketReceived((_peerId, packet) => {
      if (!isTextPacket(packet)) return;
      if (packet.senderId === identity.id) return;
      if (packet.recipientId && packet.recipientId !== identity.id) return;
      if (seenIds.current.has(packet.id)) return;
      const groupId = packet.groupId?.trim();
      const name = peerName(peersRef.current, packet.senderId, packet.groupName || 'Nearby peer');
      const unread = activeThread.current !== (groupId || packet.senderId);
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
    const flush = () => {
      peerIds.forEach((peerId) => void flushPeer(peerId));
      stateRef.current.threads
        .filter((thread) => thread.kind === 'group')
        .forEach((thread) => void flushGroup(thread.id));
    };
    flush();
    const timer = setInterval(flush, 3000);
    return () => clearInterval(timer);
  }, [flushGroup, flushPeer, sendablePeerKey]);

  const openDm = useCallback((peerId: string, name: string) => {
    const resolvedId = resolvePeerId(peerId);
    setState((current) => ensureDmThread(current, resolvedId, name));
  }, [resolvePeerId]);

  const markRead = useCallback((threadId: string) => {
    const thread = stateRef.current.threads.find((item) => item.id === threadId);
    const resolvedId = thread?.kind === 'group' ? thread.id : resolvePeerId(threadId);
    activeThread.current = resolvedId;
    setState((current) => markThreadRead(current, resolvedId));
  }, [resolvePeerId]);

  const clearActive = useCallback(() => {
    activeThread.current = null;
  }, []);

  const announceMembership = useCallback(
    async (thread: ChatThread, body: string, extraMemberIds: string[] = []) => {
      const packet = makeTextPacket({
        senderId: identity.id,
        recipientId: identity.id,
        body,
        groupId: thread.id,
        groupName: thread.name,
        groupMemberIds: [...thread.memberIds, ...extraMemberIds],
      });
      await fanoutGroup(thread, packet);
    },
    [fanoutGroup, identity.id],
  );

  const createGroup = useCallback(
    (name: string, memberIds: string[]) => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const current = stateRef.current;
      if (groupCount(current) >= MAX_GROUPS) return null;
      const id = createId();
      const next = ensureGroupThread(current, {
        id,
        name: trimmed,
        memberIds: [identity.id, ...memberIds].map((memberId) => resolvePeerId(memberId)).filter(Boolean),
      });
      const created = next.threads.find((thread) => thread.id === id) ?? null;
      if (!created) return null;
      stateRef.current = next;
      setState(next);
      void announceMembership(created, `${identity.name} added you to ${trimmed}`);
      return created;
    },
    [announceMembership, identity.id, identity.name, resolvePeerId],
  );

  const inviteToGroup = useCallback(
    async (groupId: string, peerId: string) => {
      const memberId = resolvePeerId(peerId);
      const thread = stateRef.current.threads.find((item) => item.id === groupId);
      if (thread?.kind !== 'group') return false;
      if (thread.memberIds.includes(memberId)) return true;
      if (thread.memberIds.length >= MAX_GROUP_MEMBERS) return false;
      setState((current) => addGroupMember(current, groupId, memberId));
      const nextThread = {
        ...thread,
        memberIds: [...thread.memberIds, memberId],
      };
      stateRef.current = {
        ...stateRef.current,
        threads: stateRef.current.threads.map((item) =>
          item.id === groupId ? nextThread : item,
        ),
      };
      await announceMembership(nextThread, `${identity.name} added you to ${thread.name}`);
      return true;
    },
    [announceMembership, identity.name, resolvePeerId],
  );

  const sendText = useCallback(
    async (threadId: string, body: string) => {
      const text = body.trim();
      if (!text) return;
      const existing = stateRef.current.threads.find(
        (item) => item.id === threadId || item.id === resolvePeerId(threadId),
      );
      if (existing?.kind === 'group') {
        const packet = makeTextPacket({
          senderId: identity.id,
          recipientId: identity.id,
          body: text,
          groupId: existing.id,
          groupName: existing.name,
          groupMemberIds: existing.memberIds,
        });
        ingest(packet, existing.name, true, 'queued', false);
        const sent = await fanoutGroup(existing, packet);
        if (sent) {
          setState((current) => patchMessage(current, existing.id, packet.id, { status: 'sent' }));
        }
        return;
      }

      const peerId = resolvePeerId(threadId);
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
    [identity.id, ingest, noredPeers, peers, resolvePeerId, sendPacket, fanoutGroup],
  );

  const messagesFor = useCallback(
    (threadId: string) => {
      const thread = state.threads.find((item) => item.id === threadId);
      const id = thread?.kind === 'group' ? thread.id : resolvePeerId(threadId);
      return state.messages[id] ?? [];
    },
    [resolvePeerId, state.messages, state.threads],
  );

  const threads = useMemo(
    () =>
      state.threads.map((thread) => {
        if (thread.kind === 'group') return thread;
        const name = peerName(noredPeers, thread.peerId, peerName(peers, thread.peerId, thread.name));
        return name === thread.name ? thread : { ...thread, name };
      }),
    [noredPeers, peers, state.threads],
  );

  const threadFor = useCallback(
    (threadId: string) =>
      threads.find((thread) => thread.id === threadId) ??
      threads.find((thread) => thread.id === resolvePeerId(threadId)),
    [resolvePeerId, threads],
  );

  const value = useMemo(
    () => ({
      threads,
      threadFor,
      messagesFor,
      openDm,
      createGroup,
      inviteToGroup,
      sendText,
      markRead,
      clearActive,
    }),
    [clearActive, createGroup, inviteToGroup, markRead, messagesFor, openDm, sendText, threadFor, threads],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const value = useContext(ChatContext);
  if (!value) throw new Error('useChat must be used inside ChatProvider');
  return value;
}
