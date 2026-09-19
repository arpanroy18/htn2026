import { File, Paths } from 'expo-file-system';

import { emptyChatState, type ChatState } from './chatStore';

function chatStateFile() {
  return new File(Paths.document, 'nored-chat-state.json');
}

export async function loadChatState(): Promise<ChatState> {
  const file = chatStateFile();
  if (!file.exists) return emptyChatState;
  try {
    const parsed = (await file.json()) as ChatState;
    if (!parsed || !Array.isArray(parsed.threads) || !parsed.messages) {
      return emptyChatState;
    }
    return parsed;
  } catch {
    return emptyChatState;
  }
}

export async function saveChatState(state: ChatState): Promise<void> {
  const file = chatStateFile();
  file.create({ idempotent: true, intermediates: true, overwrite: true });
  file.write(JSON.stringify(state));
}

export async function clearChatState(): Promise<void> {
  const file = chatStateFile();
  if (file.exists) file.delete();
}
