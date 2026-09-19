declare module 'whisper.rn' {
  export type TranscribeResult = {
    result: string;
    language: string;
    segments: { text: string; t0: number; t1: number }[];
    isAborted: boolean;
  };

  export type TranscribeOptions = {
    language?: string;
    translate?: boolean;
    maxThreads?: number;
  };

  export type WhisperContext = {
    transcribe: (
      filePathOrBase64: string | number,
      options?: TranscribeOptions,
    ) => { stop: () => Promise<void>; promise: Promise<TranscribeResult> };
    transcribeData: (
      data: string | ArrayBuffer,
      options?: TranscribeOptions,
    ) => { stop: () => Promise<void>; promise: Promise<TranscribeResult> };
    release: () => Promise<void>;
  };

  export function initWhisper(options: {
    filePath: string | number;
    isBundleAsset?: boolean;
    useGpu?: boolean;
    useCoreMLIos?: boolean;
  }): Promise<WhisperContext>;
}
