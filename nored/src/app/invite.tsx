import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OutlinedButton } from '@/components/signal/ui';
import { signal } from '@/theme/signal';

export default function InviteScreen() {
  const { peerName } = useLocalSearchParams<{ peerId?: string; peerName?: string }>();

  return (
    <SafeAreaView edges={['bottom']} style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.lede}>
          Invite <Text style={styles.ledeStrong}>{peerName ?? 'this peer'}</Text> into a group. Membership is not sent over Bluetooth yet.
        </Text>
        <Text style={styles.label}>GROUPS</Text>
        <Text style={styles.empty}>No live groups yet. Create one from Chats after nearby phones appear.</Text>
        <OutlinedButton label="New group instead" onPress={() => router.replace('/new-group')} />
        <OutlinedButton label="Done" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { backgroundColor: signal.paper, flex: 1 },
  body: { gap: 12, padding: 24 },
  lede: { color: signal.slate, fontSize: 16, lineHeight: 24 },
  ledeStrong: { color: signal.ink, fontWeight: '700' },
  empty: { color: signal.slate, fontSize: 15, lineHeight: 22 },
  label: { color: signal.slate, fontSize: 11, fontWeight: '600', letterSpacing: 1.4, marginTop: 6 },
});
