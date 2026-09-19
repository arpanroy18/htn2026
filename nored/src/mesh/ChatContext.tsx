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

import {
  meshTransport,
  type MediaAckPacket,
  type MediaChunkPacket,
  type MediaManifestPacket,
  type MediaRetryPacket,
  type Packet,
  type Peer,
} from '@/transport';

import { useMeshUi } from './MeshUiContext';
import {
  addGroupMember,
  appendMessage,
  createId,
  emptyChatState,
  ensureDmThread,
  ensureGroupThread,
  formatMessageClock,
  GROUP_TTL_HOPS,
  groupCount,
  isGroupSyncPacket,
  isTextPacket,
  makeGroupSyncPacket,
  makeMediaManifest,
  makeTextPacket,
  markThreadRead,
  MAX_GROUP_MEMBERS,
  MAX_GROUPS,
  memberDisplayName,
  migrateDmPeer,
  packetThreadId,
  patchMessage,
  peerName,
  queuedGroupMedia,
  queuedGroupText,
  queuedPackets,
  remapPeerInGroups,
  threadHasMember,
  type ChatMessage,
  type ChatState,
  type ChatThread,
} from './chatStore';
import {
  fileBytes,
  prepareImage,
  persistVoiceNote,
  sha256,
  writeMediaBytes,
} from './mediaFiles';
import { clearChatState, loadChatState, saveChatState } from './chatPersistence';
import {
  MEDIA_CHUNK_BYTES,
  MEDIA_REASSEMBLY_TIMEOUT_MS,
  acceptMediaChunk,
  assembleMediaBytes,
  createIncomingTransfer,
  missingMediaChunks,
  splitMediaBytes,
  type IncomingTransfer,
} from './mediaTransfer';

type GroupResult = { ok: true; id: string } | { ok: false; error: string };

type ChatUi = {
  threads: ChatThread[];
  threadFor: (threadId: string) => ChatThread | undefined;
  messagesFor: (threadId: string) => ChatMessage[];
  openDm: (peerId: string, name: string) => void;
  createGroup: (name: string, memberIds: string[]) => GroupResult;
  inviteToGroup: (groupId: string, peerId: string) => GroupResult;
  sendText: (peerId: string, body: string) => Promise<void>;
  sendImage: (
    peerId: string,
    sourceUri: string,
    width: number,
    height: number,
  ) => Promise<void>;
  sendVoiceNote: (peerId: string, sourceUri: string, durationMs: number) => Promise<void>;
  totalUnread: number;
  markRead: (threadId: string) => void;
  clearActive: () => void;
  clearLocalData: () => Promise<void>;
};

const ChatContext = createContext<ChatUi | null>(null);

function confirmedPeers(peers: Peer[]) {
  return peers.filter((peer) => peer.identityConfirmed);
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { identity, peers, noredPeers } = useMeshUi();
  const [state, setState] = useState<ChatState>(emptyChatState);
  const [hydrated, setHydrated] = useState(false);
  const stateRef = useRef(state);
  const peersRef = useRef(peers);
  const noredPeersRef = useRef(noredPeers);
  const seenIds = useRef(new Set<string>());
  const activeThread = useRef<string | null>(null);
  const peerAliases = useRef(new Map<string, string>());
  const flushing = useRef(new Set<string>());
  const lastFlushAt = useRef(new Map<string, number>());
  const incomingTransfers = useRef(new Map<string, IncomingTransfer>());
  const outgoingTransfers = useRef(
    new Map<string, { manifest: MediaManifestPacket; chunks: MediaChunkPacket[] }>(),
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    void loadChatState().then((loaded) => {
      if (cancelled) return;
      setState(loaded);
      for (const messages of Object.values(loaded.messages)) {
        for (const message of messages) {
          seenIds.current.add(message.id);
        }
      }
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const timer = setTimeout(() => {
      void saveChatState(stateRef.current);
    }, 400);
    return () => clearTimeout(timer);
  }, [hydrated, state]);

  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);

  useEffect(() => {
    noredPeersRef.current = noredPeers;
  }, [noredPeers]);

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

  const resolveThreadId = useCallback(
    (threadId: string) => {
      const exact = stateRef.current.threads.find((thread) => thread.id === threadId);
      if (exact?.kind === 'group') return exact.id;
      return resolvePeerId(threadId);
    },
    [resolvePeerId],
  );

  useEffect(() => {
    for (const peer of peers) {
      if (!peer.replacesId) continue;
      const previousId = resolvePeerId(peer.replacesId);
      const peerId = resolvePeerId(peer.id);
      if (previousId === peerId) continue;
      peerAliases.current.set(previousId, peerId);
      setState((current) => {
        const migrated = migrateDmPeer(current, previousId, peerId, peer.name);
        const next = remapPeerInGroups(migrated, previousId, peerId, peer.name);
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

  const floodTargets = useCallback(
    (excludePeerId?: string, senderId?: string) =>
      confirmedPeers(noredPeersRef.current).filter(
        (peer) =>
          peer.id !== identity.id &&
          peer.id !== excludePeerId &&
          peer.id !== senderId,
      ),
    [identity.id],
  );

  const sendPacket = useCallback(async (peerId: string, packet: Packet) => {
    await meshTransport.sendPacket(peerId, packet);
  }, []);

  const floodPacket = useCallback(
    async (packet: Packet, excludePeerId?: string) => {
      const hops = packet.hops ?? 0;
      if (hops > (packet.ttlHops ?? GROUP_TTL_HOPS)) return 0;
      const targets = floodTargets(excludePeerId, packet.senderId);
      const results = await Promise.allSettled(
        targets.map((peer) => sendPacket(peer.id, { ...packet, recipientId: peer.id })),
      );
      return results.filter((result) => result.status === 'fulfilled').length;
    },
    [floodTargets, sendPacket],
  );

  const ingest = useCallback(
    (packet: Packet, threadName: string, mine: boolean, status: ChatMessage['status'], unread: boolean) => {
      if (!isTextPacket(packet) || !packet.payload.trim()) return;
      remember(packet.id);
      const threadId = packetThreadId(packet, mine);
      const senderLabel = mine
        ? 'You'
        : peerName(
            peersRef.current,
            packet.senderId,
            memberDisplayName(
              stateRef.current.threads.find((thread) => thread.id === threadId),
              packet.senderId,
              threadName,
            ),
          );
      const message: ChatMessage = {
        id: packet.id,
        threadId,
        senderId: packet.senderId,
        sender: senderLabel,
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

  const appendMediaMessage = useCallback(
    (
      manifest: MediaManifestPacket,
      threadName: string,
      mine: boolean,
      localUri: string | undefined,
      status: ChatMessage['status'],
      unread: boolean,
    ) => {
      remember(manifest.id);
      const threadId = packetThreadId(manifest, mine);
      const senderLabel = mine
        ? 'You'
        : peerName(
            peersRef.current,
            manifest.senderId,
            memberDisplayName(
              stateRef.current.threads.find((thread) => thread.id === threadId),
              manifest.senderId,
              threadName,
            ),
          );
      const message: ChatMessage = {
        id: manifest.id,
        threadId,
        senderId: manifest.senderId,
        sender: senderLabel,
        mine,
        kind: manifest.mediaKind,
        body: manifest.mediaKind === 'image' ? 'Photo' : 'Voice message',
        localUri,
        mimeType: manifest.mimeType,
        byteLength: manifest.byteLength,
        hash: manifest.hash,
        width: manifest.width,
        height: manifest.height,
        durationMs: manifest.durationMs,
        transferProgress: localUri ? 0 : 0,
        status: mine ? status : undefined,
        timestamp: manifest.timestamp,
        time: formatMessageClock(manifest.timestamp),
      };
      setState((current) => appendMessage(current, message, threadName, unread));
    },
    [remember],
  );

  const mediaThreadId = useCallback(
    (manifest: Pick<MediaManifestPacket, 'groupId' | 'recipientId'>, fallbackPeerId: string) =>
      manifest.groupId ?? fallbackPeerId,
    [],
  );

  const transmitMedia = useCallback(
    async (
      peerId: string,
      manifest: MediaManifestPacket,
      bytes: Uint8Array,
      onlySequences?: number[],
    ) => {
      const allChunks = splitMediaBytes({ manifest, bytes });
      outgoingTransfers.current.set(manifest.id, { manifest, chunks: allChunks });
      const chunks = onlySequences
        ? onlySequences.map((sequence) => allChunks[sequence]).filter(Boolean)
        : allChunks;
      const threadId = mediaThreadId(manifest, peerId);
      if (!onlySequences) await sendPacket(peerId, manifest);
      for (let index = 0; index < chunks.length; index += 1) {
        await sendPacket(peerId, chunks[index]);
        const completed = onlySequences
          ? undefined
          : Math.min(0.98, (index + 1) / Math.max(1, chunks.length));
        if (completed !== undefined) {
          setState((current) =>
            patchMessage(current, threadId, manifest.id, { transferProgress: completed }),
          );
        }
      }
    },
    [mediaThreadId, sendPacket],
  );

  const sendStoredMedia = useCallback(
    async (peerId: string, message: ChatMessage) => {
      if (!message.localUri || !message.hash || !message.mimeType || !message.byteLength) return;
      const bytes = await fileBytes(message.localUri);
      const groupId = message.threadId !== peerId ? message.threadId : undefined;
      const manifest = makeMediaManifest({
        id: message.id,
        senderId: identity.id,
        recipientId: peerId,
        groupId,
        hops: groupId ? 0 : undefined,
        ttlHops: groupId ? GROUP_TTL_HOPS : undefined,
        mediaKind: message.kind === 'image' ? 'image' : 'audio',
        mimeType: message.mimeType,
        byteLength: message.byteLength,
        chunkCount: Math.ceil(bytes.byteLength / MEDIA_CHUNK_BYTES),
        hash: message.hash,
        width: message.width,
        height: message.height,
        durationMs: message.durationMs,
        timestamp: message.timestamp,
      });
      if (groupId) {
        const targets = floodTargets();
        for (const peer of targets) {
          await transmitMedia(peer.id, { ...manifest, recipientId: peer.id }, bytes);
        }
        return;
      }
      await transmitMedia(peerId, manifest, bytes);
    },
    [floodTargets, identity.id, transmitMedia],
  );

  const applyGroupSync = useCallback(
    (packet: Packet, unread: boolean) => {
      if (!isGroupSyncPacket(packet)) return false;
      const selfId = identity.id;
      if (!packet.members.some((member) => member.id === selfId)) return false;
      setState((current) => {
        const existed = current.threads.some((thread) => thread.id === packet.groupId);
        const next = ensureGroupThread(current, {
          id: packet.groupId,
          name: packet.name,
          members: packet.members,
        });
        if (!existed && unread && activeThread.current !== packet.groupId) {
          return {
            ...next,
            threads: next.threads.map((item) =>
              item.id === packet.groupId ? { ...item, unread: item.unread + 1 } : item,
            ),
          };
        }
        return next;
      });
      return true;
    },
    [identity.id],
  );

  const flushPeer = useCallback(
    async (peerId: string) => {
      peerId = resolvePeerId(peerId);
      if (flushing.current.has(peerId)) return;
      const pending = queuedPackets(stateRef.current, peerId, identity.id);
      const pendingMedia = (stateRef.current.messages[peerId] ?? []).filter(
        (message) =>
          message.mine &&
          message.status === 'queued' &&
          (message.kind === 'image' || message.kind === 'audio'),
      );
      if (!pending.length && !pendingMedia.length) return;
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
        for (const message of pendingMedia) {
          try {
            await sendStoredMedia(peerId, message);
          } catch {
            break;
          }
        }
      } finally {
        flushing.current.delete(peerId);
      }
    },
    [identity.id, resolvePeerId, sendPacket, sendStoredMedia],
  );

  const flushGroups = useCallback(async () => {
    const key = 'groups';
    if (flushing.current.has(key)) return;
    const targets = floodTargets();
    if (!targets.length) return;
    const last = lastFlushAt.current.get(key) ?? 0;
    if (Date.now() - last < 2000) return;
    const texts = queuedGroupText(stateRef.current);
    const media = stateRef.current.threads
      .filter((thread) => thread.kind === 'group')
      .flatMap((thread) => queuedGroupMedia(stateRef.current, thread.id));
    if (!texts.length && !media.length) return;
    flushing.current.add(key);
    lastFlushAt.current.set(key, Date.now());
    try {
      for (const message of texts) {
        const packet: Packet = {
          version: 1,
          id: message.id,
          senderId: identity.id,
          recipientId: identity.id,
          groupId: message.threadId,
          hops: 0,
          ttlHops: GROUP_TTL_HOPS,
          type: 'text',
          timestamp: message.timestamp,
          payload: message.body,
        };
        const sent = await floodPacket(packet);
        if (sent > 0) {
          setState((current) => patchMessage(current, message.threadId, message.id, { status: 'sent' }));
        }
      }
      for (const message of media) {
        try {
          await sendStoredMedia(identity.id, message);
          setState((current) =>
            patchMessage(current, message.threadId, message.id, { status: 'sent', transferProgress: 1 }),
          );
        } catch {
          break;
        }
      }
    } finally {
      flushing.current.delete(key);
    }
  }, [floodPacket, floodTargets, identity.id, sendStoredMedia]);

  const handlePacket = useCallback(
    async (packet: Packet, fromPeerId: string) => {
      if (packet.senderId === identity.id || packet.recipientId !== identity.id) return;

      if (isGroupSyncPacket(packet)) {
        if (seenIds.current.has(packet.id)) return;
        remember(packet.id);
        applyGroupSync(packet, activeThread.current !== packet.groupId);
        void floodPacket({ ...packet, hops: (packet.hops ?? 0) + 1 }, fromPeerId);
        return;
      }

      const groupId = packet.groupId;
      const groupThread = groupId
        ? stateRef.current.threads.find((thread) => thread.id === groupId)
        : undefined;
      if (groupId && groupThread && !threadHasMember(groupThread, identity.id)) {
        if (
          packet.type === 'text' ||
          packet.type === 'media-manifest' ||
          packet.type === 'media-chunk'
        ) {
          if (seenIds.current.has(packet.id)) return;
          remember(packet.id);
          void floodPacket({ ...packet, hops: (packet.hops ?? 0) + 1 }, fromPeerId);
        }
        return;
      }

      const name = peerName(peersRef.current, packet.senderId, 'Nearby peer');
      const threadName = groupThread?.name ?? name;
      const threadId = packetThreadId(packet, false);

      if (isTextPacket(packet)) {
        if (seenIds.current.has(packet.id)) return;
        if (groupId) {
          if (threadHasMember(groupThread, identity.id)) {
            ingest(packet, threadName, false, undefined, activeThread.current !== threadId);
          } else {
            remember(packet.id);
          }
          void floodPacket({ ...packet, hops: (packet.hops ?? 0) + 1 }, fromPeerId);
          return;
        }
        ingest(packet, threadName, false, undefined, activeThread.current !== threadId);
        return;
      }

      if (packet.type === 'media-manifest') {
        if (seenIds.current.has(packet.id)) {
          if (incomingTransfers.current.has(packet.id)) return;
          const ack: MediaAckPacket = {
            version: 1,
            id: `${packet.id}:ack:repeat`,
            senderId: identity.id,
            recipientId: packet.senderId,
            groupId: packet.groupId,
            type: 'media-ack',
            timestamp: Date.now(),
            transferId: packet.id,
          };
          await sendPacket(packet.senderId, ack);
          return;
        }
        if (!groupId || threadHasMember(groupThread, identity.id)) {
          incomingTransfers.current.set(packet.id, createIncomingTransfer(packet));
          appendMediaMessage(
            packet,
            threadName,
            false,
            undefined,
            undefined,
            activeThread.current !== threadId,
          );
        } else {
          remember(packet.id);
        }
        if (groupId) void floodPacket({ ...packet, hops: (packet.hops ?? 0) + 1 }, fromPeerId);
        return;
      }

      if (packet.type === 'media-chunk') {
        if (seenIds.current.has(packet.id)) {
          const existing = incomingTransfers.current.get(packet.transferId);
          if (existing) acceptMediaChunk(existing, packet);
          return;
        }
        remember(packet.id);
        if (groupId) void floodPacket({ ...packet, hops: (packet.hops ?? 0) + 1 }, fromPeerId);
        const transfer = incomingTransfers.current.get(packet.transferId);
        if (!transfer || !acceptMediaChunk(transfer, packet)) return;
        const received = transfer.chunks.size;
        const chunkThreadId = mediaThreadId(transfer.manifest, packet.senderId);
        setState((current) =>
          patchMessage(current, chunkThreadId, packet.transferId, {
            transferProgress: received / transfer.manifest.chunkCount,
          }),
        );
        if (received !== transfer.manifest.chunkCount) return;
        try {
          const bytes = assembleMediaBytes(transfer);
          if ((await sha256(bytes)) !== transfer.manifest.hash) {
            throw new Error('The media integrity check failed.');
          }
          const extension = transfer.manifest.mediaKind === 'image' ? 'jpg' : 'm4a';
          const localUri = await writeMediaBytes(transfer.manifest.id, extension, bytes);
          incomingTransfers.current.delete(packet.transferId);
          setState((current) =>
            patchMessage(current, chunkThreadId, packet.transferId, {
              localUri,
              transferProgress: 1,
              transferError: undefined,
            }),
          );
          const ack: MediaAckPacket = {
            version: 1,
            id: `${packet.transferId}:ack`,
            senderId: identity.id,
            recipientId: packet.senderId,
            groupId: transfer.manifest.groupId,
            type: 'media-ack',
            timestamp: Date.now(),
            transferId: packet.transferId,
          };
          await sendPacket(packet.senderId, ack);
        } catch (error) {
          transfer.chunks.clear();
          transfer.updatedAt = 0;
          setState((current) =>
            patchMessage(current, chunkThreadId, packet.transferId, {
              transferError: error instanceof Error ? error.message : 'Media transfer failed.',
            }),
          );
        }
        return;
      }

      if (packet.type === 'media-ack') {
        const outgoing = outgoingTransfers.current.get(packet.transferId);
        if (!outgoing) return;
        outgoingTransfers.current.delete(packet.transferId);
        setState((current) =>
          patchMessage(current, packet.groupId ?? packet.senderId, packet.transferId, {
            status: 'sent',
            transferProgress: 1,
            transferError: undefined,
          }),
        );
        return;
      }

      if (packet.type === 'media-retry') {
        const outgoing = outgoingTransfers.current.get(packet.transferId);
        if (!outgoing) return;
        for (const sequence of packet.missing) {
          const chunk = outgoing.chunks[sequence];
          if (chunk) await sendPacket(packet.senderId, chunk);
        }
      }
    },
    [
      appendMediaMessage,
      applyGroupSync,
      floodPacket,
      identity.id,
      ingest,
      mediaThreadId,
      remember,
      sendPacket,
    ],
  );

  useEffect(() => {
    const subscription = meshTransport.onPacketReceived((peerId, packet) => {
      void handlePacket(packet, peerId);
    });
    return () => subscription.remove();
  }, [handlePacket]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const transfer of incomingTransfers.current.values()) {
        if (now - transfer.updatedAt < MEDIA_REASSEMBLY_TIMEOUT_MS) continue;
        const missing = missingMediaChunks(transfer);
        if (!missing.length) continue;
        if (transfer.retries >= 3) {
          incomingTransfers.current.delete(transfer.manifest.id);
          setState((current) =>
            patchMessage(
              current,
              mediaThreadId(transfer.manifest, transfer.manifest.senderId),
              transfer.manifest.id,
              {
                transferError: 'Transfer timed out.',
              },
            ),
          );
          continue;
        }
        transfer.retries += 1;
        transfer.updatedAt = now;
        const retry: MediaRetryPacket = {
          version: 1,
          id: `${transfer.manifest.id}:retry:${transfer.retries}`,
          senderId: identity.id,
          recipientId: transfer.manifest.senderId,
          groupId: transfer.manifest.groupId,
          type: 'media-retry',
          timestamp: now,
          transferId: transfer.manifest.id,
          missing,
        };
        void sendPacket(transfer.manifest.senderId, retry);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [identity.id, mediaThreadId, sendPacket]);

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
      void flushGroups();
    };
    flush();
    const timer = setInterval(flush, 3000);
    return () => clearInterval(timer);
  }, [flushGroups, flushPeer, sendablePeerKey]);

  const openDm = useCallback((peerId: string, name: string) => {
    const resolvedId = resolvePeerId(peerId);
    setState((current) => ensureDmThread(current, resolvedId, name));
  }, [resolvePeerId]);

  const markRead = useCallback((threadId: string) => {
    const resolvedId = resolveThreadId(threadId);
    activeThread.current = resolvedId;
    setState((current) => markThreadRead(current, resolvedId));
  }, [resolveThreadId]);

  const clearActive = useCallback(() => {
    activeThread.current = null;
  }, []);

  const clearLocalData = useCallback(async () => {
    seenIds.current.clear();
    incomingTransfers.current.clear();
    outgoingTransfers.current.clear();
    activeThread.current = null;
    const next = emptyChatState;
    stateRef.current = next;
    setState(next);
    await clearChatState();
  }, []);

  const publishGroup = useCallback(
    (groupId: string) => {
      const thread = stateRef.current.threads.find((item) => item.id === groupId && item.kind === 'group');
      if (!thread) return;
      const packet = makeGroupSyncPacket({
        senderId: identity.id,
        groupId: thread.id,
        name: thread.name,
        members: thread.memberIds.map((id) => ({
          id,
          name: id === identity.id ? identity.name : (thread.memberNames[id] ?? peerName(noredPeersRef.current, id, 'Nearby peer')),
        })),
      });
      remember(packet.id);
      void floodPacket(packet);
    },
    [floodPacket, identity.id, identity.name, remember],
  );

  const createGroup = useCallback(
    (name: string, memberIds: string[]): GroupResult => {
      const title = name.trim();
      if (!title) return { ok: false, error: 'Give the group a name.' };
      if (groupCount(stateRef.current) >= MAX_GROUPS) {
        return { ok: false, error: `This phone can keep ${MAX_GROUPS} groups.` };
      }
      const members = [
        { id: identity.id, name: identity.name },
        ...memberIds.map((id) => ({
          id: resolvePeerId(id),
          name: peerName(noredPeersRef.current, resolvePeerId(id), peerName(peersRef.current, resolvePeerId(id), 'Nearby peer')),
        })),
      ].filter((member, index, list) => list.findIndex((item) => item.id === member.id) === index);
      if (members.length < 2) return { ok: false, error: 'Invite at least one nearby phone.' };
      if (members.length > MAX_GROUP_MEMBERS) {
        return { ok: false, error: `Groups can have ${MAX_GROUP_MEMBERS} members.` };
      }
      const id = createId();
      setState((current) => {
        const next = ensureGroupThread(current, { id, name: title, members });
        stateRef.current = next;
        return next;
      });
      publishGroup(id);
      return { ok: true, id };
    },
    [identity.id, identity.name, publishGroup, resolvePeerId],
  );

  const inviteToGroup = useCallback(
    (groupId: string, peerId: string): GroupResult => {
      const resolvedGroup = resolveThreadId(groupId);
      const resolvedPeer = resolvePeerId(peerId);
      const thread = stateRef.current.threads.find(
        (item) => item.id === resolvedGroup && item.kind === 'group',
      );
      if (!thread) return { ok: false, error: 'That group is not on this phone.' };
      if (thread.memberIds.includes(resolvedPeer)) return { ok: true, id: thread.id };
      if (thread.memberIds.length >= MAX_GROUP_MEMBERS) {
        return { ok: false, error: `Groups can have ${MAX_GROUP_MEMBERS} members.` };
      }
      const name = peerName(
        noredPeersRef.current,
        resolvedPeer,
        peerName(peersRef.current, resolvedPeer, 'Nearby peer'),
      );
      setState((current) => {
        const next = addGroupMember(current, thread.id, { id: resolvedPeer, name });
        stateRef.current = next;
        return next;
      });
      publishGroup(thread.id);
      return { ok: true, id: thread.id };
    },
    [publishGroup, resolvePeerId, resolveThreadId],
  );

  const sendText = useCallback(
    async (peerId: string, body: string) => {
      const text = body.trim();
      if (!text) return;
      const threadId = resolveThreadId(peerId);
      const thread = stateRef.current.threads.find((item) => item.id === threadId);
      if (thread?.kind === 'group') {
        const packet = makeTextPacket({
          senderId: identity.id,
          recipientId: identity.id,
          groupId: thread.id,
          hops: 0,
          ttlHops: GROUP_TTL_HOPS,
          body: text,
        });
        ingest(packet, thread.name, true, 'queued', false);
        const sent = await floodPacket(packet);
        if (sent > 0) {
          setState((current) => patchMessage(current, thread.id, packet.id, { status: 'sent' }));
        }
        return;
      }
      const name = peerName(noredPeers, threadId, peerName(peers, threadId, 'Nearby peer'));
      const packet = makeTextPacket({ senderId: identity.id, recipientId: threadId, body: text });
      const canSend = noredPeers.some(
        (peer) => peer.id === threadId && peer.identityConfirmed,
      );
      ingest(packet, name, true, 'queued', false);
      if (!canSend) return;
      try {
        await sendPacket(threadId, packet);
        setState((current) => patchMessage(current, threadId, packet.id, { status: 'sent' }));
      } catch {
        // It remains queued and will retry after the peer reconnects.
      }
    },
    [floodPacket, identity.id, ingest, noredPeers, peers, resolveThreadId, sendPacket],
  );

  const sendPreparedMedia = useCallback(
    async (
      peerId: string,
      mediaKind: 'image' | 'audio',
      prepared: {
        uri: string;
        mimeType: string;
        byteLength: number;
        hash: string;
        width?: number;
        height?: number;
        durationMs?: number;
      },
      id: string,
    ) => {
      const threadId = resolveThreadId(peerId);
      const thread = stateRef.current.threads.find((item) => item.id === threadId);
      const bytes = await fileBytes(prepared.uri);
      const isGroup = thread?.kind === 'group';
      const manifest = makeMediaManifest({
        id,
        senderId: identity.id,
        recipientId: isGroup ? identity.id : threadId,
        groupId: isGroup ? thread.id : undefined,
        hops: isGroup ? 0 : undefined,
        ttlHops: isGroup ? GROUP_TTL_HOPS : undefined,
        mediaKind,
        mimeType: prepared.mimeType,
        byteLength: prepared.byteLength,
        chunkCount: Math.ceil(bytes.byteLength / MEDIA_CHUNK_BYTES),
        hash: prepared.hash,
        width: prepared.width,
        height: prepared.height,
        durationMs: prepared.durationMs,
      });
      const name = isGroup
        ? thread.name
        : peerName(noredPeers, threadId, peerName(peers, threadId, 'Nearby peer'));
      appendMediaMessage(manifest, name, true, prepared.uri, 'queued', false);
      if (isGroup) {
        const targets = floodTargets();
        if (!targets.length) return;
        try {
          for (const peer of targets) {
            await transmitMedia(peer.id, { ...manifest, recipientId: peer.id }, bytes);
          }
          setState((current) =>
            patchMessage(current, thread.id, manifest.id, { status: 'sent', transferProgress: 1 }),
          );
        } catch (error) {
          setState((current) =>
            patchMessage(current, thread.id, manifest.id, {
              transferError: error instanceof Error ? error.message : 'Media transfer failed.',
            }),
          );
        }
        return;
      }
      const canSend = noredPeers.some(
        (peer) => peer.id === threadId && peer.identityConfirmed,
      );
      if (!canSend) return;
      try {
        await transmitMedia(threadId, manifest, bytes);
      } catch (error) {
        setState((current) =>
          patchMessage(current, threadId, manifest.id, {
            transferError: error instanceof Error ? error.message : 'Media transfer failed.',
          }),
        );
      }
    },
    [
      appendMediaMessage,
      floodTargets,
      identity.id,
      noredPeers,
      peers,
      resolveThreadId,
      transmitMedia,
    ],
  );

  const sendImage = useCallback(
    async (peerId: string, sourceUri: string, width: number, height: number) => {
      const id = createId();
      const prepared = await prepareImage(sourceUri, id, width, height);
      await sendPreparedMedia(peerId, 'image', prepared, id);
    },
    [sendPreparedMedia],
  );

  const sendVoiceNote = useCallback(
    async (peerId: string, sourceUri: string, durationMs: number) => {
      const id = createId();
      const prepared = await persistVoiceNote(sourceUri, id);
      await sendPreparedMedia(
        peerId,
        'audio',
        { ...prepared, durationMs: Math.min(durationMs, 60_000) },
        id,
      );
    },
    [sendPreparedMedia],
  );

  const messagesFor = useCallback(
    (threadId: string) => state.messages[resolveThreadId(threadId)] ?? [],
    [resolveThreadId, state.messages],
  );

  const threads = useMemo(
    () =>
      state.threads.map((thread) => {
        if (thread.kind === 'group') {
          const memberNames = { ...thread.memberNames };
          let changed = false;
          for (const memberId of thread.memberIds) {
            if (memberId === identity.id) {
              if (memberNames[memberId] !== identity.name) {
                memberNames[memberId] = identity.name;
                changed = true;
              }
              continue;
            }
            const live = peerName(noredPeers, memberId, peerName(peers, memberId, memberNames[memberId] ?? ''));
            if (live && live !== memberNames[memberId]) {
              memberNames[memberId] = live;
              changed = true;
            }
          }
          return changed ? { ...thread, memberNames } : thread;
        }
        const name = peerName(noredPeers, thread.peerId, peerName(peers, thread.peerId, thread.name));
        return name === thread.name ? thread : { ...thread, name };
      }),
    [identity.id, identity.name, noredPeers, peers, state.threads],
  );

  const threadFor = useCallback(
    (threadId: string) =>
      threads.find((thread) => thread.id === resolveThreadId(threadId)),
    [resolveThreadId, threads],
  );

  const totalUnread = useMemo(
    () => threads.reduce((total, thread) => total + thread.unread, 0),
    [threads],
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
      sendImage,
      sendVoiceNote,
      totalUnread,
      markRead,
      clearActive,
      clearLocalData,
    }),
    [
      clearActive,
      clearLocalData,
      createGroup,
      inviteToGroup,
      markRead,
      messagesFor,
      openDm,
      sendImage,
      sendText,
      sendVoiceNote,
      threadFor,
      threads,
      totalUnread,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const value = useContext(ChatContext);
  if (!value) throw new Error('useChat must be used inside ChatProvider');
  return value;
}
