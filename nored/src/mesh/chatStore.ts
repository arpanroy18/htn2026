import type { Packet, Peer } from '@/transport';

export type ChatDelivery = 'queued' | 'sent' | 'relayed' | 'seen' | 'failed';

export const MAX_GROUP_MEMBERS = 8;
export const MAX_GROUPS = 20;

export type ChatThreadKind = 'dm' | 'group';

export type ChatThread = {
  id: string;
  kind: ChatThreadKind;
  peerId: string;
  name: string;
  preview: string;
  updatedAt: number;
  unread: number;
  queued: boolean;
  memberIds: string[];
};

export type ChatMessage = {
  id: string;
  threadId: string;
  senderId: string;
  sender: string;
  mine: boolean;
  kind: 'text';
  body: string;
  status?: ChatDelivery;
  time: string;
  timestamp: number;
};

export type ChatState = {
  threads: ChatThread[];
  messages: Record<string, ChatMessage[]>;
};

export const emptyChatState: ChatState = { threads: [], messages: {} };

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
  groupName?: string;
  groupMemberIds?: string[];
}): Packet {
  return {
    version: 1,
    id: createId(),
    senderId: input.senderId,
    recipientId: input.recipientId,
    type: 'text',
    timestamp: Date.now(),
    payload: input.body,
    ...(input.groupId
      ? {
          groupId: input.groupId,
          groupName: input.groupName,
          groupMemberIds: input.groupMemberIds,
        }
      : {}),
  };
}

function uniqueIds(ids: string[]) {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of ids) {
    const value = id.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    next.push(value);
  }
  return next;
}

export function groupCount(state: ChatState) {
  return state.threads.filter((thread) => thread.kind === 'group').length;
}

export function isTextPacket(value: Packet): value is Packet {
  return value?.type === 'text' && typeof value.payload === 'string' && typeof value.id === 'string';
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
      name,
      preview: 'No messages yet',
      updatedAt: Date.now(),
      unread: 0,
      queued: false,
      memberIds: [],
    }),
    messages: state.messages[peerId] ? state.messages : { ...state.messages, [peerId]: [] },
  };
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
    name: threadName || current?.name || 'Chat',
    preview: message.body,
    updatedAt: message.timestamp,
    unread: unread ? (current?.unread ?? 0) + 1 : (current?.unread ?? 0),
    queued,
    memberIds: current?.memberIds ?? [],
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
  if (state.threads.some((thread) => thread.kind === 'group' && (thread.id === previousPeerId || thread.id === peerId))) {
    return state;
  }
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
    name: name || currentThread?.name || previousThread?.name || 'Nearby peer',
    preview: latest?.body ?? currentThread?.preview ?? previousThread?.preview ?? 'No messages yet',
    updatedAt,
    unread: (currentThread?.unread ?? 0) + (previousThread?.unread ?? 0),
    queued: messages.some((message) => message.mine && message.status === 'queued'),
    memberIds: [],
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

export function queuedPackets(state: ChatState, peerId: string, senderId: string): Packet[] {
  const thread = state.threads.find((item) => item.id === peerId);
  if (thread?.kind === 'group') return [];
  return (state.messages[peerId] ?? [])
    .filter((item) => item.mine && item.status === 'queued')
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

export function queuedGroupPackets(state: ChatState, groupId: string, senderId: string): Packet[] {
  const thread = state.threads.find((item) => item.id === groupId);
  if (thread?.kind !== 'group') return [];
  return (state.messages[groupId] ?? [])
    .filter((item) => item.mine && item.status === 'queued')
    .map((item) => ({
      version: 1 as const,
      id: item.id,
      senderId,
      recipientId: senderId,
      type: 'text' as const,
      timestamp: item.timestamp,
      payload: item.body,
      groupId: thread.id,
      groupName: thread.name,
      groupMemberIds: thread.memberIds,
    }));
}

export function ensureGroupThread(
  state: ChatState,
  input: { id: string; name: string; memberIds: string[] },
): ChatState {
  const memberIds = uniqueIds(input.memberIds).slice(0, MAX_GROUP_MEMBERS);
  const existing = state.threads.find((thread) => thread.id === input.id);
  if (existing?.kind === 'group') {
    const merged = uniqueIds([...existing.memberIds, ...memberIds]).slice(0, MAX_GROUP_MEMBERS);
    const name = input.name.trim() || existing.name;
    const sameName = name === existing.name;
    const sameMembers =
      merged.length === existing.memberIds.length && merged.every((id) => existing.memberIds.includes(id));
    if (sameName && sameMembers) return state;
    return {
      ...state,
      threads: state.threads.map((thread) =>
        thread.id === input.id ? { ...thread, name, memberIds: merged } : thread,
      ),
    };
  }
  if (existing) return state;
  if (groupCount(state) >= MAX_GROUPS) return state;
  return {
    ...state,
    threads: upsertThread(state.threads, {
      id: input.id,
      kind: 'group',
      peerId: input.id,
      name: input.name.trim() || 'Group',
      preview: 'No messages yet',
      updatedAt: Date.now(),
      unread: 0,
      queued: false,
      memberIds,
    }),
    messages: state.messages[input.id] ? state.messages : { ...state.messages, [input.id]: [] },
  };
}

export function addGroupMember(state: ChatState, groupId: string, memberId: string): ChatState {
  const thread = state.threads.find((item) => item.id === groupId);
  if (thread?.kind !== 'group') return state;
  if (thread.memberIds.includes(memberId)) return state;
  if (thread.memberIds.length >= MAX_GROUP_MEMBERS) return state;
  return {
    ...state,
    threads: state.threads.map((item) =>
      item.id === groupId ? { ...item, memberIds: [...item.memberIds, memberId] } : item,
    ),
  };
}

export function peerName(peers: Peer[], peerId: string, fallback: string) {
  return peers.find((peer) => peer.id === peerId)?.name ?? fallback;
}
