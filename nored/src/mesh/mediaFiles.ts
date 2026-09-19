import {
  AudioQuality,
  IOSOutputFormat,
  type RecordingOptions,
} from 'expo-audio';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';

export const MAX_IMAGE_BYTES = 120 * 1024;
export const MAX_IMAGE_SIDE = 720;
export const MAX_VOICE_SECONDS = 60;
/** isPacket() rejects manifests past 512 chunks, and the chunker cuts at MEDIA_CHUNK_BYTES. */
export const MAX_MEDIA_BYTES = 512 * 2048;

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
  // Recordings are copied into the media store as soon as they stop, so the
  // cache is the right home for the raw take.
  directory: 'cache',
  isMeteringEnabled: false,
  android: {
    extension: '.m4a',
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
    sampleRate: 16_000,
    // 60s at 32kbps is ~240KB; a tighter cap silently truncates the tail.
    maxFileSize: 320 * 1024,
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

function mediaFile(id: string, extension: string) {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_') || 'media';
  return new File(mediaDirectory(), `${safeId}.${extension.replace(/^\./, '')}`);
}

function normalizeUri(value: string) {
  if (!value) throw new Error('The media file was missing.');
  return value.startsWith('/') ? `file://${value}` : value;
}

/**
 * Native `digest` takes `(algorithm, output: TypedArray, data: TypedArray)` on both
 * platforms — its `BufferSource` type is wider than what it actually accepts. Passing
 * `bytes.buffer` fails argument conversion ("Calling the 'digest' function has failed"),
 * so hand it the view itself; `rawPointer` applies `byteOffset` natively.
 */
export async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export async function fileBytes(uri: string) {
  const file = new File(normalizeUri(uri));
  if (!file.exists) {
    throw new Error('That attachment is no longer stored on this phone.');
  }
  const bytes = await file.bytes();
  if (!bytes.byteLength) throw new Error('The attachment file was empty.');
  return bytes;
}

export async function writeMediaBytes(
  id: string,
  extension: string,
  bytes: Uint8Array,
) {
  const file = mediaFile(id, extension);
  file.create({ intermediates: true, overwrite: true });
  file.write(bytes);
  return file.uri;
}

async function persistBytes(
  id: string,
  extension: string,
  mimeType: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<PreparedMedia> {
  return {
    uri: await writeMediaBytes(id, extension, bytes),
    mimeType,
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
  const bytes = await fileBytes(sourceUri);
  if (bytes.byteLength > MAX_MEDIA_BYTES) {
    throw new Error('That voice note is too long to send over Bluetooth.');
  }
  return persistBytes(id, 'm4a', 'audio/mp4', bytes);
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

/** The picker reports dimensions for every asset; decoding is only the fallback. */
async function sourceSize(uri: string, width?: number, height?: number) {
  if (width && height && width > 0 && height > 0) return { width, height };
  const probe = await ImageManipulator.manipulate(uri).renderAsync();
  try {
    return { width: probe.width, height: probe.height };
  } finally {
    probe.release();
  }
}

// Progressively smaller/softer passes; the first one under the byte budget wins.
const IMAGE_PASSES = [
  { maxSide: MAX_IMAGE_SIDE, quality: 0.6 },
  { maxSide: MAX_IMAGE_SIDE, quality: 0.4 },
  { maxSide: 560, quality: 0.4 },
  { maxSide: 420, quality: 0.35 },
  { maxSide: 320, quality: 0.3 },
  { maxSide: 240, quality: 0.25 },
];

export async function prepareImage(
  sourceUri: string,
  id: string,
  sourceWidth?: number,
  sourceHeight?: number,
): Promise<PreparedImage> {
  const uri = normalizeUri(sourceUri);
  const original = await sourceSize(uri, sourceWidth, sourceHeight);
  let lastError: Error | undefined;

  for (const pass of IMAGE_PASSES) {
    let rendered: ImageRef | undefined;
    try {
      const target = scaledSize(original.width, original.height, pass.maxSide);
      const context = ImageManipulator.manipulate(uri);
      if (target.width < original.width || target.height < original.height) {
        context.resize(target);
      }
      rendered = await context.renderAsync();
      const saved = await rendered.saveAsync({
        compress: pass.quality,
        format: SaveFormat.JPEG,
      });
      const bytes = await fileBytes(saved.uri);
      if (bytes.byteLength <= MAX_IMAGE_BYTES) {
        return {
          ...(await persistBytes(id, 'jpg', 'image/jpeg', bytes)),
          width: saved.width,
          height: saved.height,
        };
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('The photo could not be prepared.');
    } finally {
      rendered?.release();
    }
  }

  throw (
    lastError ??
    new Error('This photo could not be compressed small enough to send over Bluetooth.')
  );
}
