import { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { signal } from '@/theme/signal';

export function Screen({ children }: { children: ReactNode }) {
  return (
    <SafeAreaView edges={['top']} style={styles.safe}>
      {children}
    </SafeAreaView>
  );
}

export function ScreenHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{title}</Text>
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
});
