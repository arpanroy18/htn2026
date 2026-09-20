// Scripts where Whisper transcribe is usually more accurate than speech-to-English.
const NON_LATIN_SCRIPT =
  /[\u0900-\u097F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\u0600-\u06FF\u0400-\u04FF\u0E00-\u0E7F\u0590-\u05FF\u0370-\u03FF]/;

/** Prefer Apple/ML Kit text translation over Whisper audio translate. */
export function preferTextTranslation(transcript: string): boolean {
  const sample = transcript.trim();
  if (!sample) return false;
  return NON_LATIN_SCRIPT.test(sample);
}
