declare module 'react-native-audio-converter' {
  export type ConvertToWavOptions = {
    outputPath?: string;
    sampleRate?: number;
    channels?: number;
  };

  export function convertToWav(
    inputPath: string,
    options?: ConvertToWavOptions,
  ): Promise<string>;

  export function convertToWavForSpeech(
    inputPath: string,
    outputPath?: string,
  ): Promise<string>;
}
