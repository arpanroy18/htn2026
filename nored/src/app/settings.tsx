import { router } from 'expo-router';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ChevronIcon } from '@/components/signal/icons';
import { Avatar, GroupedList, OutlinedButton, RowPress } from '@/components/signal/ui';
import { useChat } from '@/mesh/ChatContext';
import { useMeshUi } from '@/mesh/MeshUiContext';
import { signal } from '@/theme/signal';

export default function SettingsScreen() {
  const { identity } = useMeshUi();
  const { clearLocalData } = useChat();

  return (
    <SafeAreaView edges={['bottom']} style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.profile}>
          <Avatar name={identity.name} size={64} />
          <Text style={styles.name}>{identity.name}</Text>
          <Text style={styles.meta}>No account · Device ID {identity.id.slice(0, 8)}</Text>
        </View>

        <Text style={styles.label}>ACCOUNT</Text>
        <GroupedList>
          <RowPress onPress={() => router.replace('/(tabs)')} style={styles.row}>
            <Text style={styles.rowLabel}>Rename on Nearby</Text>
            <ChevronIcon color={signal.slate} size={12} />
          </RowPress>
          <RowPress onPress={() => router.push('/onboarding')} style={styles.row}>
            <Text style={styles.rowLabel}>Permissions</Text>
            <ChevronIcon color={signal.slate} size={12} />
          </RowPress>
        </GroupedList>

        <Text style={[styles.label, styles.spaced]}>STORAGE</Text>
        <GroupedList>
          <View style={styles.rowStatic}>
            <Text style={styles.rowLabel}>Local JSON</Text>
            <Text style={styles.rowValue}>Chats saved on device</Text>
          </View>
        </GroupedList>

        <OutlinedButton
          label="Clear local data"
          onPress={() =>
            Alert.alert(
              'Clear local data',
              'Delete all saved chats from this phone? This cannot be undone.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Clear',
                  style: 'destructive',
                  onPress: () => void clearLocalData(),
                },
              ],
            )
          }
          style={styles.clearButton}
        />
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
  name: { color: signal.ink, fontSize: 22, fontWeight: '800', marginTop: 12 },
  meta: { color: signal.slate, fontSize: 13, marginTop: 4 },
  label: { color: signal.slate, fontSize: 11, fontWeight: '600', letterSpacing: 1.4, marginBottom: 2 },
  spaced: { marginTop: 14 },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 16,
  },
  rowStatic: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 16,
  },
  rowLabel: { color: signal.ink, fontSize: 16, fontWeight: '500' },
  rowValue: { color: signal.slate, fontSize: 13 },
  clearButton: { marginTop: 10 },
});
