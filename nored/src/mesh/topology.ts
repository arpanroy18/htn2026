import { isBadgePeer } from './badgePeer.ts';
import { peerLabel } from './peerLabel.ts';

import type { Peer } from '../transport/MeshTransport';
import type { ChatState } from './chatStore';
import type { Contact, PacketRecord, RouterData } from './routerStore';

/** A link older than this is dropped entirely. */
export const EDGE_TTL_MS = 15 * 60_000;
/** Inside this window a link still counts as "recent" rather than "stale". */
export const EDGE_RECENT_MS = 5 * 60_000;
export const DEFAULT_MAX_DEPTH = 3;
export const MAX_DEPTH_LIMIT = 6;
/** Beyond this many nodes on one ring the picture stops being readable. */
export const DEFAULT_MAX_PER_RING = 24;

export type TopologyNodeKind = 'self' | 'phone' | 'badge' | 'unknown';
export type TopologyStatus = 'live' | 'recent' | 'stale';
export type TopologyEdgeKind = 'direct' | 'relayed';

export type TopologyNode = {
  id: string;
  name: string;
  /** Hops from the graph root. 0 is the root itself. */
  depth: number;
  kind: TopologyNodeKind;
  status: TopologyStatus;
  /** Best-ranked neighbour one hop closer to the root. Absent for the root. */
  parentId?: string;
  lastSeenAt: number;
  /** Neighbour count before truncation. */
  degree: number;
  rssi?: number;
};

export type TopologyEdge = {
  /** Canonical order: `a` sorts before `b`. */
  a: string;
  b: string;
  /** `direct` means one endpoint is this phone, i.e. a link we hold ourselves. */
  kind: TopologyEdgeKind;
  status: TopologyStatus;
  lastSeenAt: number;
  /** Independent observations of this link. Drives stroke width. */
  weight: number;
};

export type TopologyGraph = {
  selfId: string;
  rootId: string;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  /** Deepest depth found before truncation, so the UI can offer more hops. */
  maxDepthAvailable: number;
  /** Reachable nodes cut by the depth limit or the per-ring cap. */
  hiddenCount: number;
  /** Ids observed in paths with no chain back to the root. */
  orphanCount: number;
  /** Structural key. Equal signatures mean the layout can be reused verbatim. */
  signature: string;
};

export type TopologyPeer = Pick<Peer, 'id' | 'name' | 'rssi' | 'lastSeen' | 'pendingLoss'>;

export type TopologyInput = {
  selfId: string;
  /** Graph origin. Defaults to `selfId`; set to re-root on a tapped node. */
  rootId?: string;
  now: number;
  maxDepth?: number;
  /** `Infinity` keeps every stored path. */
  historyMs?: number;
  maxPerRing?: number;
  peers?: TopologyPeer[];
  contacts?: Record<string, Contact>;
  packets?: Record<string, PacketRecord>;
  chat?: ChatState;
  events?: RouterData['events'];
};

type Link = { a: string; b: string; lastSeenAt: number; weight: number; pinned: boolean };

function linkKey(x: string, y: string) {
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/**
 * Same polynomial as stableHash() in src/avatar/profile.ts, but folded into an
 * accumulator so the signature never materialises a large joined string.
 * Keep the two in step if either changes.
 */
function fold(hash: number, value: string) {
  let next = hash;
  for (let i = 0; i < value.length; i += 1) next = (next * 31 + value.charCodeAt(i)) >>> 0;
  return next;
}

export function deriveTopology(input: TopologyInput): TopologyGraph {
  const selfId = input.selfId;
  const rootId = input.rootId ?? selfId;
  const now = input.now;
  const historyMs = input.historyMs ?? EDGE_TTL_MS;
  const cutoff = historyMs === Infinity ? -Infinity : now - historyMs;
  const maxDepth = Math.max(1, Math.min(MAX_DEPTH_LIMIT, input.maxDepth ?? DEFAULT_MAX_DEPTH));
  const maxPerRing = Math.max(1, input.maxPerRing ?? DEFAULT_MAX_PER_RING);
  const peers = input.peers ?? [];
  const contacts = input.contacts ?? {};

  const links = new Map<string, Link>();
  const live = new Set<string>();
  const rssi = new Map<string, number>();

  function addLink(x: string, y: string, at: number, pinned = false) {
    if (!x || !y || x === y) return;
    // `!(at >= cutoff)` rather than `at < cutoff` so a NaN timestamp is dropped, not kept.
    if (!pinned && !(at >= cutoff)) return;
    const key = linkKey(x, y);
    const existing = links.get(key);
    if (!existing) {
      links.set(key, { a: x < y ? x : y, b: x < y ? y : x, lastSeenAt: at, weight: 1, pinned });
      return;
    }
    existing.weight += 1;
    if (at > existing.lastSeenAt) existing.lastSeenAt = at;
    existing.pinned = existing.pinned || pinned;
  }

  function addPath(path: string[] | undefined, at: number) {
    if (!Array.isArray(path)) return;
    for (let i = 0; i < path.length - 1; i += 1) addLink(path[i], path[i + 1], at);
  }

  // 1. Live and recently-live peers. A connected peer is pinned so a stale `lastSeen`
  //    can never age out a link we are actually holding right now.
  for (const peer of peers) {
    if (!peer.id || peer.id === selfId) continue;
    if (!peer.pendingLoss) {
      live.add(peer.id);
      if (typeof peer.rssi === 'number') rssi.set(peer.id, peer.rssi);
    }
    addLink(selfId, peer.id, peer.lastSeen, !peer.pendingLoss);
  }

  // 2. Stored packets: delivery acks carry a confirmed end-to-end route, envelopes carry
  //    the partial traversal so far. Every relay appends its own id, so consecutive
  //    entries really did talk to each other.
  for (const record of Object.values(input.packets ?? {}) as PacketRecord[]) {
    const packet = record.envelope.packet;
    // Packets live up to a day; one numeric compare skips nearly all of them.
    if (packet.timestamp < cutoff) continue;
    if (packet.type === 'delivery-ack') addPath(packet.messagePath, packet.timestamp);
    addPath(record.envelope.path, packet.timestamp);
  }

  // 3. Chat message paths, including our own sent DMs backfilled when the ack returned.
  for (const thread of Object.values(input.chat?.messages ?? {})) {
    for (const message of thread) addPath(message.path, message.timestamp);
  }

  // 4. The relay event log. `MeshRouter.record` passes an empty `from` for locally
  //    enqueued packets and for acks, so a blank peerId is normal and must be skipped.
  for (const event of input.events ?? []) {
    if (!event.peerId) continue;
    addLink(selfId, event.peerId, event.timestamp);
  }

  const adjacency = new Map<string, Set<string>>();
  for (const link of links.values()) {
    if (!adjacency.has(link.a)) adjacency.set(link.a, new Set());
    if (!adjacency.has(link.b)) adjacency.set(link.b, new Set());
    adjacency.get(link.a)!.add(link.b);
    adjacency.get(link.b)!.add(link.a);
  }

  // 5. Full BFS from the root. It must run to completion before truncating: a node first
  //    met down a deep branch may also be reachable shallowly, and only a complete search
  //    can assign the minimum depth — or count what lies beyond the limit.
  const depths = new Map<string, number>([[rootId, 0]]);
  let frontier = [rootId];
  let currentDepth = 0;
  let maxDepthAvailable = 0;
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      const neighbours = [...(adjacency.get(id) ?? [])].sort();
      for (const neighbour of neighbours) {
        if (depths.has(neighbour)) continue;
        depths.set(neighbour, currentDepth + 1);
        next.push(neighbour);
      }
    }
    currentDepth += 1;
    if (next.length) maxDepthAvailable = currentDepth;
    frontier = next.sort();
  }

  // 6. Parent selection ranks by observation weight then recency then id — deliberately
  //    never by status, so a node ageing from live to stale cannot move it on screen.
  const parents = new Map<string, string>();
  for (const [id, depth] of depths) {
    if (depth === 0) continue;
    let best: string | undefined;
    let bestWeight = -1;
    let bestSeen = -1;
    for (const neighbour of adjacency.get(id) ?? []) {
      if (depths.get(neighbour) !== depth - 1) continue;
      const link = links.get(linkKey(id, neighbour));
      if (!link) continue;
      const better =
        link.weight > bestWeight ||
        (link.weight === bestWeight &&
          (link.lastSeenAt > bestSeen || (link.lastSeenAt === bestSeen && (best === undefined || neighbour < best))));
      if (better) {
        best = neighbour;
        bestWeight = link.weight;
        bestSeen = link.lastSeenAt;
      }
    }
    if (best !== undefined) parents.set(id, best);
  }

  // 7. Truncate by depth, then cap each ring, pruning the descendants of anything dropped.
  const kept = new Set<string>();
  for (const [id, depth] of depths) if (depth <= maxDepth) kept.add(id);

  const byDepth = new Map<number, string[]>();
  for (const id of kept) {
    const depth = depths.get(id)!;
    if (!byDepth.has(depth)) byDepth.set(depth, []);
    byDepth.get(depth)!.push(id);
  }

  const children = new Map<string, string[]>();
  for (const [id, parent] of parents) {
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(id);
  }

  function drop(id: string) {
    if (!kept.delete(id)) return;
    for (const child of children.get(id) ?? []) drop(child);
  }

  const statusRank = (id: string) => (live.has(id) ? 0 : 1);
  const lastSeenOf = (id: string) => {
    let seen = -Infinity;
    for (const neighbour of adjacency.get(id) ?? []) {
      const link = links.get(linkKey(id, neighbour));
      if (link && link.lastSeenAt > seen) seen = link.lastSeenAt;
    }
    return seen;
  };

  // Ascending depth so a parent's removal has already pruned its children before the
  // next ring is capped — otherwise a ring could be trimmed below the cap.
  for (const depth of [...byDepth.keys()].sort((x, y) => x - y)) {
    if (depth === 0) continue;
    const ids = byDepth.get(depth)!.filter((id) => kept.has(id));
    if (ids.length <= maxPerRing) continue;
    const ranked = [...ids].sort((x, y) => {
      const rank = statusRank(x) - statusRank(y);
      if (rank !== 0) return rank;
      const seen = lastSeenOf(y) - lastSeenOf(x);
      if (seen !== 0) return seen;
      return x < y ? -1 : 1;
    });
    for (const id of ranked.slice(maxPerRing)) drop(id);
  }

  const hiddenCount = depths.size - kept.size;
  let orphanCount = 0;
  for (const id of adjacency.keys()) if (!depths.has(id)) orphanCount += 1;

  // 8. Materialise nodes and edges.
  const nameContext = { selfId, peers: peers as Peer[], contacts };
  const nodes: TopologyNode[] = [...kept].map((id) => {
    const seen = lastSeenOf(id);
    const name = peerLabel(id, nameContext);
    const isLive = id === selfId || live.has(id);
    const kind: TopologyNodeKind =
      id === selfId ? 'self'
        : isBadgePeer(name) ? 'badge'
        : peers.some((peer) => peer.id === id) || contacts[id] ? 'phone'
        : 'unknown';
    return {
      id,
      name,
      depth: depths.get(id)!,
      kind,
      status: isLive ? 'live' : now - seen <= EDGE_RECENT_MS ? 'recent' : 'stale',
      parentId: parents.get(id),
      lastSeenAt: seen === -Infinity ? 0 : seen,
      degree: adjacency.get(id)?.size ?? 0,
      rssi: rssi.get(id),
    };
  });
  nodes.sort((x, y) => x.depth - y.depth || (x.id < y.id ? -1 : 1));

  const edges: TopologyEdge[] = [];
  for (const link of links.values()) {
    if (!kept.has(link.a) || !kept.has(link.b)) continue;
    const direct = link.a === selfId || link.b === selfId;
    const other = link.a === selfId ? link.b : link.a;
    // There is no live signal for a link between two other devices, so only a link we
    // hold ourselves is ever drawn as live.
    const isLive = direct && live.has(other);
    edges.push({
      a: link.a,
      b: link.b,
      kind: direct ? 'direct' : 'relayed',
      status: isLive ? 'live' : now - link.lastSeenAt <= EDGE_RECENT_MS ? 'recent' : 'stale',
      lastSeenAt: link.lastSeenAt,
      weight: link.weight,
    });
  }
  edges.sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));

  let hash = 2166136261;
  hash = fold(hash, rootId);
  for (const node of nodes) {
    hash = fold(hash, node.id);
    hash = fold(hash, `${node.depth}`);
    hash = fold(hash, node.kind);
    hash = fold(hash, node.status);
    hash = fold(hash, node.parentId ?? '-');
  }
  for (const edge of edges) {
    hash = fold(hash, edge.a);
    hash = fold(hash, edge.b);
    hash = fold(hash, edge.kind);
    hash = fold(hash, edge.status);
  }

  return {
    selfId,
    rootId,
    nodes,
    edges,
    maxDepthAvailable,
    hiddenCount,
    orphanCount,
    signature: `${nodes.length}.${edges.length}.${hash.toString(36)}`,
  };
}
