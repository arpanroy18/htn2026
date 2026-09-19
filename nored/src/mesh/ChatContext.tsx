import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';

import {
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
  ensureDmThread,
  formatMessageClock,
  makeMediaManifest,
  makeTextPacket,
  markThreadRead,
  migrateDmPeer,
  patchMessage,
  peerName,
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
import { useRouterService, useRouterData } from './RouterContext';
import { clearLegacyHistory } from './persistence';
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
  const meshRouter = useRouterService();
  const data = useRouterData();
  const state = data.chat;
  const setState = useCallback((change: (current: ChatState) => ChatState) => {
    const epoch = meshRouter.epoch;
    const result = meshRouter.store.transaction((draft) => {
      if (epoch !== meshRouter.epoch) return;
      draft.chat = change(draft.chat);
      stateRef.current = draft.chat;
    });
    void result.catch((error) => console.warn('[STORE]', error instanceof Error ? error.message : 'Write failed'));
    return result;
  }, [meshRouter]);
  const stateRef = useRef(state);
  const peersRef = useRef(peers);
  const seenIds = useRef(new Set<string>());
  const activeThread = useRef<string | null>(null);
  const peerAliases = useRef(new Map<string, string>());
  const flushing = useRef(new Set<string>());
  const lastFlushAt = useRef(new Map<string, number>());
  const mediaReceiveTail = useRef(Promise.resolve());
  const mediaSending = useRef(new Set<string>());
  const incomingTransfers = useRef(new Map<string, IncomingTransfer>());
  const outgoingTransfers = useRef(
    new Map<string, { manifest: MediaManifestPacket; chunks: MediaChunkPacket[] }>(),
  );

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
  }, [peers, resolvePeerId, setState]);

  const remember = useCallback((id: string) => {
    seenIds.current.add(id);
    if (seenIds.current.size > 500) {
      seenIds.current = new Set([...seenIds.current].slice(-250));
    }
  }, []);

  const sendPacket = useCallback(async (peerId: string, packet: Packet) => {
    await meshRouter.sendDirect(peerId, packet, packet.type === 'media-chunk' && outgoingTransfers.current.get(packet.transferId)?.manifest.mediaKind === 'audio' ? 4 : undefined);
  }, [meshRouter]);

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
      return setState((current) => appendMessage(current, message, threadName, unread));
    },
    [remember, setState],
  );

  const transmitMedia = useCallback(
    async (
      peerId: string,
      manifest: MediaManifestPacket,
      bytes: Uint8Array,
      onlySequences?: number[],
    ) => {
      if (mediaSending.current.has(manifest.id)) return;
      const epoch = meshRouter.epoch;
      mediaSending.current.add(manifest.id);
      try {
        const allChunks = splitMediaBytes({ manifest, bytes });
        outgoingTransfers.current.set(manifest.id, { manifest, chunks: allChunks });
        const chunks = onlySequences
          ? onlySequences.map((sequence) => allChunks[sequence]).filter(Boolean)
          : allChunks;
        if (!onlySequences) await sendPacket(peerId, manifest);
        for (let index = 0; index < chunks.length; index += 1) {
          if (epoch !== meshRouter.epoch) throw new Error('Transfer cancelled.');
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
      } finally { mediaSending.current.delete(manifest.id); }
    },
    [sendPacket, setState, meshRouter],
  );

  const sendStoredMedia = useCallback(
    async (peerId: string, message: ChatMessage) => {
      if (!message.localUri || !message.hash || !message.mimeType || !message.byteLength) return;
      const epoch = meshRouter.epoch;
      const bytes = await fileBytes(message.localUri);
      if (epoch !== meshRouter.epoch) return;
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
    [identity.id, transmitMedia, meshRouter],
  );

  const flushPeer = useCallback(
    async (peerId: string) => {
      peerId = resolvePeerId(peerId);
      if (flushing.current.has(peerId)) return;
      const pendingMedia = (stateRef.current.messages[peerId] ?? []).filter(
        (message) =>
          message.mine &&
          message.status === 'queued' &&
          (message.kind === 'image' || message.kind === 'audio'),
      );
      if (!pendingMedia.length) return;
      const last = lastFlushAt.current.get(peerId) ?? 0;
      if (Date.now() - last < 2000) return;
      flushing.current.add(peerId);
      lastFlushAt.current.set(peerId, Date.now());
      try {
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
    [resolvePeerId, sendStoredMedia],
  );

  const handlePacket = useCallback(
    async (packet: Packet) => {
      if (packet.senderId === identity.id || packet.recipientId !== identity.id) return;
      const name = meshRouter.name(packet.senderId);

      const epoch = meshRouter.epoch;
      if (packet.type === 'media-manifest') {
        if (incomingTransfers.current.has(packet.id)) return;
        if ((stateRef.current.messages[packet.senderId] ?? []).some((message) => message.id === packet.id && !!message.localUri)) {
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
        await appendMediaMessage(
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
          if (epoch !== meshRouter.epoch) return;
          const localUri = await writeMediaBytes(transfer.manifest.id, extension, bytes);
          if (epoch !== meshRouter.epoch) return;
          incomingTransfers.current.delete(packet.transferId);
          await setState((current) =>
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
        if (!outgoing || outgoing.manifest.recipientId !== packet.senderId) return;
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
        if (!outgoing || outgoing.manifest.recipientId !== packet.senderId) return;
        for (const sequence of packet.missing) {
          const chunk = outgoing.chunks[sequence];
          if (chunk) await sendPacket(packet.senderId, chunk);
        }
      }
    },
    [appendMediaMessage, identity.id, sendPacket, meshRouter, setState],
  );

  useEffect(() => {
    const subscription = meshRouter.onApplicationPacket((packet) => {
      const epoch = meshRouter.epoch;
      mediaReceiveTail.current = mediaReceiveTail.current.then(() => epoch === meshRouter.epoch ? handlePacket(packet) : undefined).catch((error) => console.warn('[MEDIA]', error instanceof Error ? error.message : 'Receive failed'));
    });
    return () => subscription.remove();
  }, [handlePacket, meshRouter]);

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
        void sendPacket(transfer.manifest.senderId, retry).catch(() => undefined);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [identity.id, sendPacket, setState]);

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
  }, [resolvePeerId, setState]);

  const markRead = useCallback((threadId: string) => {
    const resolvedId = resolvePeerId(threadId);
    activeThread.current = resolvedId;
    meshRouter.setActiveThread(resolvedId);
    setState((current) => markThreadRead(current, resolvedId));
  }, [resolvePeerId, setState, meshRouter]);

  const clearActive = useCallback(() => {
    activeThread.current = null;
    meshRouter.setActiveThread(null);
  }, [meshRouter]);

  const clearLocalData = useCallback(async () => {
    seenIds.current.clear();
    incomingTransfers.current.clear();
    outgoingTransfers.current.clear();
    activeThread.current = null;
    await meshRouter.clear();
    await clearLegacyHistory();
  }, [meshRouter]);

  const sendText = useCallback(
    async (peerId: string, body: string) => {
      peerId = resolvePeerId(peerId);
      const text = body.trim();
      if (!text) return;
      await meshRouter.enqueue(makeTextPacket({ senderId: identity.id, recipientId: peerId, body: text }));
    },
    [identity.id, resolvePeerId, meshRouter],
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
      const epoch = meshRouter.epoch;
      const bytes = await fileBytes(prepared.uri);
      if (epoch !== meshRouter.epoch) return;
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
      await appendMediaMessage(manifest, name, true, prepared.uri, 'queued', false);
      if (epoch !== meshRouter.epoch) return;
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
      setState,
      meshRouter,
    ],
  );

  const sendImage = useCallback(
    async (peerId: string, sourceUri: string, width: number, height: number) => {
      const epoch = meshRouter.epoch;
      const id = createId();
      const prepared = await prepareImage(sourceUri, id, width, height);
      if (epoch !== meshRouter.epoch) return;
      await sendPreparedMedia(peerId, 'image', prepared, id);
    },
    [sendPreparedMedia, meshRouter],
  );

  const sendVoiceNote = useCallback(
    async (peerId: string, sourceUri: string, durationMs: number) => {
      const epoch = meshRouter.epoch;
      const id = createId();
      const prepared = await persistVoiceNote(sourceUri, id);
      if (epoch !== meshRouter.epoch) return;
      await sendPreparedMedia(
        peerId,
        'audio',
        { ...prepared, durationMs: Math.min(durationMs, 60_000) },
        id,
      );
    },
    [sendPreparedMedia, meshRouter],
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
