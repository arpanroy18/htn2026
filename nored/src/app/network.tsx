import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MeshGraph } from '@/components/mesh-graph';
import { Chip, OutlinedButton, TextLink } from '@/components/signal/ui';
import { statusCopy, useMeshUi } from '@/mesh/MeshUiContext';
import { EDGE_TTL_MS, MAX_DEPTH_LIMIT } from '@/mesh/topology';
import { useTopology } from '@/mesh/useTopology';
import { signal } from '@/theme/signal';

const DEPTHS = [1, 2, 3, 4, 5, 6].filter((value) => value <= MAX_DEPTH_LIMIT);

export default function NetworkScreen() {
  const { identity, visibleNoredPeers, state, rescan } = useMeshUi();
  const [root, setRoot] = useState(identity.id);
  const [maxDepth, setMaxDepth] = useState(3);
  const [showHistory, setShowHistory] = useState(false);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [rescanning, setRescanning] = useState(false);

  const graph = useTopology({
    selfId: identity.id,
    rootId: root,
    peers: visibleNoredPeers,
    maxDepth,
    historyMs: showHistory ? Infinity : EDGE_TTL_MS,
  });

  const counts = useMemo(() => {
    let badges = 0;
    let live = 0;
    for (const node of graph.nodes) {
      if (node.kind === 'badge') badges += 1;
      if (node.status === 'live' && node.depth > 0) live += 1;
    }
    return { badges, live, total: graph.nodes.length };
  }, [graph]);

  const onSelectNode = useCallback((id: string) => setRoot(id), []);

  const rooted = root === identity.id ? null : graph.nodes.find((node) => node.id === root);
  const alone = graph.nodes.length <= 1;

  return (
    <SafeAreaView edges={['bottom']} style={styles.safe}>
      {state !== 'running' ? <Text style={styles.notice}>{statusCopy(state)}</Text> : null}

      <View style={styles.controls}>
        <Text style={styles.label}>HOPS</Text>
        <View style={styles.segment}>
          {DEPTHS.map((value) => (
            <Pressable
              accessibilityLabel={`Show ${value} hop${value === 1 ? '' : 's'}`}
              accessibilityRole="button"
              key={value}
              onPress={() => setMaxDepth(value)}
              style={[styles.segmentItem, value === maxDepth && styles.segmentItemActive]}>
              <Text style={[styles.segmentLabel, value === maxDepth && styles.segmentLabelActive]}>{value}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setViewport((current) =>
            Math.abs(current.width - width) < 1 && Math.abs(current.height - height) < 1
              ? current
              : { width, height },
          );
        }}
        style={styles.canvas}>
        {alone ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {rooted ? `Nothing else around ${rooted.name}` : 'Nothing else on the mesh yet'}
            </Text>
            <Text style={styles.emptyBody}>
              {rooted
                ? 'No routes through this device have been seen recently.'
                : 'Other Nored phones and badges appear here as soon as they come into range or relay a message.'}
            </Text>
            {rooted ? null : (
              <OutlinedButton
                label={rescanning ? 'Scanning…' : 'Scan again'}
                onPress={() => {
                  setRescanning(true);
                  void rescan().finally(() => setRescanning(false));
                }}
                style={styles.emptyButton}
              />
            )}
          </View>
        ) : (
          <MeshGraph
            graph={graph}
            height={viewport.height}
            identity={identity}
            onSelectNode={onSelectNode}
            peers={visibleNoredPeers}
            width={viewport.width}
          />
        )}
      </View>

      <View style={styles.footer}>
        <ScrollView contentContainerStyle={styles.chips} horizontal showsHorizontalScrollIndicator={false}>
          <Chip label={`${counts.total} node${counts.total === 1 ? '' : 's'}`} tone="fog" />
          {counts.live > 0 ? <Chip label={`${counts.live} live`} tone="blue" /> : null}
          {counts.badges > 0 ? <Chip label={`${counts.badges} badge${counts.badges === 1 ? '' : 's'}`} tone="mist" /> : null}
          {graph.hiddenCount > 0 ? (
            <Chip label={`+${graph.hiddenCount} beyond ${maxDepth} hop${maxDepth === 1 ? '' : 's'}`} tone="amber" />
          ) : null}
          {graph.orphanCount > 0 ? <Chip label={`${graph.orphanCount} unreachable`} tone="fog" /> : null}
        </ScrollView>

        <View style={styles.legend}>
          <View style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: signal.deep }]} />
            <Text style={styles.legendLabel}>Live link</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: signal.sky }]} />
            <Text style={styles.legendLabel}>Recent route</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.swatch, styles.swatchStale]} />
            <Text style={styles.legendLabel}>Older route</Text>
          </View>
        </View>

        <View style={styles.actions}>
          {rooted ? (
            <TextLink label={`← Back to you (viewing ${rooted.name})`} onPress={() => setRoot(identity.id)} />
          ) : (
            <Text style={styles.hint}>Tap any device to explore the mesh from there.</Text>
          )}
          <TextLink
            label={showHistory ? 'Recent only' : 'Show history'}
            onPress={() => setShowHistory((value) => !value)}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { backgroundColor: signal.paper, flex: 1 },
  notice: {
    backgroundColor: signal.white,
    borderBottomColor: signal.fog,
    borderBottomWidth: 1,
    color: signal.slate,
    fontSize: 13,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  controls: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  label: { color: signal.slate, fontSize: 11, fontWeight: '600', letterSpacing: 1.4 },
  segment: {
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  segmentItem: { paddingHorizontal: 14, paddingVertical: 6 },
  segmentItemActive: { backgroundColor: signal.deep },
  segmentLabel: { color: signal.slate, fontSize: 14, fontWeight: '600' },
  segmentLabelActive: { color: signal.white },
  canvas: { flex: 1, overflow: 'hidden', position: 'relative' },
  empty: { alignItems: 'center', flex: 1, justifyContent: 'center', paddingHorizontal: 40 },
  emptyTitle: { color: signal.ink, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  emptyBody: { color: signal.slate, fontSize: 14, lineHeight: 20, marginTop: 8, textAlign: 'center' },
  emptyButton: { marginTop: 18 },
  footer: {
    borderTopColor: signal.fog,
    borderTopWidth: 1,
    gap: 10,
    paddingBottom: 6,
    paddingTop: 12,
  },
  chips: { flexDirection: 'row', gap: 8, paddingHorizontal: 24 },
  legend: { flexDirection: 'row', gap: 16, paddingHorizontal: 24 },
  legendItem: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  swatch: { borderRadius: 1, height: 2, width: 18 },
  swatchStale: { backgroundColor: signal.fog, height: 2 },
  legendLabel: { color: signal.slate, fontSize: 12 },
  actions: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
  },
  hint: { color: signal.slate, flexShrink: 1, fontSize: 12 },
});
