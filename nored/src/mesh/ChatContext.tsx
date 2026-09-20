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
  type Peer,
} from '@/transport';

import { ALERT_TTL_HOPS } from './alertStore';
import { useMeshUi } from './MeshUiContext';
import {
  addGroupMember,
  appendMessage,
  createId,
  ensureDmThread,
  ensureGroupThread,
  formatMessageClock,
  GROUP_TTL_HOPS,
  groupCount,
  isAlertThreadId,
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
  clearStaleTranscriptPending,
  patchMessage,
  peerName,
  queuedGroupMedia,
  queuedGroupText,
  remapPeerInGroups,
  threadHasMember,
  type ChatMessage,
  type ChatState,
  type ChatThread,
} from './chatStore';
import {
  clearMediaFiles,
  fileBytes,
  prepareImage,
  persistVoiceNote,
  sha256,
  writeMediaBytes,
} from './mediaFiles';
import { useRouterService, useRouterData } from './RouterContext';
import { clearLegacyHistory } from './persistence';
import { translateTranscript } from '@/transcription/TranslationService';
import { chooseTranslationStrategy } from '@/transcription/translationPlan';
import {
  getViewerLocale,
  normalizeLanguageCode,
  sameLanguage,
} from '@/transcription/viewerLocale';
import {
  transcribeVoiceNote,
  whisperTranslateAudioToEnglish,
} from '@/transcription/WhisperService';
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
  requestTranscript: (threadId: string, messageId: string) => Promise<void>;
};

const ChatContext = createContext<ChatUi | null>(null);

function confirmedPeers(peers: Peer[]) {
  return peers.filter((peer) => peer.identityConfirmed);
}

/**
 * Group sends fan the same transfer out to several peers, so the in-flight chunk
 * list has to be tracked per recipient — keying on the transfer id alone let the
 * last peer overwrite the rest, and their acks and retries were then ignored.
 */
function outgoingKey(transferId: string, recipientId: string) {
  return `${transferId}|${recipientId}`;
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { identity, peers, noredPeers } = useMeshUi();
  const meshRouter = useRouterService();
  const data = useRouterData();
  const state = data.chat;
  const setState = useCallback((change: (current: ChatState) => ChatState, persist = true) => {
    const epoch = meshRouter.epoch;
    const result = meshRouter.store.transaction((draft) => {
      if (epoch !== meshRouter.epoch) return;
      draft.chat = change(draft.chat);
      stateRef.current = draft.chat;
    }, persist);
    void result.catch((error) => console.warn('[STORE]', error instanceof Error ? error.message : 'Write failed'));
    return result;
  }, [meshRouter]);
  const stateRef = useRef(state);
  const peersRef = useRef(peers);
  const noredPeersRef = useRef(noredPeers);
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
    void setState((current) => clearStaleTranscriptPending(current));
  }, [setState]);

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
      if (isAlertThreadId(threadId)) return threadId;
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
  }, [peers, resolvePeerId, setState]);

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
    const mediaKind =
      packet.type === 'media-chunk'
        ? outgoingTransfers.current.get(outgoingKey(packet.transferId, peerId))?.manifest.mediaKind
        : undefined;
    await meshRouter.sendDirect(peerId, packet, mediaKind === 'audio' ? 4 : undefined);
  }, [meshRouter]);

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
      return setState((current) => appendMessage(current, message, threadName, unread));
    },
    [remember, setState],
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
        // Media we already hold on disk is complete; only an inbound transfer starts at 0.
        transferProgress: localUri ? 1 : 0,
        status: mine ? status : undefined,
        timestamp: manifest.timestamp,
        time: formatMessageClock(manifest.timestamp),
      };
      return setState((current) => appendMessage(current, message, threadName, unread));
    },
    [remember, setState],
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
      const key = outgoingKey(manifest.id, peerId);
      if (mediaSending.current.has(key)) return;
      const epoch = meshRouter.epoch;
      mediaSending.current.add(key);
      try {
        const allChunks = splitMediaBytes({ manifest, bytes });
        outgoingTransfers.current.set(key, { manifest, chunks: allChunks });
        const chunks = onlySequences
          ? onlySequences.map((sequence) => allChunks[sequence]).filter(Boolean)
          : allChunks;
        const threadId = mediaThreadId(manifest, peerId);
        if (!onlySequences) {
          setState((current) =>
            patchMessage(current, threadId, manifest.id, { transferProgress: 0, transferError: undefined }),
            false,
          );
          await sendPacket(peerId, manifest);
        }
        for (let index = 0; index < chunks.length; index += 1) {
          if (epoch !== meshRouter.epoch) throw new Error('Transfer cancelled.');
          await sendPacket(peerId, chunks[index]);
          if (!onlySequences) {
            setState((current) =>
              patchMessage(current, threadId, manifest.id, {
                // Every chunk is on the wire once the loop ends; the ack only confirms delivery.
                transferProgress: (index + 1) / Math.max(1, chunks.length),
                transferError: undefined,
              }),
              false,
            );
          }
        }
      } finally { mediaSending.current.delete(key); }
    },
    [mediaThreadId, meshRouter, sendPacket, setState],
  );

  const sendStoredMedia = useCallback(
    async (peerId: string, message: ChatMessage) => {
      if (!message.localUri || !message.hash || !message.mimeType || !message.byteLength) return;
      const epoch = meshRouter.epoch;
      const bytes = await fileBytes(message.localUri);
      if (epoch !== meshRouter.epoch) return;
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
        byteLength: bytes.byteLength,
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
    [floodTargets, identity.id, transmitMedia, meshRouter],
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
    [identity.id, setState],
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
  }, [floodPacket, floodTargets, identity.id, sendStoredMedia, setState]);

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
      const alertComment = isAlertThreadId(groupId);
      const groupThread = groupId
        ? stateRef.current.threads.find((thread) => thread.id === groupId)
        : undefined;
      if (groupId && !alertComment && groupThread && !threadHasMember(groupThread, identity.id)) {
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

      const name = meshRouter.name(packet.senderId);
      const threadName = alertComment ? (groupThread?.name ?? 'Alert') : (groupThread?.name ?? name);
      const threadId = packetThreadId(packet, false);

      if (isTextPacket(packet)) {
        if (seenIds.current.has(packet.id)) return;
        if (groupId) {
          if (alertComment || threadHasMember(groupThread, identity.id)) {
            ingest(packet, threadName, false, undefined, activeThread.current !== threadId);
          } else {
            remember(packet.id);
          }
          void floodPacket({ ...packet, hops: (packet.hops ?? 0) + 1 }, fromPeerId);
          return;
        }
        await ingest(packet, threadName, false, undefined, activeThread.current !== threadId);
        return;
      }

      const epoch = meshRouter.epoch;
      if (packet.type === 'media-manifest') {
        if (incomingTransfers.current.has(packet.id)) return;
        if ((stateRef.current.messages[threadId] ?? []).some((message) => message.id === packet.id && !!message.localUri)) {
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
        if (!groupId || alertComment || threadHasMember(groupThread, identity.id)) {
          incomingTransfers.current.set(packet.id, createIncomingTransfer(packet));
          await appendMediaMessage(
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
        // A duplicate still has to fall through to the completion check below: when
        // the *last* chunk arrived twice, the transfer used to stall at 99% forever.
        if (!seenIds.current.has(packet.id)) {
          remember(packet.id);
          if (groupId) void floodPacket({ ...packet, hops: (packet.hops ?? 0) + 1 }, fromPeerId);
        }
        const transfer = incomingTransfers.current.get(packet.transferId);
        if (!transfer) return;
        const before = transfer.chunks.size;
        if (!acceptMediaChunk(transfer, packet)) return;
        const received = transfer.chunks.size;
        const complete = received === transfer.manifest.chunkCount;
        // Flooding re-delivers chunks constantly; only write when progress moved.
        if (received === before && !complete) return;
        const chunkThreadId = mediaThreadId(transfer.manifest, packet.senderId);
        setState(
          (current) =>
            patchMessage(current, chunkThreadId, packet.transferId, {
              transferProgress: received / transfer.manifest.chunkCount,
            }),
          false,
        );
        if (!complete) return;
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
        const key = outgoingKey(packet.transferId, packet.senderId);
        const outgoing = outgoingTransfers.current.get(key);
        if (!outgoing) return;
        outgoingTransfers.current.delete(key);
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
        const outgoing = outgoingTransfers.current.get(outgoingKey(packet.transferId, packet.senderId));
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
      meshRouter,
      setState,
    ],
  );

  useEffect(() => {
    const subscription = meshRouter.onApplicationPacket((packet, peerId) => {
      const epoch = meshRouter.epoch;
      mediaReceiveTail.current = mediaReceiveTail.current
        .then(() => epoch === meshRouter.epoch ? handlePacket(packet, peerId) : undefined)
        .catch((error) => console.warn('[MEDIA]', error instanceof Error ? error.message : 'Receive failed'));
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
        void sendPacket(transfer.manifest.senderId, retry).catch(() => undefined);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [identity.id, mediaThreadId, sendPacket, setState]);

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
  }, [resolvePeerId, setState]);

  const markRead = useCallback((threadId: string) => {
    const resolvedId = resolveThreadId(threadId);
    activeThread.current = resolvedId;
    meshRouter.setActiveThread(resolvedId);
    setState((current) => markThreadRead(current, resolvedId));
  }, [meshRouter, resolveThreadId, setState]);

  const clearActive = useCallback(() => {
    activeThread.current = null;
    meshRouter.setActiveThread(null);
  }, [meshRouter]);

  const clearLocalData = useCallback(async () => {
    seenIds.current.clear();
    incomingTransfers.current.clear();
    outgoingTransfers.current.clear();
    mediaSending.current.clear();
    flushing.current.clear();
    lastFlushAt.current.clear();
    activeThread.current = null;
    await meshRouter.clear();
    await clearLegacyHistory();
    await clearMediaFiles();
  }, [meshRouter]);

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
    [identity.id, identity.name, publishGroup, resolvePeerId, setState],
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
    [publishGroup, resolvePeerId, resolveThreadId, setState],
  );

  const sendText = useCallback(
    async (peerId: string, body: string) => {
      const text = body.trim();
      if (!text) return;
      const threadId = resolveThreadId(peerId);
      const thread = stateRef.current.threads.find((item) => item.id === threadId);
      const floodAsGroup = isAlertThreadId(threadId) || thread?.kind === 'group';
      if (floodAsGroup) {
        const packet = makeTextPacket({
          senderId: identity.id,
          recipientId: identity.id,
          groupId: threadId,
          hops: 0,
          ttlHops: isAlertThreadId(threadId) ? ALERT_TTL_HOPS : GROUP_TTL_HOPS,
          body: text,
        });
        ingest(packet, thread?.name ?? 'Alert', true, 'queued', false);
        const sent = await floodPacket(packet);
        if (sent > 0) {
          setState((current) => patchMessage(current, threadId, packet.id, { status: 'sent' }));
        }
        return;
      }
      await meshRouter.enqueue(makeTextPacket({ senderId: identity.id, recipientId: threadId, body: text }));
    },
    [floodPacket, identity.id, ingest, meshRouter, resolveThreadId, setState],
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
      const isGroup = isAlertThreadId(threadId) || thread?.kind === 'group';
      const epoch = meshRouter.epoch;
      const bytes = await fileBytes(prepared.uri);
      if (epoch !== meshRouter.epoch) return;
      const manifest = makeMediaManifest({
        id,
        senderId: identity.id,
        recipientId: isGroup ? identity.id : threadId,
        groupId: isGroup ? threadId : undefined,
        hops: isGroup ? 0 : undefined,
        ttlHops: isGroup ? (isAlertThreadId(threadId) ? ALERT_TTL_HOPS : GROUP_TTL_HOPS) : undefined,
        mediaKind,
        mimeType: prepared.mimeType,
        // Both must describe the same byte run the chunker is about to split.
        byteLength: bytes.byteLength,
        chunkCount: Math.ceil(bytes.byteLength / MEDIA_CHUNK_BYTES),
        hash: prepared.hash,
        width: prepared.width,
        height: prepared.height,
        durationMs: prepared.durationMs,
      });
      const name = isGroup
        ? thread?.name ?? 'Alert'
        : peerName(noredPeers, threadId, peerName(peers, threadId, 'Nearby peer'));
      await appendMediaMessage(manifest, name, true, prepared.uri, 'queued', false);
      if (epoch !== meshRouter.epoch) return;
      if (isGroup) {
        const targets = floodTargets();
        if (!targets.length) return;
        try {
          for (const peer of targets) {
            await transmitMedia(peer.id, { ...manifest, recipientId: peer.id }, bytes);
          }
          setState((current) =>
            patchMessage(current, threadId, manifest.id, { status: 'sent', transferProgress: 1 }),
          );
        } catch (error) {
          setState((current) =>
            patchMessage(current, threadId, manifest.id, {
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


  const requestTranscript = useCallback(
    async (threadId: string, messageId: string) => {
      const epoch = meshRouter.epoch;
      const message = (stateRef.current.messages[threadId] ?? []).find(
        (item) => item.id === messageId,
      );
      if (!message || message.kind !== 'audio' || !message.localUri) return;

      const viewerLocale = getViewerLocale();
      const translationComplete =
        message.translationStatus === 'ready' && message.translatedTo === viewerLocale;
      if (message.transcriptStatus === 'ready' && message.transcript && translationComplete) {
        return;
      }
      if (message.transcriptStatus === 'pending' || message.translationStatus === 'pending') {
        return;
      }

      const applyTranslation = async (
        transcript: string,
        options?: {
          fileUri?: string;
          whisperTranslation?: string;
          sourceLocale?: string;
        },
      ) => {
        const sourceLocale =
          normalizeLanguageCode(options?.sourceLocale) ??
          normalizeLanguageCode(message.transcriptLanguage) ??
          undefined;

        if (
          sourceLocale &&
          sameLanguage(sourceLocale, viewerLocale) &&
          !options?.whisperTranslation
        ) {
          await setState((current) =>
            patchMessage(current, threadId, messageId, {
              translation: undefined,
              translationStatus: 'skipped',
              translatedTo: undefined,
              translationError: undefined,
            }),
          );
          return;
        }

        await setState((current) =>
          patchMessage(current, threadId, messageId, {
            translationStatus: 'pending',
            translation: undefined,
            translatedTo: undefined,
            translationError: undefined,
          }),
        );

        const strategy = chooseTranslationStrategy({
          transcript,
          viewerLocale,
          sourceLocale,
          whisperTranslation: options?.whisperTranslation,
          hasAudioFile: Boolean(options?.fileUri),
        });

        if (strategy === 'whisper-precomputed' && options?.whisperTranslation) {
          await setState((current) =>
            patchMessage(current, threadId, messageId, {
              translation: options.whisperTranslation,
              translationStatus: 'ready',
              translatedTo: 'en',
              translationError: undefined,
              ...(sourceLocale ? { transcriptLanguage: sourceLocale } : {}),
            }),
          );
          return;
        }

        if (strategy === 'whisper-audio') {
          const whisperEnglish = await whisperTranslateAudioToEnglish(
            options.fileUri,
            sourceLocale,
          );
          if (epoch !== meshRouter.epoch) return;
          if (whisperEnglish && whisperEnglish.trim() !== transcript.trim()) {
            await setState((current) =>
              patchMessage(current, threadId, messageId, {
                translation: whisperEnglish.trim(),
                translationStatus: 'ready',
                translatedTo: 'en',
                translationError: undefined,
                transcriptLanguage: sourceLocale,
              }),
            );
            return;
          }
        }

        const translation = await translateTranscript(transcript, viewerLocale, sourceLocale);
        if (epoch !== meshRouter.epoch) return;

        const detectedLanguage =
          translation.detectedSourceLanguage ??
          translation.result?.sourceLocale ??
          sourceLocale;

        if (translation.skipped) {
          await setState((current) =>
            patchMessage(current, threadId, messageId, {
              translation: undefined,
              translationStatus: 'skipped',
              translatedTo: undefined,
              translationError: undefined,
              ...(detectedLanguage ? { transcriptLanguage: detectedLanguage } : {}),
            }),
          );
          return;
        }

        if (translation.result) {
          await setState((current) =>
            patchMessage(current, threadId, messageId, {
              translation: translation.result!.text,
              translationStatus: 'ready',
              translatedTo: translation.result!.targetLocale,
              translationError: undefined,
              ...(detectedLanguage ? { transcriptLanguage: detectedLanguage } : {}),
            }),
          );
          return;
        }

        await setState((current) =>
          patchMessage(current, threadId, messageId, {
            translationStatus: 'unavailable',
            translationError: translation.error,
          }),
        );
      };

      if (message.transcriptStatus === 'ready' && message.transcript) {
        await applyTranslation(message.transcript, { fileUri: message.localUri });
        return;
      }

      await setState((current) =>
        patchMessage(current, threadId, messageId, {
          transcriptStatus: 'pending',
          transcript: undefined,
          transcriptLanguage: undefined,
          transcriptError: undefined,
          translation: undefined,
          translationStatus: undefined,
          translatedTo: undefined,
          translationError: undefined,
        }),
      );

      const outcome = await transcribeVoiceNote(message.localUri);
      if (epoch !== meshRouter.epoch) return;

      if (!outcome.result) {
        await setState((current) =>
          patchMessage(current, threadId, messageId, {
            transcriptStatus: 'unavailable',
            transcriptError: outcome.error,
          }),
        );
        return;
      }

      const detectedTranscriptLanguage =
        normalizeLanguageCode(outcome.result!.language) ?? undefined;

      await setState((current) =>
        patchMessage(current, threadId, messageId, {
          transcript: outcome.result!.text,
          transcriptLanguage: detectedTranscriptLanguage,
          transcriptStatus: 'ready',
          transcriptError: undefined,
        }),
      );

      await applyTranslation(outcome.result.text, {
        fileUri: message.localUri,
        whisperTranslation: outcome.whisperTranslation,
        sourceLocale: detectedTranscriptLanguage,
      });
    },
    [meshRouter, setState],
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
      requestTranscript,
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
      requestTranscript,
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
