import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar, GroupedList, OutlinedButton, RowPress } from '@/components/signal/ui';
import { mockThreads } from '@/data/mock';
import { useMeshUi } from '@/mesh/MeshUiContext';
import { signal } from '@/theme/signal';

export default function NewGroupScreen() {
  const { noredPeers } = useMeshUi();
  const [name, setName] = useState('');
  const fallback = mockThreads.filter((thread) => thread.kind === 'dm').map((thread) => thread.name);
  const people = noredPeers.length
    ? noredPeers.map((peer) => peer.name)
    : fallback;
  const [picked, setPicked] = useState<string[]>([]);

  const remaining = 8 - picked.length;
  const canCreate = name.trim().length > 0 && picked.length > 0;

  const toggle = (person: string) => {
    setPicked((current) =>
      current.includes(person) ? current.filter((item) => item !== person) : current.length < 8 ? [...current, person] : current,
    );
  };

  const helper = useMemo(() => {
    if (noredPeers.length === 0) return 'No live peers yet — sample names are shown so the layout can be reviewed.';
    return 'Invite in-range Nored phones. Membership UI only; the mesh does not persist groups yet.';
  }, [noredPeers.length]);

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
        <Text style={styles.label}>IN RANGE · {remaining} seats left</Text>
        <GroupedList>
          {people.map((person) => {
            const on = picked.includes(person);
            return (
              <RowPress key={person} onPress={() => toggle(person)} style={styles.row}>
                <Avatar name={person} size={38} />
                <Text style={styles.person}>{person}</Text>
                <View style={[styles.check, on && styles.checkOn]} />
              </RowPress>
            );
          })}
        </GroupedList>
        <OutlinedButton
          disabled={!canCreate}
          label="Create group"
          onPress={() =>
            router.replace({
              pathname: '/chat/[id]',
              params: { id: 'g-new', title: name.trim(), kind: 'group' },
            })
          }
        />
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
