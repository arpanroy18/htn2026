import { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';

import { avatarForPeer } from '@/avatar/profile';
import { SignalBars } from '@/components/signal/icons';
import { Avatar } from '@/components/signal/ui';
import { layoutTopology, type PlacedEdge, type PlacedNode } from '@/mesh/topologyLayout';
import { signal } from '@/theme/signal';

import type { TopologyGraph } from '@/mesh/topology';
import type { DeviceIdentity, Peer } from '@/transport';

const NODE_BOX = 78;
const SELF_AVATAR = 56;
const PEER_AVATAR = 44;

function levelFor(rssi?: number): 0 | 1 | 2 | 3 {
  if (typeof rssi !== 'number' || !Number.isFinite(rssi) || rssi === 0 || rssi < -110) return 0;
  if (rssi >= -60) return 3;
  if (rssi >= -75) return 2;
  return 1;
}

function edgeStroke(edge: PlacedEdge) {
  if (edge.status === 'live') return signal.deep;
  return edge.status === 'recent' ? signal.sky : signal.fog;
}

const MeshEdges = memo(function MeshEdges({ layout }: { layout: ReturnType<typeof layoutTopology> }) {
  if (layout.width < 2 || layout.height < 2) return null;
  return (
    <Svg height={layout.height} pointerEvents="none" style={StyleSheet.absoluteFill} width={layout.width}>
      {layout.ringRadii.map((radius, index) => (
        <Circle
          cx={layout.centre.x}
          cy={layout.centre.y}
          fill="none"
          key={`ring-${index}`}
          r={radius}
          stroke={signal.fog}
          strokeDasharray="2 6"
          strokeWidth={1}
        />
      ))}
      {layout.edges.map((edge) => (
        <Line
          key={`${edge.a}-${edge.b}`}
          stroke={edgeStroke(edge)}
          strokeDasharray={edge.status === 'stale' ? '4 4' : undefined}
          strokeLinecap="round"
          strokeWidth={edge.status === 'live' ? 1.5 + Math.min(edge.weight, 4) * 0.5 : 1.5}
          x1={edge.x1}
          x2={edge.x2}
          y1={edge.y1}
          y2={edge.y2}
        />
      ))}
    </Svg>
  );
});

const MeshNode = memo(function MeshNode({
  node,
  identity,
  peers,
  onPress,
}: {
  node: PlacedNode;
  identity: DeviceIdentity;
  peers: Peer[];
  onPress: (id: string) => void;
}) {
  const profile = avatarForPeer(node.id, identity, peers);
  const size = node.depth === 0 ? SELF_AVATAR : PEER_AVATAR;
  const level = levelFor(node.rssi);
  return (
    <Pressable
      accessibilityLabel={`${node.name}, ${node.depth === 0 ? 'centre of the graph' : `${node.depth} hop${node.depth === 1 ? '' : 's'} away`}`}
      accessibilityRole="button"
      onPress={() => onPress(node.id)}
      style={[
        styles.node,
        { left: node.x - NODE_BOX / 2, top: node.y - size / 2 },
        node.status === 'stale' && styles.nodeStale,
      ]}>
      <View
        style={[
          node.kind === 'badge' && styles.badgeRing,
          node.status === 'stale' && styles.staleRing,
          node.depth === 0 && styles.selfRing,
        ]}>
        <Avatar
          color={profile.colorIndex}
          icon={profile.icon}
          name={node.name}
          peerId={node.id}
          size={size}
        />
      </View>
      {node.status === 'live' && node.depth !== 0 && level > 0 ? (
        <SignalBars color={signal.deep} level={level} mutedColor={signal.fog} size={12} />
      ) : null}
      <Text numberOfLines={1} style={styles.label}>
        {node.name}
      </Text>
    </Pressable>
  );
});

export function MeshGraph({
  graph,
  width,
  height,
  identity,
  peers,
  onSelectNode,
}: {
  graph: TopologyGraph;
  width: number;
  height: number;
  identity: DeviceIdentity;
  peers: Peer[];
  onSelectNode: (id: string) => void;
}) {
  // `graph` is held stable by signature upstream, so this is a real cache hit whenever
  // the topology has not structurally changed — which is what stops the nodes drifting.
  const layout = useMemo(() => layoutTopology(graph, { width, height }), [graph, width, height]);

  if (width < 2 || height < 2) return null;

  return (
    <View style={[StyleSheet.absoluteFill, { transform: [{ scale: layout.scale }] }]}>
      <MeshEdges layout={layout} />
      {layout.nodes.map((node) => (
        <MeshNode identity={identity} key={node.id} node={node} onPress={onSelectNode} peers={peers} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  node: {
    alignItems: 'center',
    gap: 3,
    position: 'absolute',
    width: NODE_BOX,
  },
  nodeStale: { opacity: 0.45 },
  badgeRing: {
    backgroundColor: signal.white,
    borderColor: signal.mist,
    borderRadius: 14,
    borderWidth: 2,
    padding: 2,
  },
  staleRing: {
    borderColor: signal.fog,
    borderRadius: 30,
    borderStyle: 'dashed',
    borderWidth: 1,
    padding: 2,
  },
  selfRing: {
    borderColor: signal.deep,
    borderRadius: 34,
    borderWidth: 2,
    padding: 2,
  },
  label: {
    color: signal.ink,
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
  },
});
