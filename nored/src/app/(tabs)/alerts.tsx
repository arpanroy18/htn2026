import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { AlertsIcon, PlusIcon } from '@/components/signal/icons';
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
  const { alerts, listening, setListening, setAlertsFocused } = useAlerts();
  const pinned = alerts.filter((item) => item.pinned);
  const inbox = alerts.filter((item) => !item.pinned);

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
        <View style={styles.channel}>
          <View style={styles.channelTop}>
            <View style={styles.channelIcon}>
              <AlertsIcon color={signal.ink} size={20} />
            </View>
            <View style={styles.channelCopy}>
              <Text style={styles.channelTitle}>EMERGENCY</Text>
            </View>
            <Switch
              ios_backgroundColor={signal.fog}
              onValueChange={setListening}
              thumbColor={signal.white}
              trackColor={{ false: signal.fog, true: signal.blue }}
              value={listening}
            />
          </View>
          <Text style={styles.channelBody}>
            Floods to every reachable node. Bypasses mute, pins here, and carries up to 280 characters plus an optional location.
          </Text>
        </View>

        {pinned.length ? (
          <>
            <Text style={styles.section}>Pinned</Text>
            <GroupedList style={styles.pinnedGroup}>
              {pinned.map((item) => (
                <AlertRow item={item} key={item.id} />
              ))}
            </GroupedList>
          </>
        ) : null}

        {alerts.length === 0 || inbox.length > 0 ? (
          <Text style={[styles.section, styles.spaced]}>Inbox</Text>
        ) : null}
        {alerts.length === 0 ? (
          <Text style={styles.empty}>
            No alerts yet. Tap + to broadcast to every reachable phone on the mesh.
          </Text>
        ) : inbox.length > 0 ? (
          <GroupedList>
            {inbox.map((item) => (
              <AlertRow item={item} key={item.id} />
            ))}
          </GroupedList>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: 8, paddingBottom: 36, paddingHorizontal: 24 },
  channel: {
    backgroundColor: signal.sky,
    borderRadius: 16,
    marginBottom: 6,
    padding: 20,
  },
  channelTop: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  channelIcon: {
    alignItems: 'center',
    backgroundColor: signal.white,
    borderRadius: 12,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  channelCopy: { flex: 1 },
  channelTitle: { color: signal.ink, fontSize: 22, fontWeight: '800', lineHeight: 26 },
  channelBody: { color: signal.slate, fontSize: 14, lineHeight: 20, marginTop: 12 },
  section: {
    color: signal.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: 6,
  },
  spaced: { marginTop: 18 },
  pinnedGroup: { backgroundColor: signal.mist, borderColor: 'transparent' },
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
