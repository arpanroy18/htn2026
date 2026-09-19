import {
  AudioQuality,
  IOSOutputFormat,
  type RecordingOptions,
} from 'expo-audio';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import {
  copyAsync,
  cacheDirectory,
  EncodingType,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';
import { Image } from 'expo-image';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { base64ToBytes, bytesToBase64 } from './mediaTransfer';

export const MAX_IMAGE_BYTES = 120 * 1024;
export const MAX_IMAGE_SIDE = 720;
export const MAX_VOICE_SECONDS = 60;

export type PreparedMedia = {
  uri: string;
  mimeType: string;
  byteLength: number;
  hash: string;
};

export type PreparedImage = PreparedMedia & {
  width: number;
  height: number;
};

export const VOICE_RECORDING_OPTIONS: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 32_000,
  directory: 'document',
  isMeteringEnabled: false,
  android: {
    extension: '.m4a',
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
    sampleRate: 16_000,
    maxFileSize: 180 * 1024,
  },
  ios: {
    extension: '.m4a',
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.LOW,
    sampleRate: 16_000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/mp4',
    bitsPerSecond: 16_000,
  },
};

function mediaDirectory() {
  const directory = new Directory(Paths.document, 'nored-media');
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function destinationFile(id: string, extension: string) {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = new File(mediaDirectory(), `${safeId}.${extension.replace(/^\./, '')}`);
  if (file.exists) file.delete();
  return file;
}

function normalizeLocalUri(sourceUri: string) {
  if (
    sourceUri.startsWith('file://') ||
    sourceUri.startsWith('content://') ||
    sourceUri.startsWith('ph://') ||
    sourceUri.startsWith('assets-library://') ||
    sourceUri.startsWith('data:')
  ) {
    return sourceUri;
  }
  if (sourceUri.startsWith('/')) {
    return `file://${sourceUri}`;
  }
  return sourceUri;
}

/** Photo picker URIs on iOS are often ph:// — copy to cache before File/ImageManipulator touch them. */
export async function materializeLocalUri(sourceUri: string, fallbackExtension: string) {
  const uri = normalizeLocalUri(sourceUri);
  if (uri.startsWith('file://')) {
    return uri;
  }
  if (!cacheDirectory) {
    throw new Error('Cache directory is unavailable.');
  }
  const extension = uri.includes('.')
    ? uri.split('.').pop()?.split('?')[0] ?? fallbackExtension
    : fallbackExtension;
  const destination = `${cacheDirectory}nored-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`;
  try {
    await copyAsync({ from: uri, to: destination });
    return destination;
  } catch {
    return uri;
  }
}

function copyBytes(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export async function sha256(bytes: Uint8Array) {
  const data = copyBytes(bytes);
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data.buffer);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function paddedBase64(value: string) {
  const clean = value.replace(/\s/g, '');
  const pad = (4 - (clean.length % 4)) % 4;
  return clean + '='.repeat(pad);
}

export async function fileBytes(uri: string) {
  const localUri = await materializeLocalUri(uri, 'bin');
  try {
    const file = new File(localUri);
    if (file.exists) {
      return copyBytes(await file.bytes());
    }
  } catch {
    // Some Android content/file URIs throw from the new File API; fall back below.
  }
  try {
    const base64 = await readAsStringAsync(localUri, { encoding: EncodingType.Base64 });
    return base64ToBytes(paddedBase64(base64));
  } catch {
    throw new Error('The media file could not be read.');
  }
}

export async function writeMediaBytes(
  id: string,
  extension: string,
  bytes: Uint8Array,
) {
  const payload = copyBytes(bytes);
  const destination = destinationFile(id, extension);
  try {
    destination.create({ intermediates: true, overwrite: true });
    destination.write(payload);
    return destination.uri;
  } catch {
    await writeAsStringAsync(destination.uri, bytesToBase64(payload), {
      encoding: EncodingType.Base64,
    });
    return destination.uri;
  }
}

async function persistFile(sourceUri: string, id: string, extension: string): Promise<PreparedMedia> {
  const localUri = await materializeLocalUri(sourceUri, extension);
  const destination = destinationFile(id, extension);
  await copyAsync({ from: localUri, to: destination.uri });
  const bytes = await fileBytes(destination.uri);
  return {
    uri: destination.uri,
    mimeType: extension === 'jpg' ? 'image/jpeg' : 'audio/mp4',
    byteLength: bytes.byteLength,
    hash: await sha256(bytes),
  };
}

export async function persistVoiceNote(
  sourceUri: string,
  id: string,
): Promise<PreparedMedia> {
  if (!sourceUri) {
    throw new Error('The voice note file was missing after recording.');
  }
  return persistFile(sourceUri, id, 'm4a');
}

function scaledSize(width: number, height: number, maxSide: number) {
  const longest = Math.max(width, height, 1);
  if (longest <= maxSide) {
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  }
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function prepareImage(
  sourceUri: string,
  id: string,
  sourceWidth?: number,
  sourceHeight?: number,
): Promise<PreparedImage> {
  const materializedUri = await materializeLocalUri(sourceUri, 'jpg');
  let quality = 0.55;
  let maxSide = MAX_IMAGE_SIDE;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const loaded = await Image.loadAsync(materializedUri, {
        maxWidth: maxSide,
        maxHeight: maxSide,
      });
      try {
        const target = scaledSize(
          loaded.width || sourceWidth || maxSide,
          loaded.height || sourceHeight || maxSide,
          maxSide,
        );
        const context = ImageManipulator.manipulate(loaded);
        if (loaded.width > target.width || loaded.height > target.height) {
          context.resize({ width: target.width, height: target.height });
        }
        const rendered = await context.renderAsync();
        try {
          const saved = await rendered.saveAsync({
            compress: quality,
            format: SaveFormat.JPEG,
          });
          const persisted = await persistFile(saved.uri, id, 'jpg');
          if (persisted.byteLength <= MAX_IMAGE_BYTES) {
            return {
              ...persisted,
              width: saved.width,
              height: saved.height,
            };
          }
        } finally {
          rendered.release();
        }
      } finally {
        loaded.release();
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('The image could not be prepared.');
    }
    quality = Math.max(0.2, quality - 0.1);
    maxSide = Math.max(240, Math.round(maxSide * 0.75));
  }

  throw lastError ?? new Error('This image could not be compressed enough to send over Bluetooth.');
}
