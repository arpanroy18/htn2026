import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { ChevronIcon } from '@/components/signal/icons';
import { Screen, ScreenHeader } from '@/components/signal/screen';
import { Chip, GroupedList, RowPress } from '@/components/signal/ui';
import { mockGames } from '@/data/mock';
import { signal } from '@/theme/signal';

export default function GamesScreen() {
  return (
    <Screen>
      <ScreenHeader title="Games" />
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <GroupedList>
          {mockGames.map((game) => (
            <RowPress
              key={game.id}
              onPress={() => router.push({ pathname: '/game/[id]', params: { id: game.id } })}
              style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.name}>{game.name}</Text>
                <Text style={styles.blurb}>{game.blurb}</Text>
                <View style={styles.meta}>
                  <Chip label={game.players} tone="mist" />
                  <Chip label="Offline" />
                </View>
              </View>
              <ChevronIcon color={signal.slate} size={12} />
            </RowPress>
          ))}
        </GroupedList>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: 8, paddingBottom: 36, paddingHorizontal: 24 },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    padding: 16,
  },
  rowMain: { flex: 1 },
  name: { color: signal.ink, fontSize: 17, fontWeight: '700' },
  blurb: { color: signal.slate, fontSize: 14, lineHeight: 20, marginTop: 6 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
});
