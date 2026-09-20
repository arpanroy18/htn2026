export type WhisperTranscriptionPayload = {
  result: string;
  language: string;
  isAborted: boolean;
};

export type TranscriptionResult = {
  text: string;
  language: string;
};

const WHISPER_ARTIFACT =
  /(?:\(|\[)\s*speaking foreign language\s*(?:\)|\])|(?:\(|\[)\s*speaks foreign language\s*(?:\)|\])/i;

export function isWhisperArtifactText(text: string) {
  const sample = text.trim();
  if (!sample) return true;
  return WHISPER_ARTIFACT.test(sample);
}

export function normalizeTranscriptionResult(
  payload: WhisperTranscriptionPayload | null | undefined,
): TranscriptionResult | null {
  if (!payload || payload.isAborted) return null;
  const text = payload.result
    .replace(/\[(?:BLANK_AUDIO|SILENCE|MUSIC|NOISE|.*?)\]/gi, ' ')
    .replace(/\(silence\)/gi, ' ')
    .replace(WHISPER_ARTIFACT, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text === '.' || text === '...' || isWhisperArtifactText(text)) return null;
  const language = payload.language.trim() || 'auto';
  return { text, language };
}
