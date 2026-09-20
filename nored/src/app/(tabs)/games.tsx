import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { ChessIcon, PongIcon, TelephoneIcon } from '@/components/signal/icons';
import { Screen, ScreenHeader } from '@/components/signal/screen';
import { Chip, GroupedList, RowPress } from '@/components/signal/ui';
import { mockGames } from '@/data/mock';
import { signal } from '@/theme/signal';

const GAME_ICONS: Record<string, (props: { color: string; size: number }) => React.JSX.Element> = {
  chess: ChessIcon,
  pong: PongIcon,
  telephone: TelephoneIcon,
};

export default function GamesScreen() {
  return (
    <Screen>
      <ScreenHeader title="Games" />
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <GroupedList>
          {mockGames.map((game) => {
            const GameIcon = GAME_ICONS[game.id];
            return (
              <RowPress
                key={game.id}
                onPress={() => router.push({ pathname: '/game/[id]', params: { id: game.id } })}
                style={styles.row}>
                <View style={styles.icon}>
                  {GameIcon ? <GameIcon color={signal.white} size={20} /> : null}
                </View>
                <View style={styles.rowMain}>
                  <Text style={styles.name}>{game.name}</Text>
                  <View style={styles.meta}>
                    <Chip label={game.players} tone="amber" />
                  </View>
                </View>
              </RowPress>
            );
          })}
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
  icon: {
    alignItems: 'center',
    backgroundColor: signal.sky,
    borderRadius: 12,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  rowMain: { flex: 1 },
  name: { color: signal.ink, fontSize: 17, fontWeight: '700' },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
});
