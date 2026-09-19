import { memo, useMemo, useState } from 'react';
import {
  Alert,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useMeshUi } from '@/mesh/MeshUiContext';
import { signal } from '@/theme/signal';

import { useGames } from './GameContext';
import {
  assignedTelephoneChain,
  MAX_DRAWING_STROKES,
  MAX_STROKE_POINTS,
  telephoneRoundSubmissions,
  type DrawingPoint,
  type TelephoneChain,
} from './gameStore';

const CANVAS_HEIGHT = 250;

function strokePath(stroke: DrawingPoint[], width: number, height: number) {
  return stroke
    .map((point, index) => {
      const x = (point.x / 100) * width;
      const y = (point.y / 100) * height;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

const Drawing = memo(function Drawing({
  strokes,
  width,
  height,
}: {
  strokes: DrawingPoint[][];
  width: number;
  height: number;
}) {
  if (width < 2) return null;
  return (
    <Svg height={height} pointerEvents="none" style={StyleSheet.absoluteFill} width={width}>
      {strokes.map((stroke, index) =>
        stroke.length < 2 ? null : (
          <Path
            d={strokePath(stroke, width, height)}
            fill="none"
            key={index}
            stroke={signal.ink}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={5}
          />
        ),
      )}
    </Svg>
  );
});

function modeCopy(mode: TelephoneChain['mode']) {
  if (mode === 'prompt') return { eyebrow: 'WRITE', title: 'Start with a secret phrase' };
  if (mode === 'draw') return { eyebrow: 'DRAW', title: 'Turn these words into a picture' };
  if (mode === 'guess') return { eyebrow: 'GUESS', title: 'What do you think this is?' };
  return { eyebrow: 'REVEAL', title: 'See how every chain changed' };
}

export function DrawingTelephoneBoard({
  setScrollEnabled,
}: {
  setScrollEnabled: (enabled: boolean) => void;
}) {
  const { identity } = useMeshUi();
  const {
    participants,
    telephoneChain,
    startTelephoneChain,
    submitTelephonePrompt,
    submitTelephoneDrawing,
    submitTelephoneGuess,
  } = useGames();
  const [text, setText] = useState('');
  const [strokes, setStrokes] = useState<DrawingPoint[][]>([]);
  const [currentStroke, setCurrentStroke] = useState<DrawingPoint[]>([]);
  const [canvasWidth, setCanvasWidth] = useState(1);

  const game = telephoneChain;
  const chainId = game ? assignedTelephoneChain(game, identity.id) : undefined;
  const assignedEntries = chainId && game ? game.chains[chainId] ?? [] : [];
  const previousEntry = assignedEntries[assignedEntries.length - 1];
  const submitted = Boolean(
    game &&
      assignedEntries.some((entry) => entry.round === game.roundIndex),
  );
  const readyCount = game ? telephoneRoundSubmissions(game) : 0;

  const nameFor = (playerId: string) =>
    playerId === identity.id
      ? 'You'
      : participants.telephone.find((player) => player.id === playerId)?.name ??
        'Nearby player';

  const pointFromEvent = (x: number, y: number) => ({
    x: Math.max(0, Math.min(100, (x / canvasWidth) * 100)),
    y: Math.max(0, Math.min(100, (y / CANVAS_HEIGHT) * 100)),
  });

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () =>
          Boolean(game?.mode === 'draw' && !submitted),
        onStartShouldSetPanResponderCapture: () =>
          Boolean(game?.mode === 'draw' && !submitted),
        onMoveShouldSetPanResponder: () =>
          Boolean(game?.mode === 'draw' && !submitted),
        onMoveShouldSetPanResponderCapture: () =>
          Boolean(game?.mode === 'draw' && !submitted),
        onPanResponderGrant: (event) => {
          if (strokes.length >= MAX_DRAWING_STROKES) return;
          setScrollEnabled(false);
          setCurrentStroke([
            pointFromEvent(event.nativeEvent.locationX, event.nativeEvent.locationY),
          ]);
        },
        onPanResponderMove: (event) => {
          const point = pointFromEvent(
            event.nativeEvent.locationX,
            event.nativeEvent.locationY,
          );
          setCurrentStroke((current) => {
            const previous = current[current.length - 1];
            if (
              previous &&
              Math.hypot(point.x - previous.x, point.y - previous.y) < 2.6
            ) {
              return current;
            }
            if (current.length >= MAX_STROKE_POINTS) {
              return [...current.filter((_, index) => index % 2 === 0), point];
            }
            return [...current, point];
          });
        },
        onPanResponderRelease: () => {
          setScrollEnabled(true);
          setCurrentStroke((current) => {
            if (current.length >= 2) setStrokes((existing) => [...existing, current]);
            return [];
          });
        },
        onPanResponderTerminate: () => {
          setScrollEnabled(true);
          setCurrentStroke((current) => {
            if (current.length >= 2) setStrokes((existing) => [...existing, current]);
            return [];
          });
        },
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
      }),
    // Gesture ownership and dimensions intentionally rebuild the responder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvasWidth, game?.mode, strokes.length, submitted],
  );

  const clearComposer = () => {
    setText('');
    setStrokes([]);
    setCurrentStroke([]);
  };

  const run = async (
    action: () => Promise<{ ok: true } | { ok: false; error: string }>,
  ) => {
    const result = await action();
    if (!result.ok) Alert.alert('Drawing Telephone', result.error);
    return result.ok;
  };

  const startGame = async () => {
    if (await run(startTelephoneChain)) clearComposer();
  };

  const submit = async () => {
    if (!game) return;
    const ok =
      game.mode === 'prompt'
        ? await run(() => submitTelephonePrompt(text))
        : game.mode === 'draw'
          ? await run(() => submitTelephoneDrawing(strokes))
          : await run(() => submitTelephoneGuess(text));
    if (ok) clearComposer();
  };

  if (!game) {
    const joined = participants.telephone;
    return (
      <View style={styles.card}>
        <View style={styles.lobbyHero}>
          <Text style={styles.lobbyEyebrow}>DRAWING TELEPHONE</Text>
          <Text style={styles.lobbyTitle}>Waiting for players</Text>
          <Text style={styles.lobbyBody}>
            Once everyone is in the room, start the game. At least three players are required.
          </Text>
        </View>

        <Text style={styles.sectionLabel}>PLAYERS IN ROOM</Text>
        <View style={styles.playerList}>
          {joined.map((player) => (
            <View key={player.id} style={styles.playerPill}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {player.name.trim().slice(0, 1).toUpperCase() || '?'}
                </Text>
              </View>
              <Text style={styles.playerName}>
                {player.id === identity.id ? 'You' : player.name}
              </Text>
            </View>
          ))}
        </View>

        <Pressable
          disabled={joined.length < 3}
          onPress={() => void startGame()}
          style={({ pressed }) => [
            styles.primary,
            pressed && styles.pressed,
            joined.length < 3 && styles.disabled,
          ]}>
          <Text style={styles.primaryLabel}>
            {joined.length < 3 ? 'Need 3 players to start' : 'Start game'}
          </Text>
        </Pressable>
      </View>
    );
  }

  if (game.mode === 'finished') {
    return (
      <View style={styles.card}>
        <View style={styles.revealHero}>
          <Text style={styles.revealEmoji}>✨</Text>
          <Text style={styles.lobbyTitle}>All chains revealed</Text>
          <Text style={styles.lobbyBody}>From original prompts to final guesses.</Text>
        </View>
        {game.playerIds.map((originId, chainIndex) => (
          <View key={originId} style={styles.chainCard}>
            <Text style={styles.chainTitle}>
              Chain {chainIndex + 1} · started by {nameFor(originId)}
            </Text>
            {(game.chains[originId] ?? []).map((entry, index) => (
              <View key={`${entry.authorId}-${entry.round}`} style={styles.revealEntry}>
                <View style={styles.revealMarker}>
                  <Text style={styles.revealMarkerText}>{index + 1}</Text>
                </View>
                <View style={styles.revealContent}>
                  <Text style={styles.revealMeta}>
                    {entry.kind === 'prompt'
                      ? 'PROMPT'
                      : entry.kind === 'drawing'
                        ? 'DRAWING'
                        : 'GUESS'}{' '}
                    · {nameFor(entry.authorId)}
                  </Text>
                  {entry.kind === 'drawing' ? (
                    <View style={styles.revealDrawing}>
                      <Drawing height={130} strokes={entry.strokes} width={250} />
                    </View>
                  ) : (
                    <Text style={styles.revealText}>“{entry.text}”</Text>
                  )}
                </View>
              </View>
            ))}
          </View>
        ))}
        <Pressable
          onPress={() => void startGame()}
          style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
          <Text style={styles.primaryLabel}>Play again</Text>
        </Pressable>
      </View>
    );
  }

  const copy = modeCopy(game.mode);
  if (submitted) {
    return (
      <View style={styles.card}>
        <View style={styles.progressHeader}>
          <Text style={styles.roundLabel}>
            ROUND {game.roundIndex + 1} OF {game.playerIds.length}
          </Text>
        </View>
        <View style={styles.waitingPanel}>
          <View style={styles.sentCheck}>
            <Text style={styles.sentCheckText}>✓</Text>
          </View>
          <Text style={styles.waitingTitle}>Your response is in</Text>
          <Text style={styles.waitingBody}>
            {readyCount} of {game.playerIds.length} players are ready.
          </Text>
          <View style={styles.readyList}>
            {game.playerIds.map((playerId) => {
              const playerChain = assignedTelephoneChain(game, playerId);
              const ready = Boolean(
                playerChain &&
                  game.chains[playerChain]?.some(
                    (entry) => entry.round === game.roundIndex,
                  ),
              );
              return (
                <View key={playerId} style={styles.readyRow}>
                  <View style={[styles.readyDot, ready && styles.readyDotOn]} />
                  <Text style={styles.readyName}>{nameFor(playerId)}</Text>
                  <Text style={styles.readyStatus}>{ready ? 'Ready' : 'Working…'}</Text>
                </View>
              );
            })}
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.progressHeader}>
        <View>
          <Text style={styles.roundLabel}>
            ROUND {game.roundIndex + 1} OF {game.playerIds.length}
          </Text>
          <Text style={styles.taskEyebrow}>{copy.eyebrow}</Text>
        </View>
      </View>
      <Text style={styles.taskTitle}>{copy.title}</Text>

      {game.mode === 'draw' && previousEntry && previousEntry.kind !== 'drawing' ? (
        <View style={styles.clue}>
          <Text style={styles.clueLabel}>DRAW THIS</Text>
          <Text style={styles.clueText}>{previousEntry.text}</Text>
        </View>
      ) : null}

      {game.mode === 'guess' && previousEntry?.kind === 'drawing' ? (
        <View style={styles.guessDrawing}>
          <Drawing height={210} strokes={previousEntry.strokes} width={300} />
        </View>
      ) : null}

      {game.mode === 'draw' ? (
        <>
          <View
            onLayout={(event) => {
              const width = event.nativeEvent.layout.width;
              setCanvasWidth((current) => (Math.abs(current - width) < 1 ? current : width));
            }}
            onTouchCancel={() => setScrollEnabled(true)}
            onTouchEnd={() => setScrollEnabled(true)}
            onTouchStart={() => setScrollEnabled(false)}
            style={styles.canvas}
            {...panResponder.panHandlers}>
            <Drawing
              height={CANVAS_HEIGHT}
              strokes={strokes}
              width={canvasWidth}
            />
            {currentStroke.length ? (
              <Drawing
                height={CANVAS_HEIGHT}
                strokes={[currentStroke]}
                width={canvasWidth}
              />
            ) : null}
            {!strokes.length && !currentStroke.length ? (
              <Text style={styles.canvasHint}>Draw with your finger</Text>
            ) : null}
          </View>
          <View style={styles.actions}>
            <Pressable
              onPress={() => {
                setStrokes([]);
                setCurrentStroke([]);
              }}
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
              <Text style={styles.secondaryLabel}>Clear</Text>
            </Pressable>
            <Pressable
              disabled={!strokes.length}
              onPress={() => void submit()}
              style={({ pressed }) => [
                styles.primary,
                styles.actionFlex,
                pressed && styles.pressed,
                !strokes.length && styles.disabled,
              ]}>
              <Text style={styles.primaryLabel}>Send drawing</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <TextInput
            autoCapitalize="sentences"
            maxLength={80}
            onChangeText={setText}
            placeholder={game.mode === 'prompt' ? 'A penguin making pancakes…' : 'Your best guess…'}
            placeholderTextColor="#8a8f9b"
            style={styles.input}
            value={text}
          />
          <Text style={styles.characterCount}>{text.length}/80</Text>
          <Pressable
            disabled={!text.trim()}
            onPress={() => void submit()}
            style={({ pressed }) => [
              styles.primary,
              pressed && styles.pressed,
              !text.trim() && styles.disabled,
            ]}>
            <Text style={styles.primaryLabel}>
              {game.mode === 'prompt' ? 'Lock in phrase' : 'Send guess'}
            </Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 18,
    borderWidth: 1,
    padding: 20,
  },
  lobbyHero: { alignItems: 'center', paddingHorizontal: 8, paddingVertical: 10 },
  lobbyEyebrow: {
    color: signal.deep,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.2,
  },
  lobbyTitle: {
    color: signal.ink,
    fontSize: 25,
    fontWeight: '900',
    marginTop: 8,
    textAlign: 'center',
  },
  lobbyBody: {
    color: signal.slate,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 8,
    textAlign: 'center',
  },
  sectionLabel: {
    color: signal.slate,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.9,
    marginTop: 22,
  },
  playerList: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  playerPill: {
    alignItems: 'center',
    backgroundColor: signal.paper,
    borderRadius: 18,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  avatar: {
    alignItems: 'center',
    backgroundColor: signal.mist,
    borderRadius: 12,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  avatarText: { color: signal.ink, fontSize: 10, fontWeight: '900' },
  playerName: { color: signal.ink, fontSize: 12, fontWeight: '700' },
  primary: {
    alignItems: 'center',
    backgroundColor: signal.deep,
    borderRadius: 11,
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  primaryLabel: { color: signal.white, fontSize: 15, fontWeight: '800' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.35 },
  progressHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  roundLabel: { color: signal.slate, fontSize: 11, fontWeight: '900', letterSpacing: 0.7 },
  taskEyebrow: { color: signal.deep, fontSize: 12, fontWeight: '900', marginTop: 5 },
  taskTitle: { color: signal.ink, fontSize: 24, fontWeight: '900', marginTop: 12 },
  clue: { backgroundColor: signal.sky, borderRadius: 12, marginTop: 16, padding: 14 },
  clueLabel: { color: signal.slate, fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  clueText: { color: signal.ink, fontSize: 19, fontWeight: '800', marginTop: 5 },
  input: {
    backgroundColor: signal.paper,
    borderColor: signal.fog,
    borderRadius: 12,
    borderWidth: 1,
    color: signal.ink,
    fontSize: 17,
    marginTop: 18,
    padding: 15,
  },
  characterCount: { color: signal.slate, fontSize: 11, marginTop: 6, textAlign: 'right' },
  canvas: {
    alignItems: 'center',
    backgroundColor: '#fbfbfd',
    borderColor: signal.fog,
    borderRadius: 14,
    borderWidth: 1,
    height: CANVAS_HEIGHT,
    justifyContent: 'center',
    marginTop: 14,
    overflow: 'hidden',
    position: 'relative',
  },
  canvasHint: { color: '#9da2ae', fontSize: 14 },
  actions: { flexDirection: 'row', gap: 10 },
  secondary: {
    alignItems: 'center',
    borderColor: signal.blue,
    borderRadius: 11,
    borderWidth: 1.5,
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  secondaryLabel: { color: signal.blue, fontSize: 15, fontWeight: '800' },
  actionFlex: { flex: 1 },
  guessDrawing: {
    backgroundColor: signal.paper,
    borderRadius: 14,
    height: 210,
    marginTop: 16,
    overflow: 'hidden',
    position: 'relative',
  },
  waitingPanel: { alignItems: 'center', paddingTop: 22 },
  sentCheck: {
    alignItems: 'center',
    backgroundColor: signal.deep,
    borderRadius: 28,
    height: 56,
    justifyContent: 'center',
    width: 56,
  },
  sentCheckText: { color: signal.white, fontSize: 28, fontWeight: '900' },
  waitingTitle: { color: signal.ink, fontSize: 22, fontWeight: '900', marginTop: 13 },
  waitingBody: { color: signal.slate, fontSize: 14, marginTop: 5 },
  readyList: { marginTop: 18, width: '100%' },
  readyRow: {
    alignItems: 'center',
    borderTopColor: signal.fog,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    paddingVertical: 11,
  },
  readyDot: { backgroundColor: signal.fog, borderRadius: 5, height: 10, marginRight: 10, width: 10 },
  readyDotOn: { backgroundColor: signal.deep },
  readyName: { color: signal.ink, flex: 1, fontSize: 14, fontWeight: '700' },
  readyStatus: { color: signal.slate, fontSize: 12 },
  revealHero: { alignItems: 'center', marginBottom: 8 },
  revealEmoji: { fontSize: 32 },
  chainCard: {
    backgroundColor: signal.paper,
    borderRadius: 14,
    marginTop: 14,
    padding: 14,
  },
  chainTitle: { color: signal.ink, fontSize: 15, fontWeight: '900' },
  revealEntry: { flexDirection: 'row', marginTop: 14 },
  revealMarker: {
    alignItems: 'center',
    backgroundColor: signal.sky,
    borderRadius: 12,
    height: 24,
    justifyContent: 'center',
    marginRight: 10,
    width: 24,
  },
  revealMarkerText: { color: signal.ink, fontSize: 10, fontWeight: '900' },
  revealContent: { flex: 1 },
  revealMeta: { color: signal.slate, fontSize: 9, fontWeight: '900', letterSpacing: 0.7 },
  revealText: { color: signal.ink, fontSize: 17, fontWeight: '800', marginTop: 5 },
  revealDrawing: {
    height: 130,
    marginTop: 7,
    overflow: 'hidden',
    position: 'relative',
  },
});
