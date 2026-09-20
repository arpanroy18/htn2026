import assert from 'node:assert/strict';
import test from 'node:test';

import { extractPcm16FromWav, wavDurationSeconds } from './extractPcm16FromWav.ts';

function writeUint32LE(view, offset, value) {
  view.setUint32(offset, value, true);
}

function writeUint16LE(view, offset, value) {
  view.setUint16(offset, value, true);
}

function makeMonoWav(sampleCount, sampleRate = 16_000) {
  const dataSize = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  writeUint32LE(view, 4, 36 + dataSize);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8);
  bytes.set([0x66, 0x6d, 0x74, 0x20], 12);
  writeUint32LE(view, 16, 16);
  writeUint16LE(view, 20, 1);
  writeUint16LE(view, 22, 1);
  writeUint32LE(view, 24, sampleRate);
  writeUint32LE(view, 28, sampleRate * 2);
  writeUint16LE(view, 32, 2);
  writeUint16LE(view, 34, 16);
  bytes.set([0x64, 0x61, 0x74, 0x61], 36);
  writeUint32LE(view, 40, dataSize);

  for (let index = 0; index < sampleCount; index += 1) {
    writeUint16LE(view, 44 + index * 2, index % 1000);
  }

  return bytes;
}

test('extractPcm16FromWav returns mono PCM bytes', () => {
  const wav = makeMonoWav(2_000);
  const result = extractPcm16FromWav(wav);
  assert.equal(result.sampleRate, 16_000);
  assert.equal(result.channels, 1);
  assert.equal(result.pcm.byteLength, 4_000);
});

test('extractPcm16FromWav rejects short audio', () => {
  const wav = makeMonoWav(100);
  assert.throws(() => extractPcm16FromWav(wav), /too short/i);
});

test('wavDurationSeconds measures clip length', () => {
  const threeSeconds = makeMonoWav(16_000 * 3);
  assert.equal(wavDurationSeconds(threeSeconds), 3);
});
