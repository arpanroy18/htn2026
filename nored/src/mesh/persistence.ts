import { openDatabaseAsync } from 'expo-sqlite';
import { SqlPersistence, type SqlDriver } from './routerStore';
import { loadChatState } from './chatPersistence';
export async function createPersistence() {
  const database = await openDatabaseAsync('nored-mesh.db');
  return new SqlPersistence(database as unknown as SqlDriver);
}
export const loadLegacyHistory = loadChatState;

export { clearLegacyHistory } from './chatPersistence';
