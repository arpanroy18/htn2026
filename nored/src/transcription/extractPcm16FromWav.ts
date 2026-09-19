export type WavPcm16 = {
  pcm: ArrayBuffer;
  sampleRate: number;
  channels: number;
};

function readChunkId(bytes: Uint8Array, offset: number) {
  if (offset + 4 > bytes.length) return '';
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function hasPcmExtensibleSubFormat(
  bytes: Uint8Array,
  fmtDataOffset: number,
  chunkSize: number,
) {
  const pcmSubFormatGuid = [
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00,
    0x38, 0x9b, 0x71,
  ];
  const subFormatOffset = fmtDataOffset + 24;
  if (chunkSize < 40 || subFormatOffset + pcmSubFormatGuid.length > bytes.length) {
    return false;
  }
  return pcmSubFormatGuid.every(
    (value, index) => bytes[subFormatOffset + index] === value,
  );
}

export function extractPcm16FromWav(bytes: Uint8Array): WavPcm16 {
  if (bytes.length < 44) {
    throw new Error('The converted audio file was too small.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readChunkId(bytes, 0) !== 'RIFF' || readChunkId(bytes, 8) !== 'WAVE') {
    throw new Error('The converted audio file was not a valid WAV.');
  }

  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let isPcm = false;
  let hasFmtChunk = false;
  let dataOffset = 0;
  let dataSize = 0;
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const chunkId = readChunkId(bytes, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    if (chunkDataOffset > bytes.length) {
      throw new Error('The converted audio file was malformed.');
    }

    const availableBytes = bytes.length - chunkDataOffset;
    const chunkExceedsFile = chunkSize > availableBytes;
    if (chunkExceedsFile && chunkId !== 'data') {
      throw new Error('The converted audio file was malformed.');
    }

    const effectiveChunkSize = chunkExceedsFile ? availableBytes : chunkSize;
    if (chunkId === 'fmt ') {
      if (chunkSize < 16) {
        throw new Error('The converted audio file was malformed.');
      }
      const audioFormat = view.getUint16(chunkDataOffset, true);
      channels = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
      isPcm =
        audioFormat === 1 ||
        (audioFormat === 0xfffe &&
          hasPcmExtensibleSubFormat(bytes, chunkDataOffset, chunkSize));
      hasFmtChunk = true;
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset;
      dataSize = effectiveChunkSize;
      if (hasFmtChunk) break;
    }

    let nextOffset = chunkDataOffset + effectiveChunkSize;
    if (!chunkExceedsFile && chunkSize % 2 !== 0 && nextOffset < bytes.length) {
      nextOffset += 1;
    }
    if (nextOffset <= offset) {
      throw new Error('The converted audio file was malformed.');
    }
    offset = nextOffset;
  }

  if (!hasFmtChunk || !dataOffset || !dataSize) {
    throw new Error('The converted audio file was missing audio data.');
  }
  if (!isPcm || bitsPerSample !== 16 || !channels || !sampleRate) {
    throw new Error('The converted audio file used an unsupported format.');
  }

  const pcmBytes = bytes.slice(dataOffset, dataOffset + dataSize);
  if (pcmBytes.byteLength < 3200) {
    throw new Error('The voice note was too short to transcribe.');
  }

  if (channels === 1) {
    return {
      pcm: pcmBytes.buffer.slice(
        pcmBytes.byteOffset,
        pcmBytes.byteOffset + pcmBytes.byteLength,
      ),
      sampleRate,
      channels,
    };
  }

  const frameCount = Math.floor(pcmBytes.byteLength / (2 * channels));
  const mono = new Int16Array(frameCount);
  const pcmView = new DataView(
    pcmBytes.buffer,
    pcmBytes.byteOffset,
    pcmBytes.byteLength,
  );
  for (let frame = 0; frame < frameCount; frame += 1) {
    let mixed = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      mixed += pcmView.getInt16((frame * channels + channel) * 2, true);
    }
    mono[frame] = Math.round(mixed / channels);
  }

  return {
    pcm: mono.buffer,
    sampleRate,
    channels: 1,
  };
}
