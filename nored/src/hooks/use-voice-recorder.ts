import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type AudioMode,
} from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking } from 'react-native';

import { MAX_VOICE_SECONDS, VOICE_RECORDING_OPTIONS } from '@/mesh/mediaFiles';

export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'saving';

/** Below this a tap on the mic is a mis-tap, not a voice note. */
const MIN_RECORDING_MS = 400;

const CAPTURE_MODE: Partial<AudioMode> = {
  allowsRecording: true,
  playsInSilentMode: true,
  interruptionMode: 'doNotMix',
  shouldPlayInBackground: false,
};

const PLAYBACK_MODE: Partial<AudioMode> = {
  allowsRecording: false,
  playsInSilentMode: true,
  interruptionMode: 'mixWithOthers',
};

function describe(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : '';
  if (!message) return fallback;
  // A dev build made before expo-audio was added has no native recorder at all.
  if (/ExpoAudio|native module|NativeModule/i.test(message)) {
    return `${message}\n\nRebuild the app so audio support is included:\nnpx expo run:ios --device`;
  }
  return message;
}

/**
 * Owns the whole recorder lifecycle: permission, audio session, the 60s cap and
 * teardown. The audio session is always restored to playback — leaving it in
 * record mode is what used to leave playback silent after a failed take.
 */
export function useVoiceRecorder(onRecorded: (uri: string, durationMs: number) => Promise<void>) {
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [durationMs, setDurationMs] = useState(0);
  const prepared = useRef(false);
  const startedAt = useRef<number | null>(null);
  const limitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const onRecordedRef = useRef(onRecorded);

  useEffect(() => {
    onRecordedRef.current = onRecorded;
  }, [onRecorded]);

  const clearLimit = useCallback(() => {
    if (limitTimer.current) {
      clearTimeout(limitTimer.current);
      limitTimer.current = null;
    }
  }, []);

  const releaseRecorder = useCallback(async () => {
    if (!prepared.current) return;
    prepared.current = false;
    try {
      await recorder.stop();
    } finally {
      await setAudioModeAsync(PLAYBACK_MODE).catch(() => undefined);
    }
  }, [recorder]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearLimit();
      void releaseRecorder().catch(() => undefined);
    };
  }, [clearLimit, releaseRecorder]);

  useEffect(() => {
    if (status !== 'recording') return;
    const interval = setInterval(() => {
      if (startedAt.current != null) setDurationMs(Date.now() - startedAt.current);
    }, 100);
    return () => clearInterval(interval);
  }, [status]);

  const finish = useCallback(
    async (send: boolean) => {
      clearLimit();
      if (startedAt.current == null && !prepared.current) {
        setStatus('idle');
        setDurationMs(0);
        return;
      }
      const elapsed = startedAt.current != null ? Date.now() - startedAt.current : 0;
      startedAt.current = null;
      setStatus(send ? 'saving' : 'idle');
      setDurationMs(0);

      try {
        await releaseRecorder();
        if (!send) return;
        if (elapsed < MIN_RECORDING_MS) {
          Alert.alert('Nothing recorded', 'Hold the mic button a little longer to record a voice note.');
          return;
        }
        const uri = recorder.uri;
        if (!uri) throw new Error('The recording file was not available.');
        await onRecordedRef.current(uri, Math.min(elapsed, MAX_VOICE_SECONDS * 1000));
      } catch (error) {
        Alert.alert('Voice note not sent', describe(error, 'The voice note could not be prepared.'));
      } finally {
        if (mounted.current) setStatus('idle');
      }
    },
    [clearLimit, recorder, releaseRecorder],
  );

  const start = useCallback(async () => {
    if (status !== 'idle') return;
    setStatus('starting');
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setStatus('idle');
        Alert.alert(
          'Microphone permission needed',
          'Allow microphone access to record a voice note.',
          permission.canAskAgain
            ? undefined
            : [
                { text: 'Not now', style: 'cancel' },
                { text: 'Open Settings', onPress: () => void Linking.openSettings() },
              ],
        );
        return;
      }
      await setAudioModeAsync(CAPTURE_MODE);
      await recorder.prepareToRecordAsync(VOICE_RECORDING_OPTIONS);
      prepared.current = true;
      recorder.record();
      if (!mounted.current) {
        await releaseRecorder();
        return;
      }
      startedAt.current = Date.now();
      setDurationMs(0);
      setStatus('recording');
      limitTimer.current = setTimeout(() => void finish(true), MAX_VOICE_SECONDS * 1000);
    } catch (error) {
      await releaseRecorder().catch(() => undefined);
      startedAt.current = null;
      if (mounted.current) setStatus('idle');
      Alert.alert('Could not record', describe(error, 'Voice recording could not start.'));
    }
  }, [finish, recorder, releaseRecorder, status]);

  return {
    status,
    durationMs,
    start: useCallback(() => void start(), [start]),
    cancel: useCallback(() => void finish(false), [finish]),
    send: useCallback(() => void finish(true), [finish]),
  };
}
