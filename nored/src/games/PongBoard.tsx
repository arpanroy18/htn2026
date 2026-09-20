import { useEffect, useMemo } from 'react';
import {
  Alert,
  Image,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { useMeshUi } from '@/mesh/MeshUiContext';
import { signal } from '@/theme/signal';

import { useGames } from './GameContext';
import { getPongFrame, subscribePongFrame } from './pongRuntime';

const BOARD_HEIGHT = 220;
const BALL_SIZE = 20;
const PADDLE_WIDTH = 0.3;
const PADDLE_HEIGHT = 0.28;
const TABLE_IMAGE = require('../../public/assets/pong/table.png');
const BLUE_PADDLE = require('../../public/assets/pong/blue-paddle.png');
const RED_PADDLE = require('../../public/assets/pong/red-paddle.png');
const YELLOW_BALL = require('../../public/assets/pong/yellow-ball.png');

export function PongBoard() {
  const { identity } = useMeshUi();
  const { participants, pongMatch, startPong, movePongPaddle } = useGames();
  const canStart = participants.pong.length >= 2;
  const isPlayer = Boolean(
    pongMatch &&
      (pongMatch.hostId === identity.id || pongMatch.guestId === identity.id),
  );
  const running = Boolean(pongMatch?.running);
  const courtWidth = useSharedValue(1);
  const courtHeight = useSharedValue(BOARD_HEIGHT);
  const ballX = useSharedValue(pongMatch?.ballX ?? 0.5);
  const ballY = useSharedValue(pongMatch?.ballY ?? 0.5);
  const leftY = useSharedValue(pongMatch?.leftY ?? 0.5);
  const rightY = useSharedValue(pongMatch?.rightY ?? 0.5);

  useEffect(() => {
    const apply = (match: NonNullable<typeof pongMatch>) => {
      ballX.value = match.ballX;
      ballY.value = match.ballY;
      leftY.value = match.leftY;
      rightY.value = match.rightY;
    };
    const current = getPongFrame();
    if (current) apply(current);
    return subscribePongFrame(apply);
  }, [ballX, ballY, leftY, rightY]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => isPlayer && running,
        onMoveShouldSetPanResponder: () => isPlayer && running,
        onPanResponderGrant: (event) =>
          movePongPaddle(event.nativeEvent.locationY / BOARD_HEIGHT),
        onPanResponderMove: (event) =>
          movePongPaddle(event.nativeEvent.locationY / BOARD_HEIGHT),
      }),
    [isPlayer, movePongPaddle, running],
  );

  const onCourtLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    courtWidth.value = Math.max(1, width);
    courtHeight.value = Math.max(1, height);
  };

  const leftPaddleStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (leftY.value - PADDLE_HEIGHT / 2) * courtHeight.value }],
  }));
  const rightPaddleStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (rightY.value - PADDLE_HEIGHT / 2) * courtHeight.value }],
  }));
  const ballStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: ballX.value * courtWidth.value - BALL_SIZE / 2 },
      { translateY: ballY.value * courtHeight.value - BALL_SIZE / 2 },
    ],
  }));

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
              : canStart
                ? 'Ready to start'
                : 'Waiting for a nearby player'}
          </Text>
        </View>
        <View style={styles.score}>
          <Text style={styles.scoreText}>
            {pongMatch ? `${pongMatch.leftScore}  :  ${pongMatch.rightScore}` : '0  :  0'}
          </Text>
        </View>
      </View>

      <View
        collapsable={false}
        onLayout={onCourtLayout}
        style={styles.court}
        {...panResponder.panHandlers}>
        <Image
          fadeDuration={0}
          resizeMode="stretch"
          source={TABLE_IMAGE}
          style={styles.courtImage}
        />
        <Animated.Image
          fadeDuration={0}
          resizeMode="contain"
          source={BLUE_PADDLE}
          style={[styles.paddle, styles.leftPaddle, leftPaddleStyle]}
        />
        <Animated.Image
          fadeDuration={0}
          resizeMode="contain"
          source={RED_PADDLE}
          style={[styles.paddle, styles.rightPaddle, rightPaddleStyle]}
        />
        <Animated.Image
          fadeDuration={0}
          resizeMode="contain"
          source={YELLOW_BALL}
          style={[styles.ball, ballStyle]}
        />
        {!pongMatch ? (
          <View style={styles.courtMessage}>
            <Text style={styles.courtMessageTitle}>
              {canStart ? 'Ready?' : 'Waiting for another player'}
            </Text>
            <Text style={styles.courtMessageBody}>
              {canStart
                ? 'Start when both players are ready.'
                : 'Invite one nearby person to start a match.'}
            </Text>
          </View>
        ) : null}
      </View>

      {!pongMatch || !pongMatch.running ? (
        <Pressable
          disabled={!canStart}
          onPress={() => void start()}
          style={({ pressed }) => [
            styles.startButton,
            pressed && styles.pressed,
            !canStart && styles.disabled,
          ]}>
          <Text style={styles.startLabel}>
            {!canStart ? 'Waiting for player' : pongMatch ? 'Rematch' : 'Start match'}
          </Text>
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
    borderRadius: 14,
    height: BOARD_HEIGHT,
    overflow: 'hidden',
    position: 'relative',
  },
  courtImage: {
    ...StyleSheet.absoluteFill,
    borderRadius: 14,
    height: '100%',
    width: '100%',
  },
  paddle: {
    height: `${PADDLE_HEIGHT * 100}%`,
    position: 'absolute',
    top: 0,
    width: `${PADDLE_WIDTH * 100}%`,
  },
  leftPaddle: { left: '-9%' },
  rightPaddle: { right: '-9%' },
  ball: {
    height: BALL_SIZE,
    left: 0,
    position: 'absolute',
    top: 0,
    width: BALL_SIZE,
  },
  courtMessage: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(27,27,27,0.7)',
    borderRadius: 12,
    padding: 18,
    position: 'absolute',
    top: 70,
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
  disabled: { opacity: 0.4 },
});
