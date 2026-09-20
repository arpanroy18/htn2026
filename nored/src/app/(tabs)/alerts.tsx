import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { PlusIcon } from '@/components/signal/icons';
import { Screen, ScreenHeader } from '@/components/signal/screen';
import { Avatar, Chip, GroupedList, IconButton, RowPress } from '@/components/signal/ui';
import { useAlerts } from '@/mesh/AlertContext';
import { type AlertItem, severityTone } from '@/mesh/alertStore';
import { alertThreadId } from '@/mesh/chatStore';
import { signal } from '@/theme/signal';

function AlertRow({ item }: { item: AlertItem }) {
  return (
    <RowPress
      onPress={() =>
        router.push({
          pathname: '/chat/[id]',
          params: { id: alertThreadId(item.id), title: 'Alert', kind: 'group' },
        })
      }
      style={styles.row}>
      <Avatar name={item.sender} peerId={item.senderId} size={44} />
      <View style={styles.rowMain}>
        <View style={styles.rowTop}>
          <Chip label={item.severity} tone={severityTone(item.severity)} />
          <Text style={styles.time}>{item.time}</Text>
        </View>
        <Text style={styles.bodyText}>{item.body}</Text>
        <Text style={styles.meta}>
          {item.sender} · {item.hops} hop{item.hops === 1 ? '' : 's'}
          {item.hasLocation ? ' · Location' : ''}
        </Text>
      </View>
    </RowPress>
  );
}

export default function AlertsScreen() {
  const { alerts, setAlertsFocused } = useAlerts();

  useFocusEffect(
    useCallback(() => {
      setAlertsFocused(true);
      return () => setAlertsFocused(false);
    }, [setAlertsFocused]),
  );

  return (
    <Screen>
      <ScreenHeader
        action={
          <IconButton onPress={() => router.push('/compose-alert')} tone="filled">
            <PlusIcon color={signal.white} size={18} />
          </IconButton>
        }
        title="Alerts"
      />
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={styles.section}>Inbox</Text>
        {alerts.length === 0 ? (
          <Text style={styles.empty}>
            No alerts yet. Tap + to broadcast to every reachable phone on the mesh.
          </Text>
        ) : (
          <GroupedList>
            {alerts.map((item) => (
              <AlertRow item={item} key={item.id} />
            ))}
          </GroupedList>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: 8, paddingBottom: 36, paddingHorizontal: 24 },
  section: {
    color: signal.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: 6,
  },
  row: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    padding: 14,
  },
  rowMain: { flex: 1 },
  rowTop: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  time: { color: signal.slate, fontSize: 12 },
  bodyText: { color: signal.ink, fontSize: 15, lineHeight: 21, marginTop: 8 },
  meta: { color: signal.slate, fontSize: 12, marginTop: 8 },
  empty: { color: signal.slate, fontSize: 15, lineHeight: 22, marginTop: 4 },
});
