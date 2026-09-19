import {
  AudioQuality,
  IOSOutputFormat,
  type RecordingOptions,
} from 'expo-audio';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

export const MAX_IMAGE_BYTES = 200 * 1024;
export const MAX_IMAGE_SIDE = 1024;
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
  bitRate: 16_000,
  directory: 'cache',
  isMeteringEnabled: true,
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

export async function sha256(bytes: Uint8Array) {
  const data = bytes.slice().buffer as ArrayBuffer;
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export async function fileBytes(uri: string) {
  return new File(uri).bytes();
}

export async function writeMediaBytes(
  id: string,
  extension: string,
  bytes: Uint8Array,
) {
  const destination = destinationFile(id, extension);
  destination.create({ intermediates: true, overwrite: true });
  destination.write(bytes);
  return destination.uri;
}

export async function persistVoiceNote(
  sourceUri: string,
  id: string,
): Promise<PreparedMedia> {
  const source = new File(sourceUri);
  const destination = destinationFile(id, 'm4a');
  source.copy(destination);
  const bytes = await destination.bytes();
  return {
    uri: destination.uri,
    mimeType: 'audio/mp4',
    byteLength: bytes.byteLength,
    hash: await sha256(bytes),
  };
}

export async function prepareImage(
  sourceUri: string,
  id: string,
  sourceWidth: number,
  sourceHeight: number,
): Promise<PreparedImage> {
  let width = sourceWidth;
  let height = sourceHeight;
  if (Math.max(width, height) > MAX_IMAGE_SIDE) {
    const scale = MAX_IMAGE_SIDE / Math.max(width, height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  let quality = 0.6;
  let attempts = 0;
  let renderedUri = sourceUri;
  let renderedWidth = width;
  let renderedHeight = height;

  while (attempts < 5) {
    const context = ImageManipulator.manipulate(renderedUri);
    if (attempts === 0 && (width !== sourceWidth || height !== sourceHeight)) {
      context.resize({ width, height });
    } else if (attempts > 0) {
      renderedWidth = Math.max(320, Math.round(renderedWidth * 0.82));
      renderedHeight = Math.max(320, Math.round(renderedHeight * 0.82));
      context.resize({ width: renderedWidth, height: renderedHeight });
    }
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ compress: quality, format: SaveFormat.JPEG });
    renderedUri = saved.uri;
    renderedWidth = saved.width;
    renderedHeight = saved.height;
    if (new File(renderedUri).size <= MAX_IMAGE_BYTES) break;
    quality = Math.max(0.25, quality - 0.1);
    attempts += 1;
  }

  const temporary = new File(renderedUri);
  if (temporary.size > MAX_IMAGE_BYTES) {
    throw new Error('This image could not be compressed below 200 KB.');
  }
  const destination = destinationFile(id, 'jpg');
  temporary.copy(destination);
  const bytes = await destination.bytes();
  return {
    uri: destination.uri,
    mimeType: 'image/jpeg',
    byteLength: bytes.byteLength,
    hash: await sha256(bytes),
    width: renderedWidth,
    height: renderedHeight,
  };
}
