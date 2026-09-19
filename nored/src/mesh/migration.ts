import type { ChatState } from './chatStore';
import type { RouterStore } from './routerStore';
import { DAY, envelope } from './protocol.ts';

export function validateLegacyHistory(value: unknown): ChatState {
  if (!value || typeof value !== 'object') throw new Error('Existing chat history is invalid; the original file has been preserved.');
  const data = value as Partial<ChatState>;
  if (!Array.isArray(data.threads) || !data.messages || typeof data.messages !== 'object' || Array.isArray(data.messages) ||
      !data.threads.every((thread) => thread && typeof thread.id === 'string' && typeof thread.name === 'string') ||
      !Object.values(data.messages).every((messages) => Array.isArray(messages) && messages.every((message) =>
        message && typeof message.id === 'string' && typeof message.senderId === 'string' &&
        typeof message.body === 'string' && typeof message.mine === 'boolean' && Number.isFinite(message.timestamp)))) {
    throw new Error('Existing chat history is invalid; the original file has been preserved.');
  }
  return data as ChatState;
}

export async function importHistory(store: RouterStore, history: ChatState, now = Date.now()) {
  await store.transaction((d) => {
    if (d.imported) return;
    d.chat = history;
    for (const [threadId, messages] of Object.entries(history.messages)) for (const message of messages) {
      d.seen[message.id] = Math.max(now + DAY, message.timestamp + 2 * DAY);
      if (message.mine && message.kind === 'text' && message.status === 'queued') {
        const value = envelope({ version: 1, type: 'text', id: message.id, senderId: message.senderId,
          recipientId: threadId, timestamp: message.timestamp, payload: message.body }, true);
        if (value.expiresAt > now) d.packets[message.id] = { envelope: value, state: 'queued', receipts: [] };
        else message.status = 'expired';
      }
    }
    d.imported = true;
  });
}
