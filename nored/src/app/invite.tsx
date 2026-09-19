import { router, useLocalSearchParams } from 'expo-router';
import { Alert, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar, GroupedList, OutlinedButton, RowPress } from '@/components/signal/ui';
import { useChat } from '@/mesh/ChatContext';
import { MAX_GROUP_MEMBERS } from '@/mesh/chatStore';
import { signal } from '@/theme/signal';

export default function InviteScreen() {
  const { peerId, peerName } = useLocalSearchParams<{ peerId?: string; peerName?: string }>();
  const { threads, inviteToGroup } = useChat();
  const groups = threads.filter((thread) => thread.kind === 'group');
  const targetId = Array.isArray(peerId) ? peerId[0] : peerId;
  const targetName = Array.isArray(peerName) ? peerName[0] : peerName;

  const invite = (groupId: string, groupName: string) => {
    if (!targetId) return;
    const result = inviteToGroup(groupId, targetId);
    if (!result.ok) {
      Alert.alert('Could not invite', result.error);
      return;
    }
    router.replace({
      pathname: '/chat/[id]',
      params: { id: groupId, title: groupName, kind: 'group' },
    });
  };

  return (
    <SafeAreaView edges={['bottom']} style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.lede}>
          Invite <Text style={styles.ledeStrong}>{targetName ?? 'this peer'}</Text> into a group. Membership is sent over Bluetooth to every member.
        </Text>
        <Text style={styles.label}>GROUPS</Text>
        {groups.length === 0 ? (
          <Text style={styles.empty}>No live groups yet. Create one from Chats after nearby phones appear.</Text>
        ) : (
          <GroupedList>
            {groups.map((group) => {
              const already = group.memberIds.includes(targetId ?? '');
              const full = group.memberIds.length >= MAX_GROUP_MEMBERS;
              const seats = MAX_GROUP_MEMBERS - group.memberIds.length;
              return (
                <RowPress
                  disabled={already || full}
                  key={group.id}
                  onPress={() => invite(group.id, group.name)}
                  style={styles.row}>
                  <Avatar kind="group" name={group.name} size={38} />
                  <Text style={styles.groupName}>{group.name}</Text>
                  <Text style={styles.meta}>
                    {already ? 'Already in' : full ? 'Full' : `${seats} seat${seats === 1 ? '' : 's'}`}
                  </Text>
                </RowPress>
              );
            })}
          </GroupedList>
        )}
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
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    padding: 14,
  },
  groupName: { color: signal.ink, flex: 1, fontSize: 16, fontWeight: '600' },
  meta: { color: signal.slate, fontSize: 13, fontWeight: '600' },
});
