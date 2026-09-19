import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar, GroupedList, OutlinedButton, RowPress } from '@/components/signal/ui';
import { mockThreads } from '@/data/mock';
import { signal } from '@/theme/signal';

export default function InviteScreen() {
  const { peerName } = useLocalSearchParams<{ peerId?: string; peerName?: string }>();
  const groups = mockThreads.filter((thread) => thread.kind === 'group');
  const [picked, setPicked] = useState(groups[0]?.id);

  return (
    <SafeAreaView edges={['bottom']} style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.lede}>
          Invite <Text style={styles.ledeStrong}>{peerName ?? 'this peer'}</Text> into a group. Membership is not sent over the mesh yet.
        </Text>
        <Text style={styles.label}>GROUPS</Text>
        <GroupedList>
          {groups.map((group) => (
            <RowPress key={group.id} onPress={() => setPicked(group.id)} style={styles.row}>
              <Avatar kind="group" name={group.name} size={44} />
              <View style={styles.rowMain}>
                <Text style={styles.name}>{group.name}</Text>
                <Text style={styles.meta}>{group.members} members</Text>
              </View>
              <View style={[styles.check, picked === group.id && styles.checkOn]} />
            </RowPress>
          ))}
        </GroupedList>
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
  label: { color: signal.slate, fontSize: 11, fontWeight: '600', letterSpacing: 1.4, marginTop: 6 },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    padding: 14,
  },
  rowMain: { flex: 1 },
  check: {
    borderColor: signal.blue,
    borderRadius: 11,
    borderWidth: 1.5,
    height: 22,
    width: 22,
  },
  checkOn: { backgroundColor: signal.blue },
  name: { color: signal.ink, fontSize: 16, fontWeight: '600' },
  meta: { color: signal.slate, fontSize: 13, marginTop: 3 },
});
