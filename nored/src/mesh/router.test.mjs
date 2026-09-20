import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MeshRouter } from './MeshRouter.ts';
import { RouterStore, SqlPersistence } from './routerStore.ts';
import { ALERT_BURST_COPIES, envelope, DAY, isWirePacket, priority, wireBytes } from './protocol.ts';
import { importHistory, validateLegacyHistory } from './migration.ts';
import { SendScheduler } from './scheduler.ts';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const turn = () => new Promise((r) => setImmediate(r));
class Memory {
  data = null;
  fail = false;
  async load() { return this.data && structuredClone(this.data); }
  async commit(next) { if (this.fail) throw new Error('disk full'); this.data = structuredClone(next); }
}
async function network(count = 3) {
  let clock = 1_000_000;
  const nodes = [], links = new Set(), frames = [], errors = [];
  let drop = () => false;
  for (let i = 0; i < count; i++) {
    const id = uuid(i + 1), persistence = new Memory();
    const store = new RouterStore(persistence); await store.init();
    const transport = {
      getIdentity: () => ({ id, name: `Phone ${i}` }),
      getPeers: async () => nodes.filter((n) => links.has(`${id}|${n.id}`)).map((n) => ({ id: n.id, name: n.id, nored: true, identityConfirmed: true, lastSeen: clock })),
      async sendPacket(peer, packet) {
        if (!links.has(`${id}|${peer}`)) throw new Error('disconnected');
        frames.push({ from: id, to: peer, packet: structuredClone(packet) });
        if (!drop(id, peer, packet)) queueMicrotask(() => { nodes.find((n) => n.id === peer).router.receive(id, structuredClone(packet)).catch((e) => errors.push(e)); });
      },
    };
    nodes.push({ id, store, persistence, transport, router: new MeshRouter(store, transport, () => clock, () => {}) });
  }
  const settle = async () => { for (let i = 0; i < 30; i++) await turn(); };
  const connect = async (a, b) => {
    links.add(`${nodes[a].id}|${nodes[b].id}`); links.add(`${nodes[b].id}|${nodes[a].id}`);
    await Promise.all([nodes[a].router.encounter({ id: nodes[b].id, name: `Phone ${b}`, nored: true, identityConfirmed: true, lastSeen: clock }), nodes[b].router.encounter({ id: nodes[a].id, name: `Phone ${a}`, nored: true, identityConfirmed: true, lastSeen: clock })]);
    await settle();
  };
  const disconnect = (a, b) => {
    links.delete(`${nodes[a].id}|${nodes[b].id}`); links.delete(`${nodes[b].id}|${nodes[a].id}`);
    nodes[a].router.disconnect(nodes[b].id); nodes[b].router.disconnect(nodes[a].id);
  };
  const contact = async (a, b) => { await connect(a, b); await nodes[a].router.addContact(nodes[b].id); disconnect(a, b); };
  const text = (a, b, id = 'message') => ({ version: 1, id, senderId: nodes[a].id, recipientId: nodes[b].id, timestamp: clock, type: 'text', payload: 'Original hello 👋' });
  return { nodes, frames, errors, connect, disconnect, contact, text, settle,
    drop: (fn) => { drop = fn; },
    advance: async (ms) => { clock += ms; await Promise.all(nodes.map((n) => n.router.tick())); await settle(); },
    restart: async (i) => { const n = nodes[i]; n.router.stop(); n.store = new RouterStore(n.persistence); await n.store.init(); n.router = new MeshRouter(n.store, n.transport, () => clock, () => {}); },
  };
}
const incoming = (node) => Object.values(node.store.data.chat.messages).flat().filter((m) => !m.mine);

test('direct upgraded delivery requires destination ACK, not a transport completion', async () => {
  const net = await network(2); await net.connect(0, 1);
  net.drop((a,b,p) => p.type === 'mesh-data' && p.packet.type === 'delivery-ack');
  await net.nodes[0].router.enqueue(net.text(0, 1)); await net.settle();
  assert.equal(incoming(net.nodes[1]).length, 1);
  assert.equal(net.nodes[0].store.data.packets.message.state, 'carrying');
  net.drop(() => false); await net.advance(10_000);
  assert.equal(net.nodes[0].store.data.packets.message.state, 'delivered');
  assert.deepEqual(net.errors, []);
});

test('saved contact: delayed relay survives restart; return ACK reaches origin', async () => {
  const n = await network(); await n.contact(0, 2);
  await n.nodes[0].router.enqueue(n.text(0, 2)); await n.connect(0, 1);
  assert.ok(n.nodes[1].store.data.packets.message);
  assert.equal(incoming(n.nodes[1]).length, 0);
  n.disconnect(0, 1); await n.restart(1); await n.connect(1, 2);
  assert.equal(incoming(n.nodes[2]).length, 1);
  assert.equal(incoming(n.nodes[2])[0].senderId, n.nodes[0].id);
  assert.equal(n.nodes[0].store.data.packets.message.state, 'carrying');
  n.disconnect(1, 2); await n.connect(0, 1);
  assert.equal(n.nodes[0].store.data.packets.message.state, 'delivered');
  assert.deepEqual(n.errors, []);
});

test('four nodes, duplicate paths, and hop boundary', async () => {
  const n = await network(4); await n.contact(0, 3);
  await n.nodes[0].router.enqueue(n.text(0, 3));
  await n.connect(0, 1); n.disconnect(0, 1);
  await n.connect(1, 2); n.disconnect(1, 2);
  await n.connect(2, 3);
  assert.equal(incoming(n.nodes[3]).length, 1);
  assert.equal(n.nodes[3].store.data.packets.message.envelope.hopCount, 3);
  await n.connect(0, 2); await n.connect(1, 3);
  assert.equal(incoming(n.nodes[3]).length, 1);
  assert.equal(n.nodes[0].store.data.packets.message.envelope.hopCount, 0);
  const p = envelope(n.text(0, 3, 'limited')); p.hopLimit = 2;
  await n.nodes[0].store.transaction((d) => { d.packets.limited = { envelope: p, state: 'queued', receipts: [] }; d.seen.limited = p.expiresAt + DAY; });
  n.disconnect(0, 2); n.disconnect(1, 3); await n.connect(0, 1); n.disconnect(0, 1);
  await n.connect(1, 2); await n.advance(31_000);
  assert.equal(n.nodes[2].store.data.packets.limited.envelope.hopCount, 2);
  assert.equal(n.nodes[3].store.data.packets.limited, undefined);
});

test('contacts are explicitly nearby-only; unsaved nearby packets stay direct-only', async () => {
  const n = await network();
  await assert.rejects(n.nodes[0].router.addContact(n.nodes[2].id));
  await assert.rejects(n.nodes[0].router.enqueue(n.text(0, 2)));
  await n.connect(0, 2); n.drop(() => true);
  await n.nodes[0].router.enqueue(n.text(0, 2)); n.disconnect(0, 2); n.drop(() => false);
  await n.connect(0, 1); assert.equal(n.nodes[1].store.data.packets.message, undefined);
  assert.equal(n.nodes[0].store.data.packets.message.envelope.directOnly, true);
});

test('expiry removes routing payloads but keeps chat history', async () => {
  const n = await network(); await n.contact(0, 2); await n.nodes[0].router.enqueue(n.text(0, 2));
  await n.advance(DAY + 1); await n.connect(0, 1);
  assert.equal(n.nodes[0].store.data.packets.message, undefined);
  assert.equal(n.nodes[0].store.data.chat.messages[n.nodes[2].id][0].status, 'expired');
  assert.equal(n.nodes[1].store.data.packets.message, undefined);
});

test('no receipt or application delivery after failed durable acceptance; retry succeeds', async () => {
  const n = await network(2); await n.connect(0, 1); n.nodes[1].persistence.fail = true;
  await n.nodes[0].router.enqueue(n.text(0, 1)); await n.settle();
  assert.equal(incoming(n.nodes[1]).length, 0);
  assert.equal(n.frames.filter((f) => f.from === n.nodes[1].id && f.packet.type === 'mesh-receipt').length, 0);
  n.nodes[1].persistence.fail = false; await n.advance(10_000);
  assert.equal(incoming(n.nodes[1]).length, 1);
});

test('broadcast relays once, preserves timestamp, carries while display disabled', async () => {
  const n = await network(); n.nodes[1].router.listening = false;
  await n.nodes[0].router.enqueue({ ...n.text(0, 2), type: 'alert', recipientId: 'emergency-broadcast', body: 'Help', severity: 'DANGER' });
  await n.connect(0, 1); n.disconnect(0, 1); await n.connect(1, 2);
  assert.equal(n.nodes[1].store.data.alerts.length, 0);
  assert.equal(n.nodes[2].store.data.alerts.length, 1);
  assert.equal(n.nodes[2].store.data.alerts[0].timestamp, n.text(0, 2).timestamp);
  await n.connect(0, 2); assert.equal(n.nodes[2].store.data.alerts.length, 1);
});

const alert = (n, a, id = 'alert-1', severity = 'DANGER') => ({ ...n.text(a, a, id), type: 'alert', recipientId: 'emergency-broadcast', body: 'Help', severity });
const alertFrames = (n, id = 'alert-1') => n.frames.filter((f) => (f.packet.type === 'mesh-data' && f.packet.packet.id === id) || (f.packet.type === 'alert' && f.packet.id === id));

test('alert floods A→B→C through live links with no inventory churn and a same-id burst per hop', async () => {
  const n = await network(3); await n.connect(0, 1); await n.connect(1, 2);
  const controlBefore = n.frames.filter((f) => f.packet.type === 'mesh-inventory').length;
  await n.nodes[0].router.enqueue(alert(n, 0)); await n.settle();
  assert.equal(n.nodes[2].store.data.alerts.length, 1, 'C receives via relay B without any timer tick');
  assert.equal(n.nodes[2].store.data.alerts[0].hops, 2);
  assert.equal(n.nodes[1].store.data.alerts.length, 1);
  assert.equal(n.nodes[0].store.data.alerts[0].mine, true);
  const hops = alertFrames(n);
  assert.equal(hops.filter((f) => f.from === n.nodes[0].id && f.to === n.nodes[1].id).length, ALERT_BURST_COPIES);
  assert.equal(hops.filter((f) => f.from === n.nodes[1].id && f.to === n.nodes[2].id).length, ALERT_BURST_COPIES);
  assert.equal(hops.filter((f) => f.to === n.nodes[0].id).length, 0, 'never echoed back to the previous hop');
  assert.equal(n.frames.filter((f) => f.packet.type === 'mesh-inventory').length, controlBefore, 'a new packet does not trigger inventory re-sends');
  await n.advance(31_000);
  assert.equal(alertFrames(n).length, ALERT_BURST_COPIES * 2, 'receipts stop slower retries; periodic inventory does not resend');
  for (const node of n.nodes) assert.equal(node.store.data.alerts.length, 1);
  assert.deepEqual(n.errors, []);
});

test('alert forwards to a fresh peer before its inventory arrives; duplicates never surface twice', async () => {
  const n = await network(3);
  n.drop((_a, _b, p) => p.type === 'mesh-inventory');
  await n.connect(0, 1);
  await n.nodes[0].router.enqueue(alert(n, 0)); await n.settle();
  assert.equal(n.nodes[1].store.data.alerts.length, 1, 'no inventory needed for alerts');
  await n.nodes[0].router.enqueue(n.text(0, 1, 'later-text')); await n.settle();
  assert.equal(incoming(n.nodes[1]).length, 0, 'ordinary traffic still waits for the inventory');
  n.drop(() => false);
  // A new neighbour gets the alert at once; a duplicate copy from it neither surfaces nor echoes.
  await n.connect(2, 1);
  assert.equal(n.nodes[2].store.data.alerts.length, 1);
  const sentToC = () => alertFrames(n).filter((f) => f.from === n.nodes[1].id && f.to === n.nodes[2].id).length;
  assert.equal(sentToC(), ALERT_BURST_COPIES);
  const copy = envelope(alert(n, 0)); copy.hopCount = 1;
  await n.nodes[1].router.receive(n.nodes[2].id, copy); await n.settle();
  assert.equal(n.nodes[1].store.data.alerts.length, 1);
  assert.equal(n.nodes[2].store.data.alerts.length, 1);
  assert.ok(n.nodes[1].store.data.packets['alert-1'].receipts.includes(n.nodes[2].id), 'duplicate marks the sender as a holder');
  await n.advance(31_000);
  assert.equal(sentToC(), ALERT_BURST_COPIES, 'no slower re-send to a peer that already proved it holds the alert');
  assert.deepEqual(n.errors, []);
});

test('alert wire contract: every severity outranks text, inventory and media; body is capped', async () => {
  const n = await network(2);
  const rank = (p) => priority(envelope(p));
  for (const severity of ['INFO', 'HELP', 'DANGER']) {
    assert.ok(rank(alert(n, 0, 'x', severity)) < rank(n.text(0, 1)));
    assert.ok(rank(alert(n, 0, 'x', severity)) < priority({ version: 1, type: 'mesh-inventory', senderId: n.nodes[0].id, recipientId: n.nodes[1].id, session: 's', page: 0, last: true, ids: [] }));
    assert.ok(rank(alert(n, 0, 'x', severity)) < priority({ ...n.text(0, 1), type: 'media-chunk', transferId: 't', sequence: 0, total: 1, payload: 'AQID' }));
  }
  assert.ok(priority({ version: 1, type: 'mesh-receipt', senderId: n.nodes[0].id, recipientId: n.nodes[1].id, packetId: 'x' }) < rank(alert(n, 0)));
  assert.equal(isWirePacket(envelope({ ...alert(n, 0), body: 'x'.repeat(281) })), false);
  assert.equal(isWirePacket({ ...alert(n, 0), body: 'x'.repeat(281) }), false);
  assert.equal(isWirePacket(envelope({ ...alert(n, 0), body: 'x'.repeat(280) })), true);
  assert.equal(envelope(alert(n, 0)).hopLimit, 10);
  assert.equal(envelope({ ...alert(n, 0), ttlHops: 99 }).hopLimit, 10);
});

test('alert burst delivers on the third immediate copy without waiting for backoff', async () => {
  const n = await network(2); await n.connect(0, 1);
  let dropped = 0;
  n.drop((_a, _b, p) => {
    const isAlert = (p.type === 'mesh-data' && p.packet?.id === 'alert-1') || (p.type === 'alert' && p.id === 'alert-1');
    if (!isAlert) return false;
    dropped += 1;
    return dropped <= ALERT_BURST_COPIES - 1;
  });
  await n.nodes[0].router.enqueue(alert(n, 0)); await n.settle();
  assert.equal(n.nodes[1].store.data.alerts.length, 1);
  assert.equal(dropped, ALERT_BURST_COPIES);
  assert.deepEqual(n.errors, []);
});

test('alert envelope is accepted from a confirmed peer whose hello was lost; text is not', async () => {
  const n = await network(2);
  n.drop((_a, _b, p) => p.type === 'mesh-hello');
  await n.connect(0, 1);
  const a = envelope(alert(n, 0)); a.hopCount = 1;
  const t = envelope(n.text(0, 1, 'early-text')); t.hopCount = 1;
  await n.nodes[1].router.receive(n.nodes[0].id, a);
  await n.nodes[1].router.receive(n.nodes[0].id, t);
  await n.settle();
  assert.equal(n.nodes[1].store.data.alerts.length, 1);
  assert.equal(incoming(n.nodes[1]).length, 0);
});

test('legacy raw alert addressed to another node is still accepted once', async () => {
  const n = await network(2); await n.connect(0, 1);
  const raw = { ...alert(n, 0), recipientId: 'some-badge-id', hops: 1 };
  await n.nodes[1].router.receive(n.nodes[0].id, raw);
  await n.nodes[1].router.receive(n.nodes[0].id, raw);
  await n.settle();
  assert.equal(n.nodes[1].store.data.alerts.length, 1);
});

test('malformed protocol and mismatched control identities are ignored', async () => {
  const n = await network(2); await n.connect(0, 1);
  const v = envelope(n.text(0, 1));
  assert.equal(isWirePacket({ ...v, hopCount: -1 }), false);
  assert.equal(isWirePacket({ ...v, expiresAt: Infinity }), false);
  assert.equal(isWirePacket({ ...v, packet: { ...v.packet, version: 2 } }), false);
  await n.nodes[0].router.receive(n.nodes[1].id, { version: 1, type: 'mesh-receipt', senderId: uuid(99), recipientId: n.nodes[0].id, packetId: 'message' });
  await n.nodes[0].router.receive(n.nodes[1].id, null);
  assert.deepEqual(n.nodes[0].store.data.packets, {});
});

test('inventories list carried packets only, are paginated and bounded, and reconnect skips accepted payloads', async () => {
  const n = await network(2);
  await n.nodes[0].store.transaction((d) => {
    for (let i=0;i<130;i++) {
      const p = envelope(n.text(0, 1, `carried-${i}`));
      d.packets[p.packet.id] = { envelope: p, state: 'queued', receipts: [] }; d.seen[p.packet.id] = p.expiresAt + DAY;
    }
    for (let i=0;i<40;i++) d.seen[`expired-${i}`] = 1_000_000 + DAY; // remembered for dedup, not advertised
  });
  await n.connect(0, 1);
  const inventories = n.frames.filter((f) => f.packet.type === 'mesh-inventory' && f.from === n.nodes[0].id);
  assert.ok(inventories.length >= 3);
  assert.ok(inventories.every((f) => f.packet.ids.length <= 50 && wireBytes(f.packet) <= 3000));
  const advertised = inventories.flatMap((f) => f.packet.ids);
  assert.equal(advertised.length, 130);
  assert.ok(advertised.every((id) => id.startsWith('carried-')));
  await n.nodes[0].router.enqueue(n.text(0, 1)); await n.settle();
  const before = n.frames.filter((f) => f.packet.type === 'mesh-data' && f.packet.packet.id === 'message').length;
  n.disconnect(0, 1); await n.connect(0, 1);
  assert.equal(n.frames.filter((f) => f.packet.type === 'mesh-data' && f.packet.packet.id === 'message').length, before);
});

test('scheduler prioritizes emergency over queued media and cancels queued work', async () => {
  const scheduler = new SendScheduler(), order = [];
  const packet = { type: 'media-chunk' };
  const low = scheduler.send('b', packet, async () => { order.push('media'); }, 5);
  const high = scheduler.send('b', packet, async () => { order.push('emergency'); }, 1);
  await Promise.all([low, high]); assert.deepEqual(order, ['emergency', 'media']);
  const cancelled = scheduler.send('b', packet, async () => { throw new Error('should not run'); });
  scheduler.cancel(); await assert.rejects(cancelled, /cancelled/);
});

function sqliteDriver(db) {
  const driver = {
    async execAsync(sql) { db.exec(sql); },
    async getAllAsync(sql) { return db.prepare(sql).all(); },
    async runAsync(sql, ...params) { db.prepare(sql).run(...params); },
    async withExclusiveTransactionAsync(task) {
      db.exec('BEGIN IMMEDIATE');
      try { await task(driver); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  }; return driver;
}
test('real SQLite migration is atomic and idempotent, survives reopening, and clear prevents reimport', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'nored-mesh-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'mesh.db');
  const db = new DatabaseSync(file); const persistence = new SqlPersistence(sqliteDriver(db));
  const store = new RouterStore(persistence); await store.init();
  const message = { id: 'old', mine: true, kind: 'text', status: 'queued', timestamp: 1_000_000, senderId: uuid(1), body: 'old' };
  const history = { threads: [], messages: { [uuid(2)]: [message] } };
  await importHistory(store, structuredClone(history), 1_000_001);
  assert.equal(store.data.packets.old.envelope.directOnly, true);
  db.close();
  const reopenedDb = new DatabaseSync(file);
  t.after(() => reopenedDb.close());
  const reopened = new RouterStore(new SqlPersistence(sqliteDriver(reopenedDb))); await reopened.init();
  assert.deepEqual(reopened.data, store.data);
  await importHistory(reopened, { threads: [], messages: {} }); assert.ok(reopened.data.packets.old);
  await assert.rejects(reopened.transaction((d) => { d.imported = false; throw new Error('interrupt'); }));
  assert.equal(reopened.data.imported, true);
  const router = new MeshRouter(reopened, { getIdentity: () => ({ id: uuid(1) }) });
  await router.clear(); await importHistory(reopened, history);
  assert.equal(reopened.data.chat.threads.length, 0); assert.deepEqual(reopened.data.packets, {});
});

test('legacy peers receive unchanged direct packets and remain Sent, never Delivered', async () => {
  const n = await network(2);
  n.drop((_a,_b,p) => p.type.startsWith('mesh-'));
  await n.connect(0, 1); await n.nodes[0].router.enqueue(n.text(0, 1));
  await n.advance(2100);
  assert.equal(incoming(n.nodes[1]).length, 1);
  assert.equal(n.nodes[0].store.data.packets.message.state, 'sent');
  assert.deepEqual(n.frames.find((f) => f.packet.type === 'text').packet, n.nodes[0].store.data.packets.message.envelope.packet);
});

test('simultaneous ten-message sends retain boundaries and delivery state', async () => {
  const n = await network(2); await n.connect(0, 1);
  await Promise.all(Array.from({ length: 10 }, (_, i) => Promise.all([
    n.nodes[0].router.enqueue(n.text(0, 1, `a-${i}`)),
    n.nodes[1].router.enqueue(n.text(1, 0, `b-${i}`)),
  ])));
  await n.settle();
  assert.equal(incoming(n.nodes[0]).length, 10); assert.equal(incoming(n.nodes[1]).length, 10);
  assert.ok(Object.values(n.nodes[0].store.data.packets).filter((r) => r.envelope.packet.type === 'text' && r.envelope.packet.senderId === n.nodes[0].id).every((r) => r.state === 'delivered'));
});

test('destination consumes at hop limit and unknown or wrong-sender ACK is harmless', async () => {
  const n = await network(2); await n.connect(0, 1);
  const p = envelope(n.text(0, 1)); p.hopCount = p.hopLimit;
  await n.nodes[1].router.receive(n.nodes[0].id, p); await n.settle();
  assert.equal(incoming(n.nodes[1]).length, 1);
  const ack = envelope({ version: 1, type: 'delivery-ack', id: 'unknown-ack', senderId: uuid(99), recipientId: n.nodes[0].id, timestamp: n.text(0,1).timestamp, messageId: 'no-such-message' }); ack.hopCount = 1;
  await n.nodes[0].router.receive(n.nodes[1].id, ack); await n.settle();
  assert.equal(incoming(n.nodes[0]).length, 0);
});

test('lost receipts retry safely; partial inventory resumes on reconnect', async () => {
  const n = await network(3); await n.contact(0,2);
  n.drop((_a,_b,p) => p.type === 'mesh-inventory' && p.last);
  await n.connect(0,1); await n.nodes[0].router.enqueue(n.text(0,2)); await n.settle();
  assert.equal(n.nodes[1].store.data.packets.message, undefined);
  n.disconnect(0,1); n.drop((_a,_b,p) => p.type === 'mesh-receipt');
  await n.connect(0,1); assert.ok(n.nodes[1].store.data.packets.message);
  await n.advance(10_000); assert.equal(Object.keys(n.nodes[1].store.data.packets).filter((id) => id === 'message').length,1);
  n.drop(() => false); await n.advance(15_000);
  assert.ok(n.nodes[0].store.data.packets.message.receipts.includes(n.nodes[1].id));
});

test('storage cleared on the next peer encounter is detected by fresh inventory', async () => {
  const n = await network(); await n.contact(0,2); await n.nodes[0].router.enqueue(n.text(0,2)); await n.connect(0,1);
  n.disconnect(0,1); await n.nodes[1].router.clear(); await n.connect(0,1);
  assert.ok(n.nodes[1].store.data.packets.message);
});

test('SQLite rolls back partial SQL writes and failed import can be retried', async () => {
  const db = new DatabaseSync(':memory:'); const driver = sqliteDriver(db);
  const originalRun = driver.runAsync; let fail = true;
  driver.runAsync = async (sql,...params) => { await originalRun(sql,...params); if (fail) throw new Error('interrupted write'); };
  const store = new RouterStore(new SqlPersistence(driver)); await store.init();
  await assert.rejects(importHistory(store, { threads: [], messages: {} }));
  assert.equal(store.data.imported,false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM mesh_records').get().n,0);
  fail = false; await importHistory(store,{ threads: [], messages: {} });
  assert.equal(store.data.imported,true); db.close();
});

test('direct media uses shared scheduler, preserves packet bytes, and never reaches a relay', async () => {
  const n = await network(); await n.connect(0,1); await n.connect(0,2);
  const received = []; n.nodes[1].router.onApplicationPacket((p) => received.push(p));
  const manifest = { ...n.text(0,1,'photo'), type:'media-manifest', mediaKind:'image', mimeType:'image/jpeg', byteLength:3, chunkCount:1, hash:'abc' };
  const chunk = { ...n.text(0,1,'photo:chunk:0'), type:'media-chunk', transferId:'photo', sequence:0,total:1,payload:'AQID' };
  await n.nodes[0].router.sendDirect(n.nodes[1].id,manifest); await n.nodes[0].router.sendDirect(n.nodes[1].id,chunk); await n.settle();
  assert.deepEqual(received,[manifest,chunk]);
  assert.equal(n.frames.some((f) => f.to === n.nodes[2].id && f.packet.type.startsWith('media-')),false);
  n.disconnect(0,1); await assert.rejects(n.nodes[0].router.sendDirect(n.nodes[1].id,chunk));
  await n.connect(0,1); await n.nodes[0].router.sendDirect(n.nodes[1].id,chunk); await n.settle();
  assert.deepEqual(received.at(-1),chunk);
});

test('clear during a queued forwarding transaction cannot send the removed packet', async () => {
  const n = await network(2); await n.connect(0,1);
  let release;
  const originalCommit = n.nodes[0].persistence.commit.bind(n.nodes[0].persistence);
  let blocked = false;
  n.nodes[0].persistence.commit = async (next) => {
    if (!blocked && next.packets.message?.state === 'sending') {
      blocked = true; await new Promise((r) => { release = r; });
    }
    await originalCommit(next);
  };
  await n.nodes[0].router.enqueue(n.text(0,1)); await n.settle();
  assert.equal(blocked,true);
  const clearing = n.nodes[0].router.clear(); release(); await clearing; await n.settle();
  assert.equal(incoming(n.nodes[1]).length,0);
  assert.deepEqual(n.nodes[0].store.data.packets,{});
});

test('oversized and nonfinite packets are rejected before allocation', async () => {
  const n = await network(2); await n.connect(0,1);
  await assert.rejects(n.nodes[0].router.enqueue({ ...n.text(0,1), payload:'x'.repeat(5000) }));
  assert.equal(isWirePacket({ ...n.text(0,1),type:'media-manifest', mediaKind:'image',mimeType:'image/jpeg',byteLength:Infinity,chunkCount:1,hash:'x' }),false);
  assert.equal(isWirePacket({ version:1,type:'mesh-inventory',senderId:n.nodes[0].id,recipientId:n.nodes[1].id,session:'s',page:0,last:true,ids:Array(51).fill('x') }),false);
});

test('group packets can pass through an immediate relay without changing the original sender', async () => {
  const n = await network(3);
  await n.connect(1, 2);
  const received = [];
  n.nodes[2].router.onApplicationPacket((packet, peerId) => received.push({ packet, peerId }));
  const packet = {
    ...n.text(0, 2, 'group-message'),
    recipientId: n.nodes[2].id,
    groupId: 'group-1',
    hops: 1,
    ttlHops: 5,
  };
  await n.nodes[2].router.receive(n.nodes[1].id, packet);
  assert.equal(received.length, 1);
  assert.equal(received[0].packet.senderId, n.nodes[0].id);
  assert.equal(received[0].peerId, n.nodes[1].id);
});


test('corrupt legacy history is rejected instead of marking an empty import complete', () => {
  assert.throws(() => validateLegacyHistory({ threads: [], messages: null }), /preserved/);
  assert.throws(() => validateLegacyHistory({ threads: [], messages: { peer: [null] } }), /preserved/);
  assert.deepEqual(validateLegacyHistory({ threads: [], messages: {} }), { threads: [], messages: {} });
});
