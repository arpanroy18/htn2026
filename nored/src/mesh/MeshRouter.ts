import type { MeshTransport, Packet, Peer, Subscription, TextPacket, AlertPacket } from '../transport/MeshTransport';
import type { RouterData, RouterStore } from './routerStore';
import { emptyData } from './routerStore.ts';
import { appendMessage, ensureDmThread, formatMessageClock, migrateDmPeer, patchMessage } from './chatStore.ts';
import { alertFromPacket, appendAlert } from './alertStore.ts';
import { canonicalId, DAY, envelope, isWirePacket, MAX_CONTROL_BYTES, priority, wireBytes } from './protocol.ts';
import type { Control, ControlFields, Envelope, WirePacket } from './protocol';
import { SendScheduler } from './scheduler.ts';

type Session = {
  peer: Peer; ready: boolean; started: number; helloAt: number; inventoryAt: number;
  incoming?: { id: string; pages: Map<number, string[]>; last?: number };
  inventoryComplete: boolean;
};
export class MeshRouter {
  readonly scheduler = new SendScheduler();
  private sessions = new Map<string, Session>();
  private subscriptions: Subscription[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private pending = new Map<string, { at: number; attempts: number }>();
  private busy = new Set<string>();
  private mediaListeners = new Set<(packet: Packet, peerId: string) => void>();
  private generation = 0;
  private inventoryCounter = 0;
  private inventoryBusy = new Set<string>();
  private cleanupAt = 0;
  private running = false;
  listening = true;
  activeThread: string | null = null;
  error?: string;
  readonly store: RouterStore;
  private transport: MeshTransport;
  private now: () => number;
  private log: (message: string) => void;
  constructor(store: RouterStore, transport: MeshTransport, now: () => number = Date.now, log: (message: string) => void = console.info) {
    this.store = store; this.transport = transport; this.now = now; this.log = log;
  }
  setListening(value: boolean) { this.listening = value; }
  setActiveThread(value: string | null) { this.activeThread = value; }
  get epoch() { return this.generation; }
  get identity() { return this.transport.getIdentity(); }
  name(id: string) { return this.store.data.contacts[id]?.name ?? this.sessions.get(id)?.peer.name ?? `Peer ${id.slice(0, 8)}`; }
  private report(error: unknown) {
    this.error = error instanceof Error ? error.message : 'Mesh operation failed';
    this.log(`[ROUTER] ${this.error}`);
  }
  async start() {
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    this.subscriptions = [
      this.transport.onPeerDiscovered((peer) => { void this.encounter(peer).catch((e) => this.report(e)); }),
      this.transport.onPeerLost((id) => this.disconnect(id)),
      this.transport.onPacketReceived((id, packet) => { void this.receive(id, packet).catch((e) => this.report(e)); }),
      this.transport.onStateChanged((state) => {
        if (state !== 'running' && state !== 'starting') for (const id of this.sessions.keys()) this.disconnect(id);
        if (state === 'running') void this.transport.getPeers().then((peers) => Promise.all(peers.map((p) => this.encounter(p)))).catch((e) => this.report(e));
      }),
    ];
    const peers = await this.transport.getPeers();
    if (generation !== this.generation) return;
    for (const peer of peers) await this.encounter(peer);
    await this.store.transaction((d) => {
      for (const [id, record] of Object.entries(d.packets)) if (record.state === 'sending') this.status(d, id, record.receipts.length ? 'carrying' : 'queued');
    });
    await this.cleanup();
    if (generation !== this.generation) return;
    this.timer = setInterval(() => { void this.tick().catch((e) => this.report(e)); }, 1000);
  }
  stop() {
    this.running = false;
    this.generation++;
    this.subscriptions.forEach((s) => s.remove());
    this.subscriptions = [];
    if (this.timer) clearInterval(this.timer);
    this.scheduler.cancel();
    this.sessions.clear(); this.pending.clear(); this.busy.clear();
  }
  async clear() {
    this.generation++;
    this.scheduler.cancel(); this.pending.clear();
    await this.store.transaction((d) => Object.assign(d, { ...emptyData(), imported: true }));
    for (const session of this.sessions.values()) { session.inventoryAt = 0; session.inventoryComplete = false; }
  }
  onApplicationPacket(callback: (packet: Packet, peerId: string) => void) {
    this.mediaListeners.add(callback);
    return { remove: () => { this.mediaListeners.delete(callback); } };
  }
  async addContact(peerId: string) {
    const peer = this.sessions.get(peerId)?.peer;
    if (!peer?.identityConfirmed || !canonicalId(peer.id) || peer.id === this.identity.id) throw new Error('Meet this Nored phone nearby before adding it.');
    await this.store.transaction((d) => { d.contacts[peerId] = { id: peerId, name: peer.name, addedAt: this.now() }; });
  }
  async encounter(peer: Peer) {
    if (!peer.nored || !peer.identityConfirmed || peer.id === this.identity.id) return;
    if (peer.replacesId && peer.replacesId !== peer.id && this.store.data.chat.messages[peer.replacesId]) {
      const previous = peer.replacesId;
      await this.store.transaction((d) => {
        d.chat = migrateDmPeer(d.chat, previous, peer.id, peer.name);
        // Only local, untransmitted direct-only packets may have provisional addressing.
        for (const record of Object.values(d.packets)) {
          if (record.envelope.directOnly && !record.receipts.length && record.envelope.packet.senderId === this.identity.id && record.envelope.packet.recipientId === previous) {
            record.envelope.packet.recipientId = peer.id;
          }
        }
      });
      this.disconnect(previous);
    }
    const old = this.sessions.get(peer.id);
    if (old) { old.peer = peer; return; }
    this.sessions.set(peer.id, { peer, ready: false, started: this.now(), helloAt: 0, inventoryAt: 0, inventoryComplete: false });
    this.log(`[SYNC] connected ${peer.id}`);
    await this.hello(peer.id, false);
  }
  disconnect(id: string) {
    this.sessions.delete(id); this.scheduler.cancel(id);
    for (const key of this.pending.keys()) if (key.startsWith(`${id}|`)) this.pending.delete(key);
  }
  private async send(peer: string, packet: WirePacket, rank?: number) {
    const generation = this.generation;
    await this.scheduler.send(peer, packet, async () => {
      if (generation !== this.generation || !this.sessions.has(peer)) throw new Error('Peer disconnected.');
      if (packet.type === 'mesh-data' && packet.expiresAt <= this.now()) throw new Error('Packet expired.');
      if (packet.type === 'mesh-data' && this.store.data.packets[packet.packet.id]?.state === 'delivered') return;
      await this.transport.sendPacket(peer, packet);
    }, rank);
  }
  async sendDirect(peer: string, packet: Packet, rank?: number) {
    if (packet.recipientId !== peer || packet.senderId !== this.identity.id) throw new Error('Invalid direct packet identity.');
    await this.send(peer, packet, rank);
  }
  private control(peer: string, fields: ControlFields): Control {
    return { version: 1, senderId: this.identity.id, recipientId: peer, ...fields } as Control;
  }
  private async hello(peer: string, reply: boolean) {
    const session = this.sessions.get(peer);
    if (!session) return;
    session.helloAt = this.now();
    try { await this.send(peer, this.control(peer, { type: 'mesh-hello', reply })); }
    catch { /* A confirmed identity can precede a writable characteristic; tick retries. */ }
  }
  private async inventory(peer: string) {
    const session = this.sessions.get(peer);
    if (!session?.ready || this.inventoryBusy.has(peer)) return;
    this.inventoryBusy.add(peer);
    try {
      session.inventoryAt = this.now();
      const ids = Object.keys(this.store.data.seen).filter((id) => this.store.data.seen[id] > this.now());
      const snapshot = `${this.now()}-${++this.inventoryCounter}`;
      const pages: string[][] = [[]];
      for (const id of ids) {
        let page = pages.at(-1)!;
        const probe = this.control(peer, { type: 'mesh-inventory', session: snapshot, page: pages.length - 1, last: false, ids: [...page, id] });
        if (page.length >= 50 || wireBytes(probe) > MAX_CONTROL_BYTES) { page = []; pages.push(page); }
        page.push(id);
      }
      for (let index = 0; index < pages.length; index++) {
        await this.send(peer, this.control(peer, { type: 'mesh-inventory', session: snapshot, page: index, last: index === pages.length - 1, ids: pages[index] }));
      }
    } finally { this.inventoryBusy.delete(peer); }
  }
  private capacity(d: RouterData, extra: Envelope) {
    for (const [id, record] of Object.entries(d.packets)) if (record.envelope.expiresAt <= this.now()) {
      if (record.state !== 'delivered' && record.state !== 'sent') this.status(d, id, 'expired');
      delete d.packets[id];
    }
    const values = Object.values(d.packets);
    if (values.length >= 10_000 || values.reduce((n, r) => n + wireBytes(r.envelope), 0) + wireBytes(extra) > 32 * 1024 * 1024) throw new Error('Packet storage is full.');
  }
  private record(d: RouterData, value: Envelope, from: string) {
    this.capacity(d, value);
    d.packets[value.packet.id] = { envelope: value, state: 'queued', receipts: from ? [from] : [] };
    d.seen[value.packet.id] = value.expiresAt + DAY;
    this.event(d, value.packet.id, from, 'received');
    this.log(`[ROUTER] stored ${value.packet.id}`);
  }
  private event(d: RouterData, packetId: string, peerId: string, action: string) {
    d.events.push({ packetId, peerId, action, timestamp: this.now() });
    d.events = d.events.slice(-2000);
  }
  private display(d: RouterData, value: Envelope, mine: boolean) {
    const p = value.packet;
    if (p.type === 'text') {
      const threadId = mine ? p.recipientId : p.senderId;
      const name = this.name(threadId);
      d.chat = appendMessage(d.chat, { id: p.id, threadId, senderId: p.senderId,
        sender: mine ? 'You' : name, mine, kind: 'text', body: p.payload,
        status: mine ? 'queued' : undefined, timestamp: p.timestamp, time: formatMessageClock(p.timestamp) },
        name, !mine && this.activeThread !== threadId);
    } else if (p.type === 'alert' && (mine || this.listening)) {
      d.alerts = appendAlert(d.alerts, alertFromPacket({ ...p, hops: value.hopCount }, this.name(p.senderId), mine));
    }
  }
  async enqueue(packet: TextPacket | AlertPacket) {
    if (packet.senderId !== this.identity.id) throw new Error('Invalid origin.');
    const contact = !!this.store.data.contacts[packet.recipientId];
    if (packet.type === 'text' && !contact && !this.sessions.has(packet.recipientId)) throw new Error('Add this person as a contact while nearby before messaging from afar.');
    const value = envelope(packet, packet.type === 'text' && !contact);
    if (!isWirePacket(value)) throw new Error('Message is too large or invalid.');
    await this.store.transaction((d) => {
      if (d.seen[packet.id]) return;
      this.record(d, value, ''); this.display(d, value, true);
    });
    this.log(`[ROUTER] queued ${packet.id}`);
    this.changed();
  }
  private changed() {
    for (const session of this.sessions.values()) session.inventoryAt = 0;
    void this.flush().catch((e) => this.report(e));
  }
  private status(d: RouterData, id: string, state: import('./chatStore').ChatDelivery) {
    const record = d.packets[id];
    if (!record || record.state === 'delivered') return;
    record.state = state;
    const p = record.envelope.packet;
    if (p.senderId === this.identity.id && p.type === 'text') d.chat = patchMessage(d.chat, p.recipientId, id, { status: state });
  }
  async receive(peer: string, wire: unknown) {
    if (!isWirePacket(wire)) { this.log('[ROUTER] rejected malformed packet'); return; }
    const generation = this.generation;
    let session = this.sessions.get(peer);
    if (!session) {
      const confirmed = (await this.transport.getPeers()).find((p) => p.id === peer && p.identityConfirmed);
      if (!confirmed) return;
      // Register synchronously; never wait for a response while handling an inbound hello.
      session = { peer: confirmed, ready: false, started: this.now(), helloAt: 0, inventoryAt: 0, inventoryComplete: false };
      this.sessions.set(peer, session);
    }
    if (wire.type === 'mesh-hello' || wire.type === 'mesh-inventory' || wire.type === 'mesh-receipt') {
      if (wire.senderId !== peer || wire.recipientId !== this.identity.id) { this.log('[ROUTER] control identity mismatch'); return; }
      if (wire.type === 'mesh-hello') {
        const first = !session.ready;
        session.ready = true;
        if (!wire.reply) void this.hello(peer, true);
        if (first) void this.inventory(peer).catch((e) => this.report(e));
      } else if (wire.type === 'mesh-inventory' && session.ready) {
        if (!session.incoming || session.incoming.id !== wire.session) {
          if (wire.page !== 0) return;
          session.incoming = { id: wire.session, pages: new Map() };
        }
        const incoming = session.incoming;
        incoming.pages.set(wire.page, wire.ids);
        if (wire.last) incoming.last = wire.page;
        if (incoming.last !== undefined && Array.from({ length: incoming.last + 1 }, (_, i) => incoming.pages.has(i)).every(Boolean)) {
          const known = new Set([...incoming.pages.values()].flat());
          await this.store.transaction((d) => {
            if (generation !== this.generation) return;
            for (const [id, r] of Object.entries(d.packets)) {
              r.receipts = r.receipts.filter((p) => p !== peer);
              if (known.has(id)) {
                r.receipts.push(peer);
                if (r.state !== 'sent') this.status(d, id, 'carrying');
              }
            }
          });
          session.inventoryComplete = true;
          session.incoming = undefined;
          await this.flush();
        }
      } else if (wire.type === 'mesh-receipt' && session.ready) {
        await this.store.transaction((d) => {
          if (generation !== this.generation) return;
          const record = d.packets[wire.packetId];
          if (!record) return;
          if (!record.receipts.includes(peer)) record.receipts.push(peer);
          this.status(d, wire.packetId, 'carrying');
          this.event(d, wire.packetId, peer, 'receipt');
          this.log(`[FORWARD] ${wire.packetId} accepted by ${peer}`);
        });
        this.pending.delete(`${peer}|${wire.packetId}`);
      }
      return;
    }
    if (wire.type !== 'mesh-data') {
      // Legacy application packets are direct-only, except the existing alert broadcast.
      if (wire.recipientId !== this.identity.id) return;
      if (wire.type !== 'alert' && !wire.groupId && wire.senderId !== peer) return;
      if (wire.type === 'text' && wire.groupId) {
        for (const listener of this.mediaListeners) listener(wire, peer);
      } else if (wire.type === 'text' || wire.type === 'alert') {
        const value = envelope(wire, wire.type === 'text');
        if (isWirePacket(value)) await this.accept(peer, value, false, generation);
      } else for (const listener of this.mediaListeners) listener(wire, peer);
      return;
    }
    if (!session.ready || wire.hopCount < 1 || (wire.directOnly && wire.packet.recipientId !== this.identity.id)) return;
    await this.accept(peer, wire, true, generation);
  }
  private async accept(peer: string, value: Envelope, receipt: boolean, generation: number) {
    const p = value.packet;
    if (value.expiresAt <= this.now() || p.timestamp > this.now() + 300_000) { this.log(`[EXPIRY] rejected ${p.id}`); return; }
    let accepted = false;
    await this.store.transaction((d) => {
      if (generation !== this.generation) return;
      accepted = true;
      if (d.seen[p.id]) {
        this.log(`[DEDUP] ${p.id}`);
        if (receipt && p.type === 'text' && p.recipientId === this.identity.id &&
            d.chat.messages[p.senderId]?.some((m) => m.id === p.id && !m.mine)) this.ensureAck(d, p);
        return;
      }
      this.record(d, value, peer);
      if (p.senderId === this.identity.id) return;
      if (p.type === 'alert' || p.recipientId === this.identity.id) {
        this.display(d, value, false);
        if (p.type === 'text' && receipt) {
          this.ensureAck(d, p);
        } else if (p.type === 'delivery-ack') {
          const original = d.packets[p.messageId]?.envelope.packet;
          if (original?.type === 'text' && original.senderId === this.identity.id && original.recipientId === p.senderId) {
            this.status(d, p.messageId, 'delivered');
            this.event(d, p.messageId, peer, 'delivered');
            this.log(`[DELIVERY] ${p.messageId}`);
          }
        }
      }
    });
    if (!accepted || generation !== this.generation) return;
    if (receipt) await this.send(peer, this.control(peer, { type: 'mesh-receipt', packetId: p.id }));
    this.changed();
  }
  private ensureAck(d: RouterData, packet: TextPacket) {
    const ack = envelope({ version: 1, type: 'delivery-ack', id: `${packet.id}:delivered`,
      senderId: this.identity.id, recipientId: packet.senderId, timestamp: this.now(), messageId: packet.id });
    if (!d.seen[ack.packet.id]) this.record(d, ack, '');
  }
  async tick() {
    if (this.now() - this.cleanupAt >= 60_000) await this.cleanup();
    for (const [peer, session] of this.sessions) {
      if (!session.ready && this.now() - session.helloAt >= 5000) void this.hello(peer, false);
      if (session.ready && (!session.inventoryAt || this.now() - session.inventoryAt >= 30_000)) {
        void this.inventory(peer).catch((e) => this.report(e));
      }
    }
    await this.flush();
  }
  async cleanup() {
    this.cleanupAt = this.now();
    await this.store.transaction((d) => {
      for (const [id, r] of Object.entries(d.packets)) if (r.envelope.expiresAt <= this.now()) {
        if (r.state !== 'delivered' && r.state !== 'sent') this.status(d, id, 'expired');
        delete d.packets[id];
        this.log(`[EXPIRY] ${id}`);
      }
      for (const [id, until] of Object.entries(d.seen)) if (until <= this.now()) delete d.seen[id];
    });
  }
  async flush() {
    const candidates = Object.values(this.store.data.packets).sort((a, b) => priority(a.envelope) - priority(b.envelope) || a.envelope.packet.timestamp - b.envelope.packet.timestamp);
    for (const record of candidates) {
      const value = record.envelope, p = value.packet;
      if (value.expiresAt <= this.now() || value.hopCount >= value.hopLimit || record.state === 'delivered') continue;
      if (p.type !== 'alert' && p.recipientId === this.identity.id) continue;
      const peers = [...this.sessions.entries()].sort(([a], [b]) => Number(b === p.recipientId) - Number(a === p.recipientId));
      for (const [peer, session] of peers) {
        if (record.receipts.includes(peer) || peer === p.senderId || (value.directOnly && peer !== p.recipientId)) continue;
        const legacy = !session.ready && this.now() - session.started >= 2000;
        if (!legacy && (!session.ready || !session.inventoryComplete)) continue;
        if (legacy && (p.type === 'delivery-ack' || (p.type !== 'alert' && peer !== p.recipientId))) continue;
        const key = `${peer}|${p.id}`, attempt = this.pending.get(key);
        if (this.busy.has(key) || (attempt && this.now() - attempt.at < Math.min(30_000, 3000 * 2 ** Math.min(attempt.attempts, 4)))) continue;
        this.busy.add(key);
        this.pending.set(key, { at: this.now(), attempts: (attempt?.attempts ?? 0) + 1 });
        // Do not wait for a peer receipt here: that would deadlock simultaneous sends.
        void this.forward(peer, value, legacy, key).catch((e) => this.report(e));
      }
    }
  }
  private async forward(peer: string, value: Envelope, legacy: boolean, key: string) {
    const generation = this.generation, p = value.packet;
    try {
      await this.store.transaction((d) => { if (generation === this.generation) this.status(d, p.id, 'sending'); });
      if (generation !== this.generation) return;
      const copy: Envelope = { ...value, hopCount: value.hopCount + 1 };
      const wire: WirePacket = legacy && p.type !== 'delivery-ack'
        ? p.type === 'alert' ? { ...p, recipientId: peer, hops: copy.hopCount } : p : copy;
      await this.send(peer, wire);
      await this.store.transaction((d) => {
        if (generation !== this.generation) return;
        const r = d.packets[p.id];
        if (!r) return;
        if (legacy) {
          if (!r.receipts.includes(peer)) r.receipts.push(peer);
          this.status(d, p.id, 'sent');
        } else if (r.state === 'sending') this.status(d, p.id, r.receipts.length ? 'carrying' : 'queued');
        this.event(d, p.id, peer, 'forwarded');
      });
    } catch {
      await this.store.transaction((d) => {
        if (generation !== this.generation) return;
        const r = d.packets[p.id];
        if (r) this.status(d, p.id, r.receipts.length ? 'carrying' : 'queued');
      });
    } finally { this.busy.delete(key); }
  }
  async openDm(id: string, name: string) {
    await this.store.transaction((d) => { d.chat = ensureDmThread(d.chat, id, name); });
  }
}
