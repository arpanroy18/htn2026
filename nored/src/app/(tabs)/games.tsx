import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { ChevronIcon, GamesIcon } from '@/components/signal/icons';
import { Screen, ScreenHeader } from '@/components/signal/screen';
import { Chip, GroupedList, RowPress } from '@/components/signal/ui';
import { mockGames } from '@/data/mock';
import { signal } from '@/theme/signal';

export default function GamesScreen() {
  return (
    <Screen>
      <ScreenHeader title="Games" />
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <View style={styles.panel}>
          <View style={styles.panelIcon}>
            <GamesIcon color={signal.ink} size={20} />
          </View>
          <View style={styles.panelCopy}>
            <Text style={styles.heading}>Opt-in only</Text>
            <Text style={styles.lede}>
              Low-bandwidth mesh games for downtime. Turns fit in a single BLE frame. Nothing starts until you join a room.
            </Text>
          </View>
        </View>

        <Text style={styles.groupLabel}>AVAILABLE</Text>
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
  panel: {
    backgroundColor: signal.sky,
    borderRadius: 16,
    flexDirection: 'row',
    gap: 14,
    marginBottom: 6,
    padding: 20,
  },
  panelIcon: {
    alignItems: 'center',
    backgroundColor: signal.white,
    borderRadius: 12,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  panelCopy: { flex: 1 },
  heading: { color: signal.ink, fontSize: 20, fontWeight: '800', lineHeight: 24 },
  lede: { color: signal.slate, fontSize: 14, lineHeight: 20, marginTop: 8 },
  groupLabel: {
    color: signal.slate,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.4,
    marginTop: 10,
    marginBottom: 2,
  },
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
