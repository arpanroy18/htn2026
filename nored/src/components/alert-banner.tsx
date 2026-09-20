import { router } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AlertsIcon } from '@/components/signal/icons';
import { Chip } from '@/components/signal/ui';
import { useAlerts } from '@/mesh/AlertContext';
import { severityPresentation, severityTone } from '@/mesh/alertStore';
import { alertThreadId } from '@/mesh/chatStore';
import { signal } from '@/theme/signal';

// Shown for every incoming alert even when notification permission was refused, so the
// phone matches the badge: the badge always paints its screen, the phone always shows this.
const AUTO_HIDE_MS = { INFO: 6000, HELP: 10_000, DANGER: 15_000 } as const;

export function AlertBanner() {
  const { incoming, dismissIncoming } = useAlerts();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!incoming) return;
    const timer = setTimeout(dismissIncoming, AUTO_HIDE_MS[incoming.severity]);
    return () => clearTimeout(timer);
  }, [dismissIncoming, incoming]);
  if (!incoming) return null;
  const ux = severityPresentation[incoming.severity];
  const open = () => {
    dismissIncoming();
    router.push({ pathname: '/chat/[id]', params: { id: alertThreadId(incoming.id), title: 'Alert', kind: 'group' } });
  };
  return (
    <View pointerEvents="box-none" style={[styles.host, { top: insets.top + 8 }]}>
      <Pressable
        accessibilityLabel={`${ux.title} from ${incoming.sender}: ${incoming.body}`}
        accessibilityRole="button"
        onPress={open}
        style={({ pressed }) => [styles.card, ux.urgent && styles.cardUrgent, pressed && styles.pressed]}>
        <View style={styles.icon}>
          <AlertsIcon color={signal.ink} size={18} />
        </View>
        <View style={styles.copy}>
          <View style={styles.top}>
            <Chip label={incoming.severity} tone={severityTone(incoming.severity)} />
            <Text numberOfLines={1} style={styles.meta}>
              {incoming.sender} · {incoming.hops} hop{incoming.hops === 1 ? '' : 's'}
            </Text>
          </View>
          <Text numberOfLines={2} style={styles.body}>{incoming.body}</Text>
        </View>
        <Pressable accessibilityLabel="Dismiss alert banner" hitSlop={10} onPress={dismissIncoming} style={styles.close}>
          <Text style={styles.closeText}>×</Text>
        </Pressable>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { left: 0, paddingHorizontal: 12, position: 'absolute', right: 0, zIndex: 100 },
  card: {
    alignItems: 'flex-start',
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { height: 4, width: 0 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 6,
  },
  cardUrgent: { backgroundColor: signal.sky, borderColor: signal.sky },
  pressed: { opacity: 0.9 },
  icon: {
    alignItems: 'center',
    backgroundColor: signal.white,
    borderRadius: 10,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  copy: { flex: 1, gap: 6 },
  top: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  meta: { color: signal.slate, flex: 1, fontSize: 12 },
  body: { color: signal.ink, fontSize: 15, lineHeight: 20 },
  close: { padding: 2 },
  closeText: { color: signal.slate, fontSize: 20, lineHeight: 22 },
});
