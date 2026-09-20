import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveTopology } from './topology.ts';
import { layoutTopology } from './topologyLayout.ts';

const NOW = 1_700_000_000_000;
const SELF = '00000000-0000-4000-8000-00000000self';
const VIEWPORT = { width: 360, height: 520 };

const id = (name) => `00000000-0000-4000-8000-${name.padStart(12, '0')}`;

function input(overrides = {}) {
  return {
    selfId: SELF,
    now: NOW,
    maxDepth: 6,
    maxPerRing: 64,
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

const placed = (layout, nodeId) => layout.nodes.find((node) => node.id === nodeId);

describe('layoutTopology', () => {
  it('centres a lone root and draws no rings', () => {
    const layout = layoutTopology(deriveTopology(input()), VIEWPORT);
    assert.equal(layout.nodes.length, 1);
    assert.equal(layout.nodes[0].x, VIEWPORT.width / 2);
    assert.equal(layout.nodes[0].y, VIEWPORT.height / 2);
    assert.deepEqual(layout.ringRadii, []);
    assert.equal(layout.scale, 1);
  });

  it('spaces four direct peers evenly starting at twelve o_clock', () => {
    const peers = ['a', 'b', 'c', 'd'].map((name) => peer(id(name)));
    const layout = layoutTopology(deriveTopology(input({ peers })), VIEWPORT);
    const ring = layout.nodes.filter((node) => node.depth === 1);
    assert.equal(ring.length, 4);

    const first = ring.find((node) => node.id === id('a'));
    assert.ok(Math.abs(first.x - VIEWPORT.width / 2) < 0.001);
    assert.ok(first.y < VIEWPORT.height / 2, 'first node should sit above the centre');

    const angles = ring.map((node) => node.angle).sort((x, y) => x - y);
    for (let i = 1; i < angles.length; i += 1) {
      assert.ok(Math.abs(angles[i] - angles[i - 1] - Math.PI / 2) < 1e-9);
    }
  });

  it('keeps a crowded ring from overlapping', () => {
    const peers = Array.from({ length: 30 }, (_, i) => peer(id(`p${i}`)));
    const layout = layoutTopology(deriveTopology(input({ peers })), VIEWPORT);
    const ring = layout.nodes.filter((node) => node.depth === 1);
    assert.equal(ring.length, 30);
    for (let i = 0; i < ring.length; i += 1) {
      for (let j = i + 1; j < ring.length; j += 1) {
        const distance = Math.hypot(ring[i].x - ring[j].x, ring[i].y - ring[j].y);
        assert.ok(distance > 2, `nodes ${i} and ${j} collapsed onto each other`);
      }
    }
  });

  it('places a node identically regardless of its status', () => {
    // This is the invariant that lets `status` sit in the signature: ageing must never
    // move anything, or the graph would crawl as peers drift in and out of range.
    const fresh = deriveTopology(input({ peers: [peer(id('a')), peer(id('b'))] }));
    const aged = deriveTopology(
      input({
        peers: [
          peer(id('a'), { pendingLoss: true, lastSeen: NOW - 60_000 }),
          peer(id('b'), { pendingLoss: true, lastSeen: NOW - 60_000 }),
        ],
      }),
    );
    const one = layoutTopology(fresh, VIEWPORT);
    const two = layoutTopology(aged, VIEWPORT);
    for (const node of one.nodes) {
      const other = placed(two, node.id);
      assert.equal(other.x, node.x);
      assert.equal(other.y, node.y);
    }
  });

  it('is invariant to input ordering', () => {
    const forward = deriveTopology(input({ peers: [peer(id('a')), peer(id('b')), peer(id('c'))] }));
    const reversed = deriveTopology(input({ peers: [peer(id('c')), peer(id('b')), peer(id('a'))] }));
    assert.deepEqual(layoutTopology(forward, VIEWPORT), layoutTopology(reversed, VIEWPORT));
  });

  it('scales a deep graph down and keeps every node on the canvas', () => {
    const chain = [SELF, id('a'), id('b'), id('c'), id('d'), id('e'), id('f')];
    const graph = deriveTopology(input({ maxDepth: 6, packets: { p1: textRecord('p1', chain) } }));
    const layout = layoutTopology(graph, VIEWPORT);
    assert.ok(layout.scale < 1, 'a six-hop chain should not fit at full scale');
    assert.ok(layout.scale >= 0.55);
    for (const node of layout.nodes) {
      const x = layout.centre.x + (node.x - layout.centre.x) * layout.scale;
      const y = layout.centre.y + (node.y - layout.centre.y) * layout.scale;
      assert.ok(x >= 0 && x <= VIEWPORT.width, `node ${node.id} off canvas horizontally`);
      assert.ok(y >= 0 && y <= VIEWPORT.height, `node ${node.id} off canvas vertically`);
    }
  });

  it('keeps siblings angularly contiguous on an uncrowded ring', () => {
    // Two parents, two children each. No foreign node may fall between two siblings.
    const packets = {
      p1: textRecord('p1', [SELF, id('a'), id('a1')]),
      p2: textRecord('p2', [SELF, id('a'), id('a2')]),
      p3: textRecord('p3', [SELF, id('b'), id('b1')]),
      p4: textRecord('p4', [SELF, id('b'), id('b2')]),
    };
    const layout = layoutTopology(deriveTopology(input({ packets })), VIEWPORT);
    const ring = layout.nodes.filter((node) => node.depth === 2).sort((x, y) => x.angle - y.angle);
    assert.equal(ring.length, 4);
    assert.equal(ring[0].parentId, ring[1].parentId);
    assert.equal(ring[2].parentId, ring[3].parentId);
    assert.notEqual(ring[1].parentId, ring[2].parentId);
  });

  it('survives a zero-sized viewport', () => {
    const graph = deriveTopology(input({ peers: [peer(id('a'))] }));
    const layout = layoutTopology(graph, { width: 0, height: 0 });
    for (const node of layout.nodes) {
      assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
    }
  });
});
