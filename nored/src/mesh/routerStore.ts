import type { ChatState, ChatDelivery } from './chatStore';
import type { AlertItem } from './alertStore';
import type { Envelope } from './protocol';

export type Contact = { id: string; name: string; addedAt: number };
export type PacketRecord = { envelope: Envelope; state: ChatDelivery; receipts: string[] };
export type RouterData = {
  packets: Record<string, PacketRecord>;
  seen: Record<string, number>;
  contacts: Record<string, Contact>;
  chat: ChatState;
  alerts: AlertItem[];
  events: { packetId: string; peerId: string; timestamp: number; action: string }[];
  imported: boolean;
};
export const emptyData = (): RouterData => ({ packets: {}, seen: {}, contacts: {},
  chat: { threads: [], messages: {} }, alerts: [], events: [], imported: false });
export interface Persistence {
  load(): Promise<RouterData | null>;
  commit(next: RouterData, previous: RouterData): Promise<void>;
}
export class RouterStore {
  data = emptyData();
  private tail: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private persistence: Persistence;
  constructor(persistence: Persistence) { this.persistence = persistence; }
  async init() { this.data = await this.persistence.load() ?? emptyData(); }
  subscribe(callback: () => void) { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; }
  transaction(change: (draft: RouterData) => void, persist = true): Promise<void> {
    const work = this.tail.then(async () => {
      if (!persist) {
        const draft: RouterData = { ...this.data };
        change(draft);
        if (draft === this.data) return;
        this.data = draft;
        for (const listener of this.listeners) listener();
        return;
      }
      const draft: RouterData = JSON.parse(JSON.stringify(this.data));
      change(draft);
      if (JSON.stringify(draft) === JSON.stringify(this.data)) return;
      await this.persistence.commit(draft, this.data);
      this.data = draft;
      for (const listener of this.listeners) listener();
    });
    this.tail = work.catch(() => undefined);
    return work;
  }
}

// Same SQL and transaction path on native SQLite and the Node SQLite test adapter.
export interface SqlDriver {
  execAsync(sql: string): Promise<unknown>;
  getAllAsync<T>(sql: string): Promise<T[]>;
  runAsync(sql: string, ...params: string[]): Promise<unknown>;
  withExclusiveTransactionAsync(task: (tx: SqlDriver) => Promise<void>): Promise<void>;
}
function rows(data: RouterData) {
  const result = new Map<string, string>();
  for (const collection of ['packets', 'seen', 'contacts'] as const) {
    for (const [key, value] of Object.entries(data[collection])) result.set(`${collection}:${key}`, JSON.stringify(value));
  }
  for (const key of ['chat', 'alerts', 'events', 'imported'] as const) result.set(key, JSON.stringify(data[key]));
  return result;
}
export class SqlPersistence implements Persistence {
  private db: SqlDriver;
  constructor(db: SqlDriver) { this.db = db; }
  async load() {
    await this.db.execAsync('PRAGMA journal_mode=WAL;');
    const versions = await this.db.getAllAsync<{ user_version: number }>('PRAGMA user_version');
    if (versions[0]?.user_version > 1) throw new Error('This message database requires a newer Nored version.');
    if (!versions[0]?.user_version) await this.db.withExclusiveTransactionAsync(async (tx) => {
      await tx.execAsync('CREATE TABLE IF NOT EXISTS mesh_records (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=1;');
    });
    const records = await this.db.getAllAsync<{ key: string; value: string }>('SELECT key,value FROM mesh_records');
    if (!records.length) return null;
    const data = emptyData();
    for (const { key, value } of records) {
      const colon = key.indexOf(':');
      if (colon > 0) {
        const collection = key.slice(0, colon) as 'packets' | 'seen' | 'contacts';
        if (['packets', 'seen', 'contacts'].includes(collection)) data[collection][key.slice(colon + 1)] = JSON.parse(value);
      } else if (['chat', 'alerts', 'events', 'imported'].includes(key)) {
        Object.assign(data, { [key]: JSON.parse(value) });
      }
    }
    return data;
  }
  async commit(next: RouterData, previous: RouterData) {
    const before = rows(previous), after = rows(next);
    await this.db.withExclusiveTransactionAsync(async (tx) => {
      for (const key of before.keys()) if (!after.has(key)) await tx.runAsync('DELETE FROM mesh_records WHERE key=?', key);
      for (const [key, value] of after) if (before.get(key) !== value) {
        await tx.runAsync('INSERT OR REPLACE INTO mesh_records(key,value) VALUES (?,?)', key, value);
      }
    });
  }
}
