import { useMemo } from 'react';
import { Alert, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';

import { useMeshUi } from '@/mesh/MeshUiContext';
import { signal } from '@/theme/signal';

import { useGames } from './GameContext';

const BOARD_HEIGHT = 280;

export function PongBoard() {
  const { identity } = useMeshUi();
  const { participants, pongMatch, startPong, movePongPaddle } = useGames();
  const isPlayer = Boolean(
    pongMatch &&
      (pongMatch.hostId === identity.id || pongMatch.guestId === identity.id),
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => isPlayer && Boolean(pongMatch?.running),
        onMoveShouldSetPanResponder: () => isPlayer && Boolean(pongMatch?.running),
        onPanResponderGrant: (event) =>
          movePongPaddle(event.nativeEvent.locationY / BOARD_HEIGHT),
        onPanResponderMove: (event) =>
          movePongPaddle(event.nativeEvent.locationY / BOARD_HEIGHT),
      }),
    [isPlayer, movePongPaddle, pongMatch?.running],
  );

  const start = async () => {
    const result = await startPong();
    if (!result.ok) Alert.alert('Bluetooth Pong', result.error);
  };

  const winnerName = pongMatch?.winnerId
    ? pongMatch.winnerId === identity.id
      ? 'You win!'
      : `${participants.pong.find((player) => player.id === pongMatch.winnerId)?.name ?? 'Opponent'} wins`
    : undefined;

  return (
    <View style={styles.card}>
      <View style={styles.heading}>
        <View>
          <Text style={styles.title}>{winnerName ?? 'First to 5 wins'}</Text>
          <Text style={styles.subtitle}>
            {pongMatch
              ? isPlayer
                ? 'Drag anywhere on the court to move your paddle.'
                : 'Watching the nearby match.'
              : `${participants.pong.length} players joined`}
          </Text>
        </View>
        <View style={styles.score}>
          <Text style={styles.scoreText}>
            {pongMatch ? `${pongMatch.leftScore}  :  ${pongMatch.rightScore}` : '0  :  0'}
          </Text>
        </View>
      </View>

      <View style={styles.court} {...panResponder.panHandlers}>
        <View style={styles.centerLine} />
        <View
          style={[
            styles.paddle,
            styles.leftPaddle,
            { top: `${((pongMatch?.leftY ?? 0.5) * 100) - 14}%` },
          ]}
        />
        <View
          style={[
            styles.paddle,
            styles.rightPaddle,
            { top: `${((pongMatch?.rightY ?? 0.5) * 100) - 14}%` },
          ]}
        />
        <View
          style={[
            styles.ball,
            {
              left: `${((pongMatch?.ballX ?? 0.5) * 100) - 2}%`,
              top: `${((pongMatch?.ballY ?? 0.5) * 100) - 2}%`,
            },
          ]}
        />
        {!pongMatch ? (
          <View style={styles.courtMessage}>
            <Text style={styles.courtMessageTitle}>Ready?</Text>
            <Text style={styles.courtMessageBody}>Two joined players are required.</Text>
          </View>
        ) : null}
      </View>

      {!pongMatch || !pongMatch.running ? (
        <Pressable
          onPress={() => void start()}
          style={({ pressed }) => [styles.startButton, pressed && styles.pressed]}>
          <Text style={styles.startLabel}>{pongMatch ? 'Rematch' : 'Start match'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 16,
    borderWidth: 1,
    padding: 18,
  },
  heading: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  title: { color: signal.ink, fontSize: 20, fontWeight: '800' },
  subtitle: { color: signal.slate, fontSize: 13, marginTop: 4 },
  score: {
    backgroundColor: signal.paper,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  scoreText: { color: signal.deep, fontSize: 18, fontWeight: '800' },
  court: {
    backgroundColor: signal.twilight,
    borderColor: signal.mist,
    borderRadius: 14,
    borderWidth: 2,
    height: BOARD_HEIGHT,
    overflow: 'hidden',
    position: 'relative',
  },
  centerLine: {
    borderColor: 'rgba(255,255,255,0.35)',
    borderStyle: 'dashed',
    borderWidth: 1,
    height: '100%',
    left: '50%',
    position: 'absolute',
  },
  paddle: {
    backgroundColor: signal.white,
    borderRadius: 5,
    height: '28%',
    position: 'absolute',
    width: 10,
  },
  leftPaddle: { left: '4%' },
  rightPaddle: { right: '4%' },
  ball: {
    backgroundColor: signal.sky,
    borderRadius: 8,
    height: 16,
    position: 'absolute',
    width: 16,
  },
  courtMessage: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(27,27,27,0.7)',
    borderRadius: 12,
    padding: 18,
    position: 'absolute',
    top: 100,
  },
  courtMessageTitle: { color: signal.white, fontSize: 22, fontWeight: '800' },
  courtMessageBody: { color: signal.fog, fontSize: 13, marginTop: 4 },
  startButton: {
    alignItems: 'center',
    backgroundColor: signal.deep,
    borderRadius: 10,
    marginTop: 14,
    paddingVertical: 13,
  },
  startLabel: { color: signal.white, fontSize: 16, fontWeight: '700' },
  pressed: { opacity: 0.7 },
});
