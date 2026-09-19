import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { PlusIcon } from '@/components/signal/icons';
import { Screen, ScreenHeader } from '@/components/signal/screen';
import { Avatar, Chip, GroupedList, IconButton, RowPress, UnreadBadge } from '@/components/signal/ui';
import { mockThreads, type Thread } from '@/data/mock';
import { signal } from '@/theme/signal';

function ThreadRow({ thread }: { thread: Thread }) {
  const unread = thread.unread > 0;
  return (
    <RowPress
      onPress={() =>
        router.push({
          pathname: '/chat/[id]',
          params: { id: thread.id, title: thread.name, kind: thread.kind },
        })
      }
      style={styles.row}>
      <Avatar kind={thread.kind} name={thread.name} size={52} />
      <View style={styles.main}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={[styles.name, unread && styles.nameUnread]}>
            {thread.name}
          </Text>
          <Text style={[styles.time, unread && styles.timeUnread]}>{thread.time}</Text>
        </View>
        <View style={styles.previewRow}>
          <Text numberOfLines={1} style={[styles.preview, unread && styles.previewUnread]}>
            {thread.preview}
          </Text>
          <UnreadBadge count={thread.unread} />
        </View>
        {thread.queued || thread.outOfRange ? (
          <View style={styles.chips}>
            {thread.queued ? <Chip label="Queued" tone="mist" /> : null}
            {thread.outOfRange ? <Chip label="Out of range" /> : null}
          </View>
        ) : null}
      </View>
    </RowPress>
  );
}

export default function ChatsScreen() {
  const groups = mockThreads.filter((thread) => thread.kind === 'group');
  const dms = mockThreads.filter((thread) => thread.kind === 'dm');

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
        {groups.length ? (
          <>
            <Text style={styles.groupLabel}>GROUPS</Text>
            <GroupedList>
              {groups.map((thread) => (
                <ThreadRow key={thread.id} thread={thread} />
              ))}
            </GroupedList>
          </>
        ) : null}

        {dms.length ? (
          <>
            <Text style={[styles.groupLabel, styles.spaced]}>DIRECT</Text>
            <GroupedList>
              {dms.map((thread) => (
                <ThreadRow key={thread.id} thread={thread} />
              ))}
            </GroupedList>
          </>
        ) : null}
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
  spaced: { marginTop: 18 },
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
});
