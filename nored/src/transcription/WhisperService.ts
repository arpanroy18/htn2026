import { File } from 'expo-file-system';
import * as Device from 'expo-device';
import { initWhisper, type WhisperContext } from 'whisper.rn';

import {
  ensureWavSidecar,
  isAudioConverterLinked,
  needsWavConversion,
  resolveVoiceNoteFile,
  transcriptionSidecarFor,
} from './audioSidecar';
import { extractPcm16FromWav } from './extractPcm16FromWav';
import {
  normalizeTranscriptionResult,
  type TranscriptionResult,
} from './normalizeTranscriptionResult';

const IDLE_RELEASE_MS = 3 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const WHISPER_MODEL = require('../../assets/models/ggml-tiny.bin') as number;

let context: WhisperContext | null = null;
let initPromise: Promise<WhisperContext | null> | null = null;
let queue = Promise.resolve<TranscriptionOutcome>({ result: null });
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let lastTranscriptionError: string | undefined;

export type TranscriptionOutcome = {
  result: TranscriptionResult | null;
  error?: string;
};

export function getLastTranscriptionError() {
  return lastTranscriptionError;
}

export { ensureWavSidecar } from './audioSidecar';

function setTranscriptionError(error: string | undefined) {
  lastTranscriptionError = error;
  if (error && __DEV__) {
    console.warn(`[WhisperService] ${error}`);
  }
}

function scheduleIdleRelease() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void releaseWhisper();
  }, IDLE_RELEASE_MS);
}

async function createWhisperContext(useGpu: boolean) {
  return initWhisper({
    filePath: WHISPER_MODEL,
    useGpu,
    useCoreMLIos: true,
  });
}

async function ensureWhisperReady(): Promise<WhisperContext | null> {
  if (context) return context;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      context = await createWhisperContext(true);
      return context;
    } catch (gpuError) {
      try {
        context = await createWhisperContext(false);
        return context;
      } catch (cpuError) {
        const message =
          cpuError instanceof Error
            ? cpuError.message
            : gpuError instanceof Error
              ? gpuError.message
              : 'Whisper failed to initialize.';
        setTranscriptionError(`Model init failed: ${message}`);
        return null;
      }
    }
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

async function resolveWavForTranscription(sourceFile: File): Promise<File> {
  const sidecar = transcriptionSidecarFor(sourceFile);
  if (sidecar.exists && sidecar.size > 44) return sidecar;

  const prepared = await ensureWavSidecar(sourceFile.uri);
  if (prepared) return prepared;

  if (!needsWavConversion(sourceFile.uri)) {
    return sourceFile;
  }

  if (!isAudioConverterLinked()) {
    throw new Error(
      'Audio conversion native module is missing. Rebuild with npm run ios:device.',
    );
  }

  throw new Error('Could not convert the voice note to WAV for transcription.');
}

async function transcribePreparedAudio(
  whisperContext: WhisperContext,
  wavFile: File,
): Promise<TranscriptionResult | null> {
  try {
    const { promise } = whisperContext.transcribe(wavFile.uri, { maxThreads: 4 });
    return normalizeTranscriptionResult(await promise);
  } catch (fileError) {
    if (__DEV__) {
      const message = fileError instanceof Error ? fileError.message : String(fileError);
      console.warn(`[WhisperService] transcribe(file) fallback to PCM: ${message}`);
    }
    const pcm = extractPcm16FromWav(await wavFile.bytes()).pcm;
    const { promise } = whisperContext.transcribeData(pcm, { maxThreads: 4 });
    return normalizeTranscriptionResult(await promise);
  }
}

async function runTranscription(fileUri: string): Promise<TranscriptionOutcome> {
  if (!Device.isDevice) {
    return { result: null, error: 'Transcription requires a physical device.' };
  }

  const whisperContext = await ensureWhisperReady();
  if (!whisperContext) {
    return {
      result: null,
      error: lastTranscriptionError ?? 'Whisper model is unavailable on this device.',
    };
  }

  try {
    const sourceFile = resolveVoiceNoteFile(fileUri);
    if (!sourceFile.exists) {
      throw new Error('The voice note file is no longer on this phone.');
    }

    const wavFile = await resolveWavForTranscription(sourceFile);
    const result = await transcribePreparedAudio(whisperContext, wavFile);
    if (!result) {
      throw new Error('Whisper returned no text for this voice note.');
    }

    setTranscriptionError(undefined);
    return { result };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Transcription failed.';
    setTranscriptionError(message);
    return { result: null, error: message };
  }
}

export async function transcribeVoiceNote(fileUri: string): Promise<TranscriptionOutcome> {
  const next = queue.then(() => runTranscription(fileUri));
  queue = next.catch(() => ({ result: null }));
  const outcome = await next;
  scheduleIdleRelease();
  return outcome;
}

export async function releaseWhisper(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!context) return;
  await context.release();
  context = null;
}
