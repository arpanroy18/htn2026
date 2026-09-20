import type { TopologyEdge, TopologyGraph, TopologyNode } from './topology';

const TAU = Math.PI * 2;

export type PlacedNode = TopologyNode & { x: number; y: number; angle: number; radius: number };
export type PlacedEdge = Pick<TopologyEdge, 'a' | 'b' | 'kind' | 'status' | 'weight'> & {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type TopologyLayout = {
  width: number;
  height: number;
  /** Applied as a single transform to the whole canvas so edges and nodes cannot drift. */
  scale: number;
  centre: { x: number; y: number };
  ringRadii: number[];
  nodes: PlacedNode[];
  edges: PlacedEdge[];
};

export type LayoutOptions = {
  nodeRadius?: number;
  labelHeight?: number;
  minRingGap?: number;
  maxRingGap?: number;
  minScale?: number;
};

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

type Slot = { id: string; angle: number; radius: number };

/**
 * Even out one ring. Sparse rings keep the parent-grouped wedge angles; crowded rings
 * degrade continuously towards uniform spacing, anchored on the first node so the ring
 * never spins. A ring past its angular capacity is staggered onto two sub-radii.
 */
function relaxRing(ring: Slot[], baseRadius: number, ringGap: number, nodeRadius: number) {
  const count = ring.length;
  if (count < 2 || baseRadius <= 0) return;
  ring.sort((x, y) => x.angle - y.angle || (x.id < y.id ? -1 : 1));

  const minSep = (2 * (nodeRadius + 4)) / baseRadius;
  const capacity = Math.max(1, Math.floor(TAU / minSep));
  const staggered = count > capacity;
  if (staggered) {
    for (let i = 1; i < count; i += 2) ring[i].radius = baseRadius + ringGap * 0.42;
  }

  // Unwrap to a monotonic sequence so the blend below cannot cross the 0/TAU seam.
  const unwrapped = [ring[0].angle];
  for (let i = 1; i < count; i += 1) {
    let angle = ring[i].angle;
    while (angle < unwrapped[i - 1]) angle += TAU;
    unwrapped.push(angle);
  }

  let smallestGap = (unwrapped[0] + TAU) - unwrapped[count - 1];
  for (let i = 0; i < count - 1; i += 1) {
    smallestGap = Math.min(smallestGap, unwrapped[i + 1] - unwrapped[i]);
  }

  // Two sub-radii halve the angular separation each node needs.
  const required = staggered ? minSep / 2 : minSep;
  const alpha = clamp((required - smallestGap) / required, 0, 1);
  if (alpha <= 0) return;
  const start = unwrapped[0];
  for (let i = 0; i < count; i += 1) {
    ring[i].angle = unwrapped[i] * (1 - alpha) + (start + (TAU * i) / count) * alpha;
  }
}

export function layoutTopology(
  graph: TopologyGraph,
  viewport: { width: number; height: number },
  options: LayoutOptions = {},
): TopologyLayout {
  const nodeRadius = options.nodeRadius ?? 22;
  const labelHeight = options.labelHeight ?? 14;
  const minRingGap = options.minRingGap ?? 56;
  const maxRingGap = options.maxRingGap ?? 120;
  const minScale = options.minScale ?? 0.55;

  const width = Math.max(0, viewport.width);
  const height = Math.max(0, viewport.height);
  const centre = { x: width / 2, y: height / 2 };

  let maxDepth = 0;
  for (const node of graph.nodes) if (node.depth > maxDepth) maxDepth = node.depth;

  const pad = nodeRadius + labelHeight + 6;
  const available = Math.max(60, Math.min(width, height) / 2 - pad);
  const ringGap = maxDepth === 0 ? 0 : clamp(available / maxDepth, minRingGap, maxRingGap);

  const content = ringGap * maxDepth + pad;
  const scale = maxDepth === 0 || content <= 0
    ? 1
    : clamp(Math.min(1, Math.min(width, height) / 2 / content), minScale, 1);

  // Wedge partition: each node owns an angular interval, and its children subdivide it.
  // Disjoint parent intervals make within-ring overlap impossible by construction, and
  // children sit under their parent so direct links stay short and near-radial.
  const intervals = new Map<string, [number, number]>([[graph.rootId, [0, TAU]]]);
  const byDepth = new Map<number, TopologyNode[]>();
  for (const node of graph.nodes) {
    if (!byDepth.has(node.depth)) byDepth.set(node.depth, []);
    byDepth.get(node.depth)!.push(node);
  }

  const slots = new Map<string, Slot>([[graph.rootId, { id: graph.rootId, angle: 0, radius: 0 }]]);

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const ringNodes = byDepth.get(depth) ?? [];
    const groups = new Map<string, TopologyNode[]>();
    for (const node of ringNodes) {
      const parent = node.parentId ?? graph.rootId;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent)!.push(node);
    }

    const ring: Slot[] = [];
    for (const parent of [...groups.keys()].sort()) {
      const kids = groups.get(parent)!.slice().sort((x, y) => (x.id < y.id ? -1 : 1));
      const [low, high] = intervals.get(parent) ?? [0, TAU];
      const span = (high - low) / kids.length;
      kids.forEach((node, index) => {
        const from = low + span * index;
        const to = from + span;
        intervals.set(node.id, [from, to]);
        ring.push({ id: node.id, angle: (from + to) / 2, radius: ringGap * depth });
      });
    }

    relaxRing(ring, ringGap * depth, ringGap, nodeRadius);
    for (const slot of ring) {
      slots.set(slot.id, slot);
      // Keep the interval centred on the relaxed angle so grandchildren follow the node.
      const [from, to] = intervals.get(slot.id)!;
      const half = (to - from) / 2;
      intervals.set(slot.id, [slot.angle - half, slot.angle + half]);
    }
  }

  // Wedge midpoints would leave a lone peer hanging below the root. Rotating the whole
  // layout by a constant puts the first inner node at twelve o'clock while preserving
  // every relative angle, so children stay under their parents.
  let rotation = 0;
  for (const node of byDepth.get(1) ?? []) {
    const angle = slots.get(node.id)?.angle;
    if (angle !== undefined && (rotation === 0 || angle < rotation)) rotation = angle;
  }

  const nodes: PlacedNode[] = graph.nodes.map((node) => {
    const slot = slots.get(node.id) ?? { id: node.id, angle: 0, radius: ringGap * node.depth };
    const screenAngle = slot.angle - rotation - Math.PI / 2;
    return {
      ...node,
      angle: slot.angle - rotation,
      radius: slot.radius,
      x: centre.x + slot.radius * Math.cos(screenAngle),
      y: centre.y + slot.radius * Math.sin(screenAngle),
    };
  });

  const positions = new Map(nodes.map((node) => [node.id, node]));
  const edges: PlacedEdge[] = [];
  for (const edge of graph.edges) {
    const from = positions.get(edge.a);
    const to = positions.get(edge.b);
    if (!from || !to) continue;
    edges.push({
      a: edge.a,
      b: edge.b,
      kind: edge.kind,
      status: edge.status,
      weight: edge.weight,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
    });
  }

  const ringRadii: number[] = [];
  for (let depth = 1; depth <= maxDepth; depth += 1) ringRadii.push(ringGap * depth);

  return { width, height, scale, centre, ringRadii, nodes, edges };
}
