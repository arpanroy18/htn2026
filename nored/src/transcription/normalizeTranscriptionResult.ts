export type WhisperTranscriptionPayload = {
  result: string;
  language: string;
  isAborted: boolean;
};

export type TranscriptionResult = {
  text: string;
  language: string;
};

export function normalizeTranscriptionResult(
  payload: WhisperTranscriptionPayload | null | undefined,
): TranscriptionResult | null {
  if (!payload || payload.isAborted) return null;
  const text = payload.result
    .replace(/\[(?:BLANK_AUDIO|SILENCE|MUSIC|NOISE|.*?)\]/gi, ' ')
    .replace(/\(silence\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text === '.' || text === '...') return null;
  const language = payload.language.trim() || 'auto';
  return { text, language };
}
