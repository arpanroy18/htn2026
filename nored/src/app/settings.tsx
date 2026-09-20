import { router } from 'expo-router';
import { Alert, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ChevronIcon } from '@/components/signal/icons';
import { Avatar, GroupedList, OutlinedButton, RowPress } from '@/components/signal/ui';
import { useChat } from '@/mesh/ChatContext';
import { useMeshUi } from '@/mesh/MeshUiContext';
import { signal } from '@/theme/signal';

export default function SettingsScreen() {
  const { identity, logs } = useMeshUi();
  const { clearLocalData } = useChat();

  return (
    <SafeAreaView edges={['bottom']} style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.profile}>
          <Avatar
            color={identity.avatarColor}
            icon={identity.avatarIcon}
            name={identity.name}
            peerId={identity.id}
            size={64}
          />
          <Text style={styles.name}>{identity.name}</Text>
          <Text style={styles.meta}>Device ID {identity.id.slice(0, 8)}</Text>
        </View>

        <Text style={styles.label}>ACCOUNT</Text>
        <GroupedList>
          <RowPress onPress={() => router.push('/onboarding')} style={styles.row}>
            <Text style={styles.rowLabel}>Permissions</Text>
            <ChevronIcon color={signal.slate} size={12} />
          </RowPress>
          <RowPress onPress={() => router.push('/network')} style={styles.row}>
            <Text style={styles.rowLabel}>Network graph</Text>
            <ChevronIcon color={signal.slate} size={12} />
          </RowPress>
        </GroupedList>

        <OutlinedButton
          label="Clear local data"
          onPress={() =>
            Alert.alert(
              'Clear local data',
              'Delete all saved chats, contacts, photos and voice notes from this phone? This cannot be undone.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Clear',
                  style: 'destructive',
                  onPress: () => void clearLocalData().catch((error) => Alert.alert('Could not clear all data', error instanceof Error ? error.message : 'Storage operation failed.')),
                },
              ],
            )
          }
          style={styles.clearButton}
        />

        <Text style={[styles.label, styles.spaced]}>DEVICE LOG</Text>
        <View style={styles.log}>
          <Text style={styles.logText}>
            {logs.length ? logs.slice(0, 3).join('\n') : '[BLE] waiting for native transport'}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { backgroundColor: signal.paper, flex: 1 },
  body: { gap: 8, padding: 24 },
  profile: {
    alignItems: 'center',
    marginBottom: 8,
    paddingVertical: 12,
  },
  name: { color: signal.ink, fontSize: 22, fontWeight: '800', marginTop: 12, textAlign: 'center' },
  meta: { color: signal.slate, fontSize: 13, marginTop: 4, textAlign: 'center' },
  label: { color: signal.slate, fontSize: 11, fontWeight: '600', letterSpacing: 1.4, marginBottom: 2 },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 16,
  },
  rowLabel: { color: signal.ink, fontSize: 16, fontWeight: '500' },
  clearButton: { marginTop: 10 },
  spaced: { marginTop: 14 },
  log: {
    backgroundColor: signal.twilight,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  logText: {
    color: signal.fog,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 11,
    lineHeight: 16,
  },
});
