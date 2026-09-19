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
} from '@/transport';

import { useMeshUi } from './MeshUiContext';
import {
  appendMessage,
  createId,
  emptyChatState,
  ensureDmThread,
  formatMessageClock,
  isTextPacket,
  makeMediaManifest,
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

type ChatUi = {
  threads: ChatThread[];
  threadFor: (threadId: string) => ChatThread | undefined;
  messagesFor: (threadId: string) => ChatMessage[];
  openDm: (peerId: string, name: string) => void;
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

export function ChatProvider({ children }: { children: ReactNode }) {
  const { identity, peers, noredPeers } = useMeshUi();
  const [state, setState] = useState<ChatState>(emptyChatState);
  const [hydrated, setHydrated] = useState(false);
  const stateRef = useRef(state);
  const peersRef = useRef(peers);
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
      const threadId = mine ? manifest.recipientId : manifest.senderId;
      const message: ChatMessage = {
        id: manifest.id,
        threadId,
        senderId: manifest.senderId,
        sender: mine ? 'You' : threadName,
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
      if (!onlySequences) await sendPacket(peerId, manifest);
      for (let index = 0; index < chunks.length; index += 1) {
        await sendPacket(peerId, chunks[index]);
        const completed = onlySequences
          ? undefined
          : Math.min(0.98, (index + 1) / Math.max(1, chunks.length));
        if (completed !== undefined) {
          setState((current) =>
            patchMessage(current, peerId, manifest.id, { transferProgress: completed }),
          );
        }
      }
    },
    [sendPacket],
  );

  const sendStoredMedia = useCallback(
    async (peerId: string, message: ChatMessage) => {
      if (!message.localUri || !message.hash || !message.mimeType || !message.byteLength) return;
      const bytes = await fileBytes(message.localUri);
      const manifest = makeMediaManifest({
        id: message.id,
        senderId: identity.id,
        recipientId: peerId,
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
      await transmitMedia(peerId, manifest, bytes);
    },
    [identity.id, transmitMedia],
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

  const handlePacket = useCallback(
    async (packet: Packet) => {
      if (packet.senderId === identity.id || packet.recipientId !== identity.id) return;
      const name = peerName(peersRef.current, packet.senderId, 'Nearby peer');

      if (isTextPacket(packet)) {
        if (seenIds.current.has(packet.id)) return;
        const unread = activeThread.current !== packet.senderId;
        ingest(packet, name, false, undefined, unread);
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
            type: 'media-ack',
            timestamp: Date.now(),
            transferId: packet.id,
          };
          await sendPacket(packet.senderId, ack);
          return;
        }
        incomingTransfers.current.set(packet.id, createIncomingTransfer(packet));
        appendMediaMessage(
          packet,
          name,
          false,
          undefined,
          undefined,
          activeThread.current !== packet.senderId,
        );
        return;
      }

      if (packet.type === 'media-chunk') {
        const transfer = incomingTransfers.current.get(packet.transferId);
        if (!transfer || !acceptMediaChunk(transfer, packet)) return;
        const received = transfer.chunks.size;
        setState((current) =>
          patchMessage(current, packet.senderId, packet.transferId, {
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
            patchMessage(current, packet.senderId, packet.transferId, {
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
            type: 'media-ack',
            timestamp: Date.now(),
            transferId: packet.transferId,
          };
          await sendPacket(packet.senderId, ack);
        } catch (error) {
          transfer.chunks.clear();
          transfer.updatedAt = 0;
          setState((current) =>
            patchMessage(current, packet.senderId, packet.transferId, {
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
          patchMessage(current, packet.senderId, packet.transferId, {
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
    [appendMediaMessage, identity.id, ingest, sendPacket],
  );

  useEffect(() => {
    const subscription = meshTransport.onPacketReceived((_peerId, packet) => {
      void handlePacket(packet);
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
            patchMessage(current, transfer.manifest.senderId, transfer.manifest.id, {
              transferError: 'Transfer timed out.',
            }),
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
          type: 'media-retry',
          timestamp: now,
          transferId: transfer.manifest.id,
          missing,
        };
        void sendPacket(transfer.manifest.senderId, retry);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [identity.id, sendPacket]);

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
      peerId = resolvePeerId(peerId);
      const bytes = await fileBytes(prepared.uri);
      const manifest = makeMediaManifest({
        id,
        senderId: identity.id,
        recipientId: peerId,
        mediaKind,
        mimeType: prepared.mimeType,
        byteLength: prepared.byteLength,
        chunkCount: Math.ceil(bytes.byteLength / MEDIA_CHUNK_BYTES),
        hash: prepared.hash,
        width: prepared.width,
        height: prepared.height,
        durationMs: prepared.durationMs,
      });
      const name = peerName(noredPeers, peerId, peerName(peers, peerId, 'Nearby peer'));
      appendMediaMessage(manifest, name, true, prepared.uri, 'queued', false);
      const canSend = noredPeers.some(
        (peer) => peer.id === peerId && peer.identityConfirmed,
      );
      if (!canSend) return;
      try {
        await transmitMedia(peerId, manifest, bytes);
      } catch (error) {
        setState((current) =>
          patchMessage(current, peerId, manifest.id, {
            transferError: error instanceof Error ? error.message : 'Media transfer failed.',
          }),
        );
      }
    },
    [
      appendMediaMessage,
      identity.id,
      noredPeers,
      peers,
      resolvePeerId,
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
