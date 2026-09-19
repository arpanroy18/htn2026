import type { Persistence, RouterData } from './routerStore';
// Web is a non-BLE preview; no WASM/SharedArrayBuffer or native SQLite dependency.
export async function createPersistence(): Promise<Persistence> {
  return {
    async load() {
      const value = typeof localStorage === 'undefined' ? null : localStorage.getItem('nored-preview');
      return value ? JSON.parse(value) as RouterData : null;
    },
    async commit(next) {
      if (typeof localStorage !== 'undefined') localStorage.setItem('nored-preview', JSON.stringify(next));
    },
  };
}
export async function loadLegacyHistory() { return { threads: [], messages: {} }; }

export async function clearLegacyHistory() {}
