// Re-export the native module. On web, it will be resolved to NoredBluetoothModule.web.ts
// and on native platforms to NoredBluetoothModule.ts
export { default } from './src/NoredBluetoothModule';
export * from './src/NoredBluetooth.types';
