import { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMeshUi } from '@/mesh/MeshUiContext';
import { signal } from '@/theme/signal';

export function Screen({ children }: { children: ReactNode }) {
  return (
    <SafeAreaView edges={['top']} style={styles.safe}>
      {children}
    </SafeAreaView>
  );
}

export function MeshPill() {
  const { livePeerCount, state } = useMeshUi();
  const count = livePeerCount;
  const live = state === 'running';

  return (
    <View style={styles.pill}>
      <View style={[styles.live, !live && styles.liveWait]} />
      <Text style={styles.pillText}>{count}</Text>
    </View>
  );
}

export function ScreenHeader({
  title,
  action,
  showMesh = true,
}: {
  title: string;
  action?: ReactNode;
  showMesh?: boolean;
}) {
  return (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{title}</Text>
        {showMesh ? <MeshPill /> : null}
      </View>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    backgroundColor: signal.paper,
    flex: 1,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingBottom: 14,
    paddingTop: 8,
  },
  titleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  title: {
    color: signal.ink,
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -0.6,
    lineHeight: 40,
  },
  pill: {
    alignItems: 'center',
    backgroundColor: signal.sky,
    borderRadius: 10,
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  live: {
    backgroundColor: signal.deep,
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  liveWait: {
    backgroundColor: signal.slate,
  },
  pillText: {
    color: signal.ink,
    fontSize: 12,
    fontWeight: '700',
  },
});
