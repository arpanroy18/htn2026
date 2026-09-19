import { useMemo, useState } from 'react';
import {
  Alert,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useMeshUi } from '@/mesh/MeshUiContext';
import { signal } from '@/theme/signal';

import { useGames } from './GameContext';
import {
  MAX_DRAWING_STROKES,
  MAX_STROKE_POINTS,
  type DrawingPoint,
  type TelephoneEntry,
} from './gameStore';

const CANVAS_HEIGHT = 240;
const COLORS = [signal.deep, signal.blue, signal.twilight, signal.mist];

function Drawing({
  strokes,
  width,
  height,
}: {
  strokes: DrawingPoint[][];
  width: number;
  height: number;
}) {
  return (
    <>
      {strokes.flatMap((stroke, strokeIndex) =>
        stroke.slice(1).map((point, index) => {
          const previous = stroke[index];
          const x1 = (previous.x / 100) * width;
          const y1 = (previous.y / 100) * height;
          const x2 = (point.x / 100) * width;
          const y2 = (point.y / 100) * height;
          const length = Math.hypot(x2 - x1, y2 - y1);
          return (
            <View
              key={`${strokeIndex}-${index}`}
              style={[
                styles.line,
                {
                  backgroundColor: COLORS[strokeIndex % COLORS.length],
                  left: (x1 + x2 - length) / 2,
                  top: (y1 + y2) / 2 - 2,
                  transform: [{ rotate: `${Math.atan2(y2 - y1, x2 - x1)}rad` }],
                  width: length,
                },
              ]}
            />
          );
        }),
      )}
    </>
  );
}

function entryLabel(entry: TelephoneEntry) {
  if (entry.kind === 'prompt') return 'Original phrase';
  if (entry.kind === 'guess') return 'Guess';
  return 'Drawing';
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
  const currentPlayerId =
    telephoneChain?.playerIds[telephoneChain.turnIndex];
  const isMyTurn = currentPlayerId === identity.id;
  const currentName =
    currentPlayerId === identity.id
      ? 'You'
      : participants.telephone.find((player) => player.id === currentPlayerId)?.name ??
        'Nearby player';
  const previousEntry = telephoneChain?.entries[telephoneChain.entries.length - 1];

  const pointFromEvent = (x: number, y: number) => ({
    x: Math.max(0, Math.min(100, (x / canvasWidth) * 100)),
    y: Math.max(0, Math.min(100, (y / CANVAS_HEIGHT) * 100)),
  });

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () =>
          Boolean(isMyTurn && telephoneChain?.mode === 'draw'),
        onMoveShouldSetPanResponder: () =>
          Boolean(isMyTurn && telephoneChain?.mode === 'draw'),
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
            if (current.length >= MAX_STROKE_POINTS) return current;
            const previous = current[current.length - 1];
            if (
              previous &&
              Math.hypot(point.x - previous.x, point.y - previous.y) < 1.5
            ) {
              return current;
            }
            return [...current, point];
          });
        },
        onPanResponderRelease: () => {
          setScrollEnabled(true);
          setCurrentStroke((current) => {
            if (current.length >= 2) {
              setStrokes((existing) => [...existing, current]);
            }
            return [];
          });
        },
        onPanResponderTerminate: () => {
          setScrollEnabled(true);
          setCurrentStroke([]);
        },
      }),
    // Gesture ownership and dimensions intentionally rebuild the responder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvasWidth, isMyTurn, strokes.length, telephoneChain?.mode],
  );

  const run = async (
    action: () => Promise<{ ok: true } | { ok: false; error: string }>,
  ) => {
    const result = await action();
    if (!result.ok) Alert.alert('Drawing Telephone', result.error);
    return result.ok;
  };

  const start = async () => {
    if (await run(startTelephoneChain)) {
      setText('');
      setStrokes([]);
    }
  };

  const submit = async () => {
    if (!telephoneChain) return;
    let ok = false;
    if (telephoneChain.mode === 'prompt') {
      ok = await run(() => submitTelephonePrompt(text));
    } else if (telephoneChain.mode === 'draw') {
      ok = await run(() => submitTelephoneDrawing(strokes));
    } else if (telephoneChain.mode === 'guess') {
      ok = await run(() => submitTelephoneGuess(text));
    }
    if (ok) {
      setText('');
      setStrokes([]);
      setCurrentStroke([]);
    }
  };

  if (!telephoneChain) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Start a secret chain</Text>
        <Text style={styles.body}>
          The first player writes a phrase, the next draws it, and the next guesses.
          Three or more joined players are required.
        </Text>
        <Pressable
          onPress={() => void start()}
          style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
          <Text style={styles.primaryLabel}>Start telephone</Text>
        </Pressable>
      </View>
    );
  }

  if (telephoneChain.mode === 'finished') {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>The full chain</Text>
        <Text style={styles.body}>See how the original phrase changed along the way.</Text>
        {telephoneChain.entries.map((entry, index) => (
          <View key={`${entry.authorId}-${index}`} style={styles.revealCard}>
            <Text style={styles.revealLabel}>{entryLabel(entry)} · Turn {index + 1}</Text>
            {entry.kind === 'drawing' ? (
              <View style={styles.revealDrawing}>
                <Drawing height={130} strokes={entry.strokes} width={250} />
              </View>
            ) : (
              <Text style={styles.revealText}>“{entry.text}”</Text>
            )}
          </View>
        ))}
        <Pressable
          onPress={() => void start()}
          style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
          <Text style={styles.primaryLabel}>Play again</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.turnHeader}>
        <View>
          <Text style={styles.title}>
            {isMyTurn ? 'Your turn' : `${currentName}'s turn`}
          </Text>
          <Text style={styles.body}>
            {telephoneChain.mode === 'prompt'
              ? 'Write a short phrase to begin.'
              : telephoneChain.mode === 'draw'
                ? 'Draw the phrase without using words.'
                : 'Guess what the drawing represents.'}
          </Text>
        </View>
        <View style={styles.turnBadge}>
          <Text style={styles.turnBadgeText}>
            {telephoneChain.turnIndex + 1}/{telephoneChain.playerIds.length}
          </Text>
        </View>
      </View>

      {isMyTurn && telephoneChain.mode === 'draw' ? (
        <>
          <View style={styles.clue}>
            <Text style={styles.clueLabel}>DRAW THIS</Text>
            <Text style={styles.clueText}>
              {previousEntry && previousEntry.kind !== 'drawing'
                ? previousEntry.text
                : 'Mystery phrase'}
            </Text>
          </View>
          <View
            onLayout={(event) => setCanvasWidth(event.nativeEvent.layout.width)}
            style={styles.canvas}
            {...panResponder.panHandlers}>
            <Drawing
              height={CANVAS_HEIGHT}
              strokes={[...strokes, currentStroke]}
              width={canvasWidth}
            />
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
      ) : isMyTurn ? (
        <>
          {telephoneChain.mode === 'guess' &&
          previousEntry?.kind === 'drawing' ? (
            <View style={styles.guessDrawing}>
              <Drawing height={200} strokes={previousEntry.strokes} width={300} />
            </View>
          ) : null}
          <TextInput
            autoCapitalize="sentences"
            maxLength={80}
            onChangeText={setText}
            placeholder={
              telephoneChain.mode === 'prompt' ? 'A cat on the moon…' : 'Your guess…'
            }
            placeholderTextColor={signal.slate}
            style={styles.input}
            value={text}
          />
          <Pressable
            disabled={!text.trim()}
            onPress={() => void submit()}
            style={({ pressed }) => [
              styles.primary,
              pressed && styles.pressed,
              !text.trim() && styles.disabled,
            ]}>
            <Text style={styles.primaryLabel}>
              {telephoneChain.mode === 'prompt' ? 'Start chain' : 'Send guess'}
            </Text>
          </Pressable>
        </>
      ) : (
        <View style={styles.waiting}>
          <Text style={styles.waitingIcon}>•••</Text>
          <Text style={styles.waitingText}>Waiting for {currentName}</Text>
          <Text style={styles.waitingMeta}>Their answer stays hidden until the reveal.</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
  },
  title: { color: signal.ink, fontSize: 21, fontWeight: '800' },
  body: { color: signal.slate, fontSize: 14, lineHeight: 21, marginTop: 6 },
  primary: {
    alignItems: 'center',
    backgroundColor: signal.deep,
    borderRadius: 10,
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  primaryLabel: { color: signal.white, fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.35 },
  turnHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  turnBadge: {
    backgroundColor: signal.sky,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  turnBadgeText: { color: signal.ink, fontSize: 12, fontWeight: '800' },
  clue: {
    backgroundColor: signal.sky,
    borderRadius: 12,
    marginTop: 16,
    padding: 14,
  },
  clueLabel: { color: signal.slate, fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  clueText: { color: signal.ink, fontSize: 18, fontWeight: '700', marginTop: 4 },
  canvas: {
    backgroundColor: signal.paper,
    borderColor: signal.fog,
    borderRadius: 12,
    borderWidth: 1,
    height: CANVAS_HEIGHT,
    marginTop: 12,
    overflow: 'hidden',
    position: 'relative',
  },
  line: { borderRadius: 2, height: 4, position: 'absolute' },
  actions: { flexDirection: 'row', gap: 10 },
  secondary: {
    alignItems: 'center',
    borderColor: signal.blue,
    borderRadius: 10,
    borderWidth: 1.5,
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  secondaryLabel: { color: signal.blue, fontSize: 15, fontWeight: '700' },
  actionFlex: { flex: 1 },
  input: {
    backgroundColor: signal.paper,
    borderColor: signal.fog,
    borderRadius: 10,
    borderWidth: 1,
    color: signal.ink,
    fontSize: 17,
    marginTop: 18,
    padding: 14,
  },
  guessDrawing: {
    backgroundColor: signal.paper,
    borderRadius: 12,
    height: 200,
    marginTop: 16,
    overflow: 'hidden',
    position: 'relative',
  },
  waiting: {
    alignItems: 'center',
    backgroundColor: signal.paper,
    borderRadius: 12,
    marginTop: 18,
    padding: 30,
  },
  waitingIcon: { color: signal.deep, fontSize: 24, fontWeight: '800', letterSpacing: 4 },
  waitingText: { color: signal.ink, fontSize: 17, fontWeight: '700', marginTop: 8 },
  waitingMeta: { color: signal.slate, fontSize: 13, marginTop: 5, textAlign: 'center' },
  revealCard: {
    backgroundColor: signal.paper,
    borderRadius: 12,
    marginTop: 12,
    padding: 14,
  },
  revealLabel: { color: signal.slate, fontSize: 10, fontWeight: '800', letterSpacing: 0.7 },
  revealText: { color: signal.ink, fontSize: 18, fontWeight: '700', marginTop: 7 },
  revealDrawing: {
    height: 130,
    marginTop: 8,
    overflow: 'hidden',
    position: 'relative',
  },
});
