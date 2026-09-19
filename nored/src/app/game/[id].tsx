import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GamesIcon } from '@/components/signal/icons';
import { Chip, MistButton, OutlinedButton } from '@/components/signal/ui';
import { mockGames } from '@/data/mock';
import { signal } from '@/theme/signal';

export default function GameScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useMemo(() => mockGames.find((item) => item.id === id), [id]);
  const [joined, setJoined] = useState(false);

  return (
    <SafeAreaView edges={['bottom']} style={styles.safe}>
      <Stack.Screen options={{ title: game?.name ?? 'Game' }} />
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <GamesIcon color={signal.ink} size={24} />
          </View>
          <Text style={styles.title}>{game?.name ?? 'Unknown game'}</Text>
          <Text style={styles.lede}>{game?.blurb}</Text>
          <View style={styles.chips}>
            <Chip label={game?.players ?? 'Nearby'} tone="mist" />
            <Chip label="≤180 bytes / turn" />
          </View>
        </View>

        <View style={styles.board}>
          <View style={[styles.statusDot, joined && styles.statusDotOn]} />
          <Text style={styles.boardTitle}>{joined ? 'Waiting for peers' : 'Not joined'}</Text>
          <Text style={styles.boardBody}>
            {joined
              ? 'This is the play surface. Moves, scores, and RSSI hunting will render here once game packets exist.'
              : 'Joining is opt-in so a Nearby scan cannot drop you into a match.'}
          </Text>
          {game?.id === 'beacon' ? (
            <View style={styles.rssi}>
              <View style={styles.rssiTrack}>
                <View style={styles.rssiFill} />
              </View>
              <Text style={styles.rssiLabel}>Hot / cold meter</Text>
            </View>
          ) : (
            <View style={styles.placeholder} />
          )}
        </View>

        {joined ? (
          <OutlinedButton label="Leave room" onPress={() => setJoined(false)} />
        ) : (
          <MistButton label="Join room" onPress={() => setJoined(true)} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { backgroundColor: signal.paper, flex: 1 },
  body: { gap: 16, padding: 24 },
  hero: { backgroundColor: signal.sky, borderRadius: 16, padding: 24 },
  heroIcon: {
    alignItems: 'center',
    backgroundColor: signal.white,
    borderRadius: 12,
    height: 44,
    justifyContent: 'center',
    marginBottom: 14,
    width: 44,
  },
  title: { color: signal.ink, fontSize: 32, fontWeight: '800', lineHeight: 37 },
  lede: { color: signal.slate, fontSize: 16, lineHeight: 24, marginTop: 10, maxWidth: 480 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  board: {
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
  },
  statusDot: {
    backgroundColor: signal.fog,
    borderRadius: 4,
    height: 8,
    marginBottom: 10,
    width: 8,
  },
  statusDotOn: { backgroundColor: signal.deep },
  boardTitle: { color: signal.ink, fontSize: 20, fontWeight: '700' },
  boardBody: { color: signal.slate, fontSize: 16, lineHeight: 24, marginTop: 8 },
  placeholder: {
    backgroundColor: signal.paper,
    borderRadius: 16,
    height: 160,
    marginTop: 18,
  },
  rssi: { marginTop: 18 },
  rssiTrack: {
    backgroundColor: signal.paper,
    borderRadius: 8,
    height: 12,
    overflow: 'hidden',
    width: '100%',
  },
  rssiFill: {
    backgroundColor: signal.deep,
    borderRadius: 8,
    height: 12,
    width: '64%',
  },
  rssiLabel: { color: signal.slate, fontSize: 13, marginTop: 8 },
});
