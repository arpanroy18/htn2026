import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
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
  const displayName = Array.isArray(peerName) ? peerName[0] : peerName;

  const invite = async (groupId: string) => {
    if (!targetId) return;
    const ok = await inviteToGroup(groupId, targetId);
    if (ok) router.back();
  };

  return (
    <SafeAreaView edges={['bottom']} style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.lede}>
          Invite <Text style={styles.ledeStrong}>{displayName ?? 'this peer'}</Text> into a group. Membership is sent over Bluetooth when they are in range.
        </Text>
        <Text style={styles.label}>GROUPS</Text>
        {groups.length === 0 ? (
          <Text style={styles.empty}>No groups yet. Create one from Chats, then come back to invite.</Text>
        ) : (
          <GroupedList>
            {groups.map((group) => {
              const already = targetId ? group.memberIds.includes(targetId) : false;
              const full = group.memberIds.length >= MAX_GROUP_MEMBERS;
              const disabled = already || full || !targetId;
              return (
                <RowPress
                  key={group.id}
                  onPress={() => {
                    if (!disabled) void invite(group.id);
                  }}
                  style={styles.row}>
                  <Avatar kind="group" name={group.name} size={38} />
                  <View style={styles.rowMain}>
                    <Text style={styles.groupName}>{group.name}</Text>
                    <Text style={styles.meta}>
                      {already
                        ? 'Already a member'
                        : full
                          ? `${MAX_GROUP_MEMBERS} member cap reached`
                          : `${group.memberIds.length} member${group.memberIds.length === 1 ? '' : 's'}`}
                    </Text>
                  </View>
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
  rowMain: { flex: 1 },
  groupName: { color: signal.ink, fontSize: 16, fontWeight: '600' },
  meta: { color: signal.slate, fontSize: 13, marginTop: 2 },
});
