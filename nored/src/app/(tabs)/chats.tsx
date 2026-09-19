import { useRouterData } from '@/mesh/RouterContext';
import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { PlusIcon } from '@/components/signal/icons';
import { Screen, ScreenHeader } from '@/components/signal/screen';
import { Avatar, Chip, GroupedList, IconButton, RowPress, UnreadBadge } from '@/components/signal/ui';
import { useChat } from '@/mesh/ChatContext';
import { formatThreadTime, isAlertThreadId, type ChatThread } from '@/mesh/chatStore';
import { useMeshUi } from '@/mesh/MeshUiContext';
import { signal } from '@/theme/signal';

function ThreadRow({ thread, inRange }: { thread: ChatThread; inRange: boolean }) {
  const unread = thread.unread > 0;
  const isGroup = thread.kind === 'group';
  return (
    <RowPress
      onPress={() =>
        router.push({
          pathname: '/chat/[id]',
          params: { id: thread.id, title: thread.name, kind: thread.kind },
        })
      }
      style={styles.row}>
      <Avatar kind={isGroup ? 'group' : 'dm'} name={thread.name} size={52} />
      <View style={styles.main}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={[styles.name, unread && styles.nameUnread]}>
            {thread.name}
          </Text>
          <Text style={[styles.time, unread && styles.timeUnread]}>{formatThreadTime(thread.updatedAt)}</Text>
        </View>
        <View style={styles.previewRow}>
          <Text numberOfLines={1} style={[styles.preview, unread && styles.previewUnread]}>
            {thread.preview}
          </Text>
          <UnreadBadge count={thread.unread} />
        </View>
        {thread.queued || !inRange ? (
          <View style={styles.chips}>
            {thread.queued ? <Chip label="Queued" tone="mist" /> : null}
            {!inRange ? <Chip label="Out of range" /> : null}
          </View>
        ) : null}
      </View>
    </RowPress>
  );
}

export default function ChatsScreen() {
  const { threads } = useChat();
  const { contacts } = useRouterData();
  const { identity, noredPeers } = useMeshUi();
  const inRange = new Set(
    noredPeers.filter((peer) => peer.identityConfirmed).map((peer) => peer.id),
  );
  const groups = threads.filter((thread) => thread.kind === 'group' && !isAlertThreadId(thread.id));
  const dms = threads.filter((thread) => thread.kind !== 'group' && !isAlertThreadId(thread.id));
  const visible = groups.length + dms.length;

  const groupInRange = (thread: ChatThread) =>
    thread.memberIds.some((id) => id !== identity.id && inRange.has(id));

  return (
    <Screen>
      <ScreenHeader
        action={
          <IconButton onPress={() => router.push('/new-group')} tone="outline">
            <PlusIcon color={signal.blue} size={18} />
          </IconButton>
        }
        title="Chats"
      />
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {Object.values(contacts).length ? (
          <>
            <Text style={styles.groupLabel}>SAVED CONTACTS</Text>
            <GroupedList>
              {Object.values(contacts).map((contact) => (
                <RowPress key={contact.id} style={styles.row} onPress={() => router.push({ pathname: '/chat/[id]', params: { id: contact.id, title: contact.name } })}>
                  <Avatar name={contact.name} size={38} />
                  <Text style={styles.name}>{contact.name}</Text>
                  <Text style={styles.time}>{inRange.has(contact.id) ? 'Nearby' : 'Via mesh'}</Text>
                </RowPress>
              ))}
            </GroupedList>
          </>
        ) : null}
        {visible === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No Bluetooth chats yet</Text>
            <Text style={styles.empty}>
              Tap a Nored phone on Nearby to start a chat, save contacts for remote text, or create a group. Photos and voice notes wait for a direct connection.
            </Text>
          </View>
        ) : (
          <>
            {groups.length ? (
              <>
                <Text style={styles.groupLabel}>GROUPS</Text>
                <GroupedList>
                  {groups.map((thread) => (
                    <ThreadRow inRange={groupInRange(thread)} key={thread.id} thread={thread} />
                  ))}
                </GroupedList>
              </>
            ) : null}
            {dms.length ? (
              <>
                <Text style={[styles.groupLabel, groups.length ? styles.spaced : null]}>DIRECT</Text>
                <GroupedList>
                  {dms.map((thread) => (
                    <ThreadRow inRange={inRange.has(thread.peerId)} key={thread.id} thread={thread} />
                  ))}
                </GroupedList>
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: 6, paddingBottom: 36, paddingHorizontal: 24 },
  groupLabel: {
    color: signal.slate,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.4,
    marginBottom: 6,
  },
  spaced: { marginTop: 16 },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    padding: 14,
  },
  main: { flex: 1 },
  titleRow: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  name: { color: signal.ink, flex: 1, fontSize: 16, fontWeight: '600' },
  nameUnread: { fontWeight: '800' },
  time: { color: signal.slate, fontSize: 13 },
  timeUnread: { color: signal.deep, fontWeight: '700' },
  previewRow: { alignItems: 'center', flexDirection: 'row', gap: 8, marginTop: 3 },
  preview: { color: signal.slate, flex: 1, fontSize: 14, lineHeight: 20 },
  previewUnread: { color: signal.ink, fontWeight: '500' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  emptyCard: {
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 8,
    padding: 18,
  },
  emptyTitle: { color: signal.ink, fontSize: 18, fontWeight: '800', lineHeight: 24 },
  empty: { color: signal.slate, fontSize: 15, lineHeight: 22, marginTop: 8 },
});
