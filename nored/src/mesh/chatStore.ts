import type {
  GroupMember,
  GroupSyncPacket,
  MediaKind,
  MediaManifestPacket,
  Packet,
  Peer,
  TextPacket,
} from '@/transport';

export type ChatDelivery = 'queued' | 'sent' | 'relayed' | 'failed';

export const MAX_GROUP_MEMBERS = 8;
export const MAX_GROUPS = 20;
export const GROUP_TTL_HOPS = 5;

export type ChatThread = {
  id: string;
  kind: 'dm' | 'group';
  peerId: string;
  memberIds: string[];
  memberNames: Record<string, string>;
  name: string;
  preview: string;
  updatedAt: number;
  unread: number;
  queued: boolean;
};

export type ChatMessage = {
  id: string;
  threadId: string;
  senderId: string;
  sender: string;
  mine: boolean;
  kind: 'text' | 'image' | 'audio';
  body: string;
  localUri?: string;
  mimeType?: string;
  byteLength?: number;
  hash?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  transferProgress?: number;
  transferError?: string;
  status?: ChatDelivery;
  time: string;
  timestamp: number;
};

export type ChatState = {
  threads: ChatThread[];
  messages: Record<string, ChatMessage[]>;
};

export const emptyChatState: ChatState = { threads: [], messages: {} };

export function normalizeChatState(state: ChatState | null | undefined): ChatState {
  if (!state || !Array.isArray(state.threads) || !state.messages) return emptyChatState;
  return {
    threads: state.threads.map((thread) => {
      const kind = thread.kind === 'group' ? 'group' : 'dm';
      const peerId = thread.peerId || thread.id;
      const memberIds = Array.isArray(thread.memberIds)
        ? thread.memberIds
        : kind === 'dm'
          ? [peerId]
          : [];
      return {
        ...thread,
        kind,
        peerId,
        memberIds,
        memberNames: thread.memberNames ?? {},
        unread: thread.unread ?? 0,
        queued: Boolean(thread.queued),
      };
    }),
    messages: state.messages,
  };
}

export function createId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

export function formatThreadTime(timestamp: number) {
  const delta = Date.now() - timestamp;
  if (delta < 45_000) return 'now';
  if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))}m`;
  if (delta < 86_400_000) return `${Math.max(1, Math.floor(delta / 3_600_000))}h`;
  return `${Math.max(1, Math.floor(delta / 86_400_000))}d`;
}

export function formatMessageClock(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function makeTextPacket(input: {
  senderId: string;
  recipientId: string;
  body: string;
  groupId?: string;
  hops?: number;
  ttlHops?: number;
}): TextPacket {
  return {
    version: 1,
    id: createId(),
    senderId: input.senderId,
    recipientId: input.recipientId,
    groupId: input.groupId,
    hops: input.hops,
    ttlHops: input.ttlHops,
    type: 'text',
    timestamp: Date.now(),
    payload: input.body,
  };
}

export function isTextPacket(value: Packet): value is TextPacket {
  return value?.type === 'text' && typeof value.payload === 'string' && typeof value.id === 'string';
}

export function makeGroupSyncPacket(input: {
  id?: string;
  senderId: string;
  groupId: string;
  name: string;
  members: GroupMember[];
  hops?: number;
  ttlHops?: number;
}): GroupSyncPacket {
  return {
    version: 1,
    id: input.id ?? createId(),
    senderId: input.senderId,
    recipientId: input.groupId,
    groupId: input.groupId,
    hops: input.hops ?? 0,
    ttlHops: input.ttlHops ?? GROUP_TTL_HOPS,
    type: 'group-sync',
    timestamp: Date.now(),
    name: input.name.trim(),
    members: uniqueMembers(input.members).slice(0, MAX_GROUP_MEMBERS),
  };
}

export function isGroupSyncPacket(value: Packet): value is GroupSyncPacket {
  return value?.type === 'group-sync';
}

export function makeMediaManifest(input: {
  id: string;
  senderId: string;
  recipientId: string;
  mediaKind: MediaKind;
  mimeType: string;
  byteLength: number;
  chunkCount: number;
  hash: string;
  width?: number;
  height?: number;
  durationMs?: number;
  timestamp?: number;
  groupId?: string;
  hops?: number;
  ttlHops?: number;
}): MediaManifestPacket {
  return {
    version: 1,
    id: input.id,
    senderId: input.senderId,
    recipientId: input.recipientId,
    groupId: input.groupId,
    hops: input.hops,
    ttlHops: input.ttlHops,
    type: 'media-manifest',
    timestamp: input.timestamp ?? Date.now(),
    mediaKind: input.mediaKind,
    mimeType: input.mimeType,
    byteLength: input.byteLength,
    chunkCount: input.chunkCount,
    hash: input.hash,
    width: input.width,
    height: input.height,
    durationMs: input.durationMs,
  };
}

function uniqueMembers(members: GroupMember[]): GroupMember[] {
  const byId = new Map<string, GroupMember>();
  for (const member of members) {
    const id = member.id.trim().toLowerCase();
    if (!id) continue;
    const name = member.name.trim() || byId.get(id)?.name || 'Nearby peer';
    byId.set(id, { id, name });
  }
  return [...byId.values()];
}

export function messagePreview(message: Pick<ChatMessage, 'kind' | 'body'>) {
  if (message.kind === 'image') return 'Photo';
  if (message.kind === 'audio') return 'Voice message';
  return message.body;
}

function upsertThread(threads: ChatThread[], next: ChatThread) {
  const index = threads.findIndex((thread) => thread.id === next.id);
  if (index === -1) return [next, ...threads];
  const copy = threads.slice();
  copy.splice(index, 1);
  return [next, ...copy];
}

export function ensureDmThread(
  state: ChatState,
  peerId: string,
  name: string,
): ChatState {
  const existing = state.threads.find((thread) => thread.id === peerId);
  if (existing) {
    if (existing.name === name) return state;
    return {
      ...state,
      threads: state.threads.map((thread) =>
        thread.id === peerId ? { ...thread, name } : thread,
      ),
    };
  }
  return {
    ...state,
    threads: upsertThread(state.threads, {
      id: peerId,
      kind: 'dm',
      peerId,
      memberIds: [peerId],
      memberNames: { [peerId]: name },
      name,
      preview: 'No messages yet',
      updatedAt: Date.now(),
      unread: 0,
      queued: false,
    }),
    messages: state.messages[peerId] ? state.messages : { ...state.messages, [peerId]: [] },
  };
}

export function groupCount(state: ChatState) {
  return state.threads.filter((thread) => thread.kind === 'group').length;
}

export function ensureGroupThread(
  state: ChatState,
  input: { id: string; name: string; members: GroupMember[] },
): ChatState {
  const members = uniqueMembers(input.members).slice(0, MAX_GROUP_MEMBERS);
  const existing = state.threads.find((thread) => thread.id === input.id);
  if (!existing && groupCount(state) >= MAX_GROUPS) return state;

  const memberIds = uniqueIds([...(existing?.memberIds ?? []), ...members.map((member) => member.id)]).slice(
    0,
    MAX_GROUP_MEMBERS,
  );
  const memberNames = { ...(existing?.memberNames ?? {}) };
  for (const member of members) memberNames[member.id] = member.name;
  if (existing?.kind === 'group') {
    const name = input.name.trim() || existing.name;
    const same =
      existing.name === name &&
      existing.memberIds.length === memberIds.length &&
      existing.memberIds.every((id, index) => id === memberIds[index]) &&
      memberIds.every((id) => memberNames[id] === existing.memberNames[id]);
    if (same) return state;
    return {
      ...state,
      threads: state.threads.map((thread) =>
        thread.id === input.id ? { ...thread, name, memberIds, memberNames } : thread,
      ),
    };
  }

  const thread: ChatThread = {
    id: input.id,
    kind: 'group',
    peerId: input.id,
    memberIds,
    memberNames,
    name: input.name.trim() || 'Group',
    preview: existing?.preview ?? 'No messages yet',
    updatedAt: existing?.updatedAt ?? Date.now(),
    unread: existing?.unread ?? 0,
    queued: existing?.queued ?? false,
  };
  return {
    threads: upsertThread(
      state.threads.filter((item) => item.id !== input.id),
      thread,
    ),
    messages: state.messages[input.id] ? state.messages : { ...state.messages, [input.id]: [] },
  };
}

export function addGroupMember(
  state: ChatState,
  groupId: string,
  member: GroupMember,
): ChatState {
  const thread = state.threads.find((item) => item.id === groupId && item.kind === 'group');
  if (!thread) return state;
  if (thread.memberIds.includes(member.id)) {
    if (thread.memberNames[member.id] === member.name) return state;
    return {
      ...state,
      threads: state.threads.map((item) =>
        item.id === groupId
          ? { ...item, memberNames: { ...item.memberNames, [member.id]: member.name } }
          : item,
      ),
    };
  }
  if (thread.memberIds.length >= MAX_GROUP_MEMBERS) return state;
  return {
    ...state,
    threads: state.threads.map((item) =>
      item.id === groupId
        ? {
            ...item,
            memberIds: [...item.memberIds, member.id],
            memberNames: { ...item.memberNames, [member.id]: member.name },
          }
        : item,
    ),
  };
}

function uniqueIds(ids: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    const value = id.trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function appendMessage(
  state: ChatState,
  message: ChatMessage,
  threadName: string,
  unread: boolean,
): ChatState {
  const previous = state.messages[message.threadId] ?? [];
  if (previous.some((item) => item.id === message.id)) return state;
  const messages = [...previous, message].slice(-1000);
  const queued = messages.some((item) => item.mine && item.status === 'queued');
  const current = state.threads.find((item) => item.id === message.threadId);
  const kind = current?.kind ?? 'dm';
  const thread: ChatThread = {
    id: message.threadId,
    kind,
    peerId: kind === 'group' ? (current?.peerId ?? message.threadId) : message.threadId,
    memberIds: current?.memberIds ?? (kind === 'dm' ? [message.threadId] : []),
    memberNames: current?.memberNames ?? {},
    name: kind === 'group' ? (current?.name ?? threadName) : threadName,
    preview: messagePreview(message),
    updatedAt: message.timestamp,
    unread: unread ? (current?.unread ?? 0) + 1 : (current?.unread ?? 0),
    queued,
  };
  return {
    threads: upsertThread(state.threads, thread),
    messages: { ...state.messages, [message.threadId]: messages },
  };
}

export function migrateDmPeer(
  state: ChatState,
  previousPeerId: string,
  peerId: string,
  name: string,
): ChatState {
  if (previousPeerId === peerId) return state;
  const previousThread = state.threads.find((thread) => thread.id === previousPeerId);
  const currentThread = state.threads.find((thread) => thread.id === peerId);
  const previousMessages = state.messages[previousPeerId] ?? [];
  const currentMessages = state.messages[peerId] ?? [];
  if (!previousThread && previousMessages.length === 0) return state;

  const byId = new Map<string, ChatMessage>();
  for (const message of [...currentMessages, ...previousMessages]) {
    byId.set(message.id, { ...message, threadId: peerId });
  }
  const messages = [...byId.values()].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  const latest = messages.at(-1);
  const updatedAt = Math.max(
    currentThread?.updatedAt ?? 0,
    previousThread?.updatedAt ?? 0,
    latest?.timestamp ?? 0,
  );
  const thread: ChatThread = {
    id: peerId,
    kind: 'dm',
    peerId,
    memberIds: [peerId],
    memberNames: { [peerId]: name || currentThread?.name || previousThread?.name || 'Nearby peer' },
    name: name || currentThread?.name || previousThread?.name || 'Nearby peer',
    preview: latest ? messagePreview(latest) : currentThread?.preview ?? previousThread?.preview ?? 'No messages yet',
    updatedAt,
    unread: (currentThread?.unread ?? 0) + (previousThread?.unread ?? 0),
    queued: messages.some((message) => message.mine && message.status === 'queued'),
  };
  const remainingThreads = state.threads.filter(
    (item) => item.id !== previousPeerId && item.id !== peerId,
  );
  const nextMessages = { ...state.messages, [peerId]: messages };
  delete nextMessages[previousPeerId];
  return {
    threads: [thread, ...remainingThreads].sort((left, right) => right.updatedAt - left.updatedAt),
    messages: nextMessages,
  };
}

export function patchMessage(
  state: ChatState,
  threadId: string,
  messageId: string,
  patch: Partial<ChatMessage>,
): ChatState {
  const previous = state.messages[threadId];
  if (!previous) return state;
  const messages = previous.map((item) => (item.id === messageId ? { ...item, ...patch } : item));
  const queued = messages.some((item) => item.mine && item.status === 'queued');
  return {
    messages: { ...state.messages, [threadId]: messages },
    threads: state.threads.map((thread) =>
      thread.id === threadId ? { ...thread, queued } : thread,
    ),
  };
}

export function markThreadRead(state: ChatState, threadId: string): ChatState {
  const thread = state.threads.find((item) => item.id === threadId);
  if (!thread || thread.unread === 0) return state;
  return {
    ...state,
    threads: state.threads.map((item) => (item.id === threadId ? { ...item, unread: 0 } : item)),
  };
}

export function remapPeerInGroups(
  state: ChatState,
  previousPeerId: string,
  peerId: string,
  name: string,
): ChatState {
  if (previousPeerId === peerId) return state;
  let changed = false;
  const threads = state.threads.map((thread) => {
    if (thread.kind !== 'group' || !thread.memberIds.includes(previousPeerId)) return thread;
    changed = true;
    const memberIds = uniqueIds(thread.memberIds.map((id) => (id === previousPeerId ? peerId : id)));
    const memberNames = { ...thread.memberNames };
    memberNames[peerId] = name || memberNames[previousPeerId] || memberNames[peerId] || 'Nearby peer';
    delete memberNames[previousPeerId];
    return { ...thread, memberIds, memberNames };
  });
  return changed ? { ...state, threads } : state;
}

export function queuedPackets(state: ChatState, peerId: string, senderId: string): Packet[] {
  return (state.messages[peerId] ?? [])
    .filter((item) => item.mine && item.status === 'queued' && item.kind === 'text')
    .map((item) => ({
      version: 1 as const,
      id: item.id,
      senderId,
      recipientId: peerId,
      type: 'text' as const,
      timestamp: item.timestamp,
      payload: item.body,
    }));
}

export function queuedGroupText(state: ChatState): ChatMessage[] {
  return state.threads
    .filter((thread) => thread.kind === 'group')
    .flatMap((thread) =>
      (state.messages[thread.id] ?? []).filter(
        (item) => item.mine && item.status === 'queued' && item.kind === 'text',
      ),
    );
}

export function queuedGroupMedia(state: ChatState, groupId: string) {
  return (state.messages[groupId] ?? []).filter(
    (message) =>
      message.mine &&
      message.status === 'queued' &&
      (message.kind === 'image' || message.kind === 'audio'),
  );
}

export function packetThreadId(packet: Packet, mine: boolean) {
  if (packet.groupId) return packet.groupId;
  return mine ? packet.recipientId : packet.senderId;
}

export function memberDisplayName(thread: ChatThread | undefined, peerId: string, fallback: string) {
  return thread?.memberNames[peerId] ?? fallback;
}

export function peerName(peers: Peer[], peerId: string, fallback: string) {
  return peers.find((peer) => peer.id === peerId)?.name ?? fallback;
}

export function threadHasMember(thread: ChatThread | undefined, peerId: string) {
  return Boolean(thread?.memberIds.includes(peerId));
}
