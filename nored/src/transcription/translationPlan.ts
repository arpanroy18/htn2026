import { preferTextTranslation } from './preferTextTranslation.ts';
import {
  normalizeLanguageCode,
  sameLanguage,
  type LanguageCode,
} from './viewerLocale.ts';

export type TranslationStrategy =
  | 'skip'
  | 'whisper-precomputed'
  | 'whisper-audio'
  | 'platform-text';

export function chooseTranslationStrategy(input: {
  transcript: string;
  viewerLocale: string;
  sourceLocale?: string | null;
  whisperTranslation?: string;
  hasAudioFile?: boolean;
}): TranslationStrategy {
  const viewer = normalizeLanguageCode(input.viewerLocale) ?? input.viewerLocale;
  const source = normalizeLanguageCode(input.sourceLocale);

  if (source && sameLanguage(source, viewer) && !input.whisperTranslation) {
    return 'skip';
  }

  const useTextTranslation = preferTextTranslation(input.transcript);

  if (viewer === 'en' && input.whisperTranslation && !useTextTranslation) {
    return 'whisper-precomputed';
  }

  if (
    viewer === 'en' &&
    source &&
    source !== 'en' &&
    input.hasAudioFile &&
    !useTextTranslation
  ) {
    return 'whisper-audio';
  }

  return 'platform-text';
}

export type TranslationScenario = {
  name: string;
  transcript: string;
  viewerLocale: LanguageCode;
  sourceLocale?: LanguageCode;
  whisperTranslation?: string;
  hasAudioFile?: boolean;
  expected: TranslationStrategy;
};

/** Documented matrix for automated + manual device testing. */
export const TRANSLATION_SCENARIOS: TranslationScenario[] = [
  {
    name: 'same language — English',
    transcript: 'hello how are you',
    viewerLocale: 'en',
    sourceLocale: 'en',
    expected: 'skip',
  },
  {
    name: 'French audio → English viewer (Latin transcript)',
    transcript: 'Bonjour, comment allez-vous',
    viewerLocale: 'en',
    sourceLocale: 'fr',
    whisperTranslation: 'Hello, how are you',
    hasAudioFile: true,
    expected: 'whisper-precomputed',
  },
  {
    name: 'French audio → English viewer (fallback to audio translate)',
    transcript: 'Bonjour, comment allez-vous',
    viewerLocale: 'en',
    sourceLocale: 'fr',
    hasAudioFile: true,
    expected: 'whisper-audio',
  },
  {
    name: 'Hindi Devanagari → English viewer',
    transcript: 'नमस्ते, आप कैसे हैं',
    viewerLocale: 'en',
    sourceLocale: 'hi',
    whisperTranslation: 'Hello how are you',
    hasAudioFile: true,
    expected: 'platform-text',
  },
  {
    name: 'Romanized Hindi → English viewer',
    transcript: 'namaste aap kaise hain',
    viewerLocale: 'en',
    sourceLocale: 'hi',
    whisperTranslation: 'Hello, how are you',
    hasAudioFile: true,
    expected: 'whisper-precomputed',
  },
  {
    name: 'Korean Hangul → English viewer',
    transcript: '안녕하세요, 만나서 반갑습니다. 저는 존입니다.',
    viewerLocale: 'en',
    sourceLocale: 'ko',
    whisperTranslation: "Hello, I am director. I'm guest",
    hasAudioFile: true,
    expected: 'platform-text',
  },
  {
    name: 'Korean → English viewer without whisper shortcut',
    transcript: '안녕하세요',
    viewerLocale: 'en',
    sourceLocale: 'ko',
    hasAudioFile: true,
    expected: 'platform-text',
  },
  {
    name: 'English transcript → French viewer',
    transcript: 'hello how are you today',
    viewerLocale: 'fr',
    sourceLocale: 'en',
    hasAudioFile: true,
    expected: 'platform-text',
  },
  {
    name: 'Korean → Korean viewer',
    transcript: '안녕하세요',
    viewerLocale: 'ko',
    sourceLocale: 'ko',
    expected: 'skip',
  },
];
