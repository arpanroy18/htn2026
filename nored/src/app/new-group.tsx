import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar, GroupedList, OutlinedButton, RowPress } from '@/components/signal/ui';
import { useChat } from '@/mesh/ChatContext';
import { MAX_GROUP_MEMBERS, MAX_GROUPS } from '@/mesh/chatStore';
import { useMeshUi } from '@/mesh/MeshUiContext';
import { signal } from '@/theme/signal';

export default function NewGroupScreen() {
  const { noredPeers } = useMeshUi();
  const { createGroup, threads } = useChat();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  const canCreate = name.trim().length > 0 && picked.length > 0;
  const atGroupCap = threads.filter((thread) => thread.kind === 'group').length >= MAX_GROUPS;

  const toggle = (person: string) => {
    setPicked((current) =>
      current.includes(person)
        ? current.filter((item) => item !== person)
        : current.length < MAX_GROUP_MEMBERS - 1
          ? [...current, person]
          : current,
    );
  };

  const helper = useMemo(() => {
    if (atGroupCap) return `This phone already has ${MAX_GROUPS} groups, the MVP cap.`;
    if (noredPeers.length === 0) return 'No Nored phones in range. Invite people after they appear on Nearby.';
    return 'Name the group and pick in-range phones. Membership is sent over Bluetooth.';
  }, [atGroupCap, noredPeers.length]);

  const onCreate = () => {
    const result = createGroup(name, picked);
    if (!result.ok) {
      Alert.alert('Could not create group', result.error);
      return;
    }
    router.replace({
      pathname: '/chat/[id]',
      params: { id: result.id, title: name.trim(), kind: 'group' },
    });
  };

  return (
    <SafeAreaView edges={['bottom']} style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.lede}>{helper}</Text>
        <Text style={styles.label}>GROUP NAME</Text>
        <TextInput
          maxLength={40}
          onChangeText={setName}
          placeholder="Hallway Ops"
          placeholderTextColor={signal.slate}
          style={styles.input}
          value={name}
        />
        <Text style={styles.label}>IN RANGE</Text>
        {noredPeers.length === 0 ? (
          <Text style={styles.empty}>Nearby Nored users will show up here.</Text>
        ) : (
          <GroupedList>
            {noredPeers.map((peer) => {
              const on = picked.includes(peer.id);
              return (
                <RowPress key={peer.id} onPress={() => toggle(peer.id)} style={styles.row}>
                  <Avatar
                    color={peer.avatarColor}
                    icon={peer.avatarIcon}
                    name={peer.name}
                    peerId={peer.id}
                    size={38}
                  />
                  <Text style={styles.person}>{peer.name}</Text>
                  <View style={[styles.check, on && styles.checkOn]} />
                </RowPress>
              );
            })}
          </GroupedList>
        )}
        <OutlinedButton disabled={!canCreate || atGroupCap} label="Create group" onPress={onCreate} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { backgroundColor: signal.paper, flex: 1 },
  body: { gap: 12, padding: 24 },
  lede: { color: signal.slate, fontSize: 16, lineHeight: 24 },
  label: { color: signal.slate, fontSize: 11, fontWeight: '600', letterSpacing: 1.4, marginTop: 8 },
  input: {
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 16,
    borderWidth: 1,
    color: signal.ink,
    fontSize: 20,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  empty: { color: signal.slate, fontSize: 15, lineHeight: 22 },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    padding: 14,
  },
  check: {
    borderColor: signal.blue,
    borderRadius: 8,
    borderWidth: 1.5,
    height: 22,
    width: 22,
  },
  checkOn: {
    backgroundColor: signal.blue,
  },
  person: { color: signal.ink, flex: 1, fontSize: 16, fontWeight: '600' },
});
