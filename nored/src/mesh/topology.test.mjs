import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveTopology, EDGE_RECENT_MS } from './topology.ts';

const NOW = 1_700_000_000_000;
const SELF = '00000000-0000-4000-8000-00000000self';

const id = (name) => `00000000-0000-4000-8000-${name.padStart(12, '0')}`;
const A = id('a');
const B = id('b');
const C = id('c');
const D = id('d');

function input(overrides = {}) {
  return {
    selfId: SELF,
    now: NOW,
    maxDepth: 6,
    peers: [],
    contacts: {},
    packets: {},
    chat: { threads: [], messages: {} },
    events: [],
    ...overrides,
  };
}

function peer(peerId, overrides = {}) {
  return { id: peerId, name: `Peer ${peerId.slice(0, 4)}`, rssi: -55, lastSeen: NOW, ...overrides };
}

function textRecord(packetId, path, timestamp = NOW) {
  return {
    envelope: {
      version: 1,
      type: 'mesh-data',
      packet: { version: 1, type: 'text', id: packetId, senderId: path[0], recipientId: path[path.length - 1], timestamp, payload: 'hi' },
      expiresAt: timestamp + 86_400_000,
      hopCount: path.length - 1,
      hopLimit: 10,
      directOnly: false,
      path,
    },
    state: 'queued',
    receipts: [],
  };
}

function ackRecord(messageId, messagePath, timestamp = NOW) {
  return {
    envelope: {
      version: 1,
      type: 'mesh-data',
      packet: {
        version: 1,
        type: 'delivery-ack',
        id: `${messageId}:delivered`,
        senderId: messagePath[messagePath.length - 1],
        recipientId: messagePath[0],
        timestamp,
        messageId,
        messagePath,
      },
      expiresAt: timestamp + 86_400_000,
      hopCount: 0,
      hopLimit: 10,
      directOnly: false,
    },
    state: 'queued',
    receipts: [],
  };
}

const nodeFor = (graph, nodeId) => graph.nodes.find((node) => node.id === nodeId);
const edgeFor = (graph, x, y) => graph.edges.find((e) => (e.a === x && e.b === y) || (e.a === y && e.b === x));

describe('deriveTopology', () => {
  it('returns just the root when nothing else is known', () => {
    const graph = deriveTopology(input());
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0].id, SELF);
    assert.equal(graph.nodes[0].depth, 0);
    assert.equal(graph.nodes[0].kind, 'self');
    assert.equal(graph.nodes[0].status, 'live');
    assert.equal(graph.edges.length, 0);
    assert.equal(graph.maxDepthAvailable, 0);
  });

  it('places live peers at depth 1 on direct edges', () => {
    const graph = deriveTopology(input({ peers: [peer(A), peer(B), peer(C)] }));
    assert.equal(graph.nodes.length, 4);
    for (const peerId of [A, B, C]) {
      assert.equal(nodeFor(graph, peerId).depth, 1);
      assert.equal(nodeFor(graph, peerId).status, 'live');
      assert.equal(edgeFor(graph, SELF, peerId).kind, 'direct');
      assert.equal(edgeFor(graph, SELF, peerId).status, 'live');
    }
  });

  it('keeps a pendingLoss peer but ages its status', () => {
    const recent = deriveTopology(input({ peers: [peer(A, { pendingLoss: true, lastSeen: NOW - 1000 })] }));
    assert.equal(nodeFor(recent, A).status, 'recent');

    const stale = deriveTopology(
      input({ peers: [peer(A, { pendingLoss: true, lastSeen: NOW - EDGE_RECENT_MS - 1000 })] }),
    );
    assert.equal(nodeFor(stale, A).status, 'stale');
  });

  it('reads a full route out of a delivery ack', () => {
    const graph = deriveTopology(input({ packets: { ack: ackRecord('m1', [SELF, A, B, C]) } }));
    assert.equal(nodeFor(graph, A).depth, 1);
    assert.equal(nodeFor(graph, B).depth, 2);
    assert.equal(nodeFor(graph, C).depth, 3);
    assert.equal(edgeFor(graph, SELF, A).kind, 'direct');
    assert.equal(edgeFor(graph, A, B).kind, 'relayed');
    assert.equal(edgeFor(graph, B, C).kind, 'relayed');
  });

  it('reads hops out of an envelope path', () => {
    const graph = deriveTopology(input({ packets: { p1: textRecord('p1', [C, A, SELF]) } }));
    assert.equal(nodeFor(graph, A).depth, 1);
    assert.equal(nodeFor(graph, C).depth, 2);
  });

  it('reads hops out of chat message paths', () => {
    const chat = { threads: [], messages: { [A]: [{ id: 'm1', timestamp: NOW, path: [B, A, SELF] }] } };
    const graph = deriveTopology(input({ chat }));
    assert.equal(nodeFor(graph, A).depth, 1);
    assert.equal(nodeFor(graph, B).depth, 2);
  });

  it('reads the relay event log but ignores blank peer ids', () => {
    const events = [
      { packetId: 'p1', peerId: A, action: 'forwarded', timestamp: NOW },
      { packetId: 'p2', peerId: '', action: 'received', timestamp: NOW },
    ];
    const graph = deriveTopology(input({ events }));
    assert.equal(nodeFor(graph, A).depth, 1);
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 1);
  });

  it('never derives an edge from packet receipts', () => {
    // Two peers both holding a packet we gave them are not necessarily in range of
    // each other. Treating receipts as adjacency invents links that do not exist.
    const record = textRecord('p1', [SELF]);
    record.receipts = [A, B];
    const graph = deriveTopology(input({ packets: { p1: record } }));
    assert.equal(graph.edges.length, 0);
    assert.equal(graph.nodes.length, 1);
  });

  it('collapses the same link seen from both directions', () => {
    const packets = {
      p1: textRecord('p1', [A, SELF], NOW - 5000),
      p2: textRecord('p2', [SELF, A], NOW),
    };
    const graph = deriveTopology(input({ packets }));
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].weight, 2);
    assert.equal(graph.edges[0].lastSeenAt, NOW);
  });

  it('assigns the minimum depth when a node is reachable two ways', () => {
    const graph = deriveTopology(
      input({ peers: [peer(C)], packets: { p1: textRecord('p1', [SELF, A, B, C]) } }),
    );
    assert.equal(nodeFor(graph, C).depth, 1);
    // The long way round is still drawn — that is what makes it a mesh, not a tree.
    assert.ok(edgeFor(graph, B, C));
  });

  it('truncates by depth while still reporting what lies beyond', () => {
    const graph = deriveTopology(
      input({ maxDepth: 2, packets: { ack: ackRecord('m1', [SELF, A, B, C, D]) } }),
    );
    assert.equal(graph.maxDepthAvailable, 4);
    assert.equal(graph.hiddenCount, 2);
    assert.ok(graph.nodes.every((node) => node.depth <= 2));
    const ids = new Set(graph.nodes.map((node) => node.id));
    for (const edge of graph.edges) {
      assert.ok(ids.has(edge.a), `dangling edge endpoint ${edge.a}`);
      assert.ok(ids.has(edge.b), `dangling edge endpoint ${edge.b}`);
    }
  });

  it('drops links older than the history window but never a pinned live link', () => {
    const old = NOW - 60 * 60_000;
    const dropped = deriveTopology(input({ packets: { p1: textRecord('p1', [SELF, A], old) } }));
    assert.equal(dropped.nodes.length, 1);

    const pinned = deriveTopology(
      input({ peers: [peer(A, { lastSeen: old })], packets: { p1: textRecord('p1', [SELF, A], old) } }),
    );
    assert.equal(nodeFor(pinned, A).depth, 1);
    assert.equal(nodeFor(pinned, A).status, 'live');
  });

  it('keeps everything when history is unbounded', () => {
    const old = NOW - 20 * 60 * 60_000;
    const graph = deriveTopology(
      input({ historyMs: Infinity, packets: { p1: textRecord('p1', [SELF, A], old) } }),
    );
    assert.equal(nodeFor(graph, A).depth, 1);
    assert.equal(nodeFor(graph, A).status, 'stale');
  });

  it('classifies self, badges and never-met relays', () => {
    const peers = [peer(A, { name: 'Nored Badge 01' }), peer(B, { name: 'Aadya' })];
    const graph = deriveTopology(input({ peers, packets: { p1: textRecord('p1', [SELF, C]) } }));
    assert.equal(nodeFor(graph, SELF).kind, 'self');
    assert.equal(nodeFor(graph, A).kind, 'badge');
    assert.equal(nodeFor(graph, B).kind, 'phone');
    assert.equal(nodeFor(graph, C).kind, 'unknown');
    assert.equal(nodeFor(graph, C).name, `Peer ${C.slice(0, 8)}`);
  });

  it('caps a crowded ring and prunes the descendants of what it drops', () => {
    const packets = {};
    for (let i = 0; i < 8; i += 1) {
      const hop = id(`h${i}`);
      const leaf = id(`l${i}`);
      packets[`p${i}`] = textRecord(`p${i}`, [SELF, hop, leaf]);
    }
    const graph = deriveTopology(input({ maxPerRing: 3, packets }));
    assert.equal(graph.nodes.filter((node) => node.depth === 1).length, 3);
    assert.equal(graph.nodes.filter((node) => node.depth === 2).length, 3);
    assert.equal(graph.hiddenCount, 10);
    const ids = new Set(graph.nodes.map((node) => node.id));
    for (const edge of graph.edges) {
      assert.ok(ids.has(edge.a) && ids.has(edge.b));
    }
  });

  it('counts ids with no chain back to the root as orphans', () => {
    const graph = deriveTopology(input({ packets: { p1: textRecord('p1', [A, B]) } }));
    assert.equal(graph.orphanCount, 2);
    assert.equal(graph.nodes.length, 1);
  });

  it('re-roots on any node', () => {
    const packets = { ack: ackRecord('m1', [SELF, A, B, C]) };
    const graph = deriveTopology(input({ rootId: B, packets }));
    assert.equal(graph.rootId, B);
    assert.equal(nodeFor(graph, B).depth, 0);
    assert.equal(nodeFor(graph, A).depth, 1);
    assert.equal(nodeFor(graph, C).depth, 1);
    assert.equal(nodeFor(graph, SELF).depth, 2);
    // `direct` stays anchored to this phone even when the graph is rooted elsewhere.
    assert.equal(edgeFor(graph, SELF, A).kind, 'direct');
    assert.equal(edgeFor(graph, A, B).kind, 'relayed');
  });

  it('is deterministic and order-independent', () => {
    const packets = {
      p1: textRecord('p1', [SELF, A, B]),
      p2: textRecord('p2', [SELF, C]),
    };
    const events = [
      { packetId: 'p1', peerId: A, action: 'forwarded', timestamp: NOW },
      { packetId: 'p2', peerId: C, action: 'receipt', timestamp: NOW },
    ];
    const forward = deriveTopology(input({ packets, events }));
    const reversed = deriveTopology(
      input({ packets: { p2: packets.p2, p1: packets.p1 }, events: [...events].reverse() }),
    );
    assert.deepEqual(forward, reversed);
    assert.equal(forward.signature, reversed.signature);
  });

  it('changes signature on a structural change but not on extra observations', () => {
    const base = input({ peers: [peer(A)] });
    const first = deriveTopology(base);

    const extra = deriveTopology(
      input({ peers: [peer(A)], packets: { p1: textRecord('p1', [SELF, A], NOW - 1000) } }),
    );
    assert.equal(extra.signature, first.signature, 'weight and recency must not move the graph');
    assert.ok(extra.edges[0].weight > first.edges[0].weight);

    const added = deriveTopology(input({ peers: [peer(A), peer(B)] }));
    assert.notEqual(added.signature, first.signature);
  });
});
