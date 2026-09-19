import { File } from 'expo-file-system';
import { NativeModules } from 'react-native';
import { convertToWavForSpeech } from 'react-native-audio-converter';

function normalizeAudioUri(fileUri: string) {
  if (!fileUri) throw new Error('The voice note file was missing.');
  return fileUri.startsWith('/') && !fileUri.startsWith('file://')
    ? `file://${fileUri}`
    : fileUri;
}

function stripFileScheme(fileUri: string) {
  return fileUri.startsWith('file://') ? fileUri.slice(7) : fileUri;
}

export function isAudioConverterLinked() {
  return !!NativeModules.AudioConverter;
}

export function needsWavConversion(fileUri: string) {
  const lower = fileUri.toLowerCase();
  return (
    lower.endsWith('.m4a') ||
    lower.endsWith('.mp4') ||
    lower.endsWith('.aac') ||
    lower.endsWith('.mp3')
  );
}

export function transcriptionSidecarFor(sourceFile: File) {
  const baseName = sourceFile.name.replace(/\.[^.]+$/, '');
  return new File(sourceFile.parentDirectory, `${baseName}.transcribe.wav`);
}

export function resolveVoiceNoteFile(fileUri: string) {
  return new File(normalizeAudioUri(fileUri));
}

export async function ensureWavSidecar(fileUri: string): Promise<File | null> {
  const sourceFile = resolveVoiceNoteFile(fileUri);
  if (!sourceFile.exists) return null;
  if (!needsWavConversion(sourceFile.uri)) return sourceFile;

  const sidecar = transcriptionSidecarFor(sourceFile);
  if (sidecar.exists && sidecar.size > 44) return sidecar;
  if (!isAudioConverterLinked()) return null;

  try {
    if (sidecar.exists) sidecar.delete();
    await convertToWavForSpeech(sourceFile.uri, stripFileScheme(sidecar.uri));
  } catch {
    return null;
  }

  return sidecar.exists && sidecar.size > 44 ? sidecar : null;
}
