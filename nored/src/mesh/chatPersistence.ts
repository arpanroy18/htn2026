import { File, Paths } from 'expo-file-system';

import { emptyChatState, type ChatState } from './chatStore';
import { validateLegacyHistory } from './migration';

function chatStateFile() {
  return new File(Paths.document, 'nored-chat-state.json');
}

export async function loadChatState(): Promise<ChatState> {
  const file = chatStateFile();
  if (!file.exists) return emptyChatState;
  try {
    return validateLegacyHistory(await file.json());
  } catch {
    throw new Error('Existing chat history could not be imported. The original file has been preserved.');
  }
}

export async function clearLegacyHistory(): Promise<void> {
  const file = chatStateFile();
  if (file.exists) file.delete();
}
