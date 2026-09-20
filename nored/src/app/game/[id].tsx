import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Alert,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ChessIcon, GamesIcon, PongIcon, TelephoneIcon } from '@/components/signal/icons';
import { Chip, MistButton, OutlinedButton } from '@/components/signal/ui';
import { mockGames } from '@/data/mock';
import { ChessBoard } from '@/games/ChessBoard';
import { useGames } from '@/games/GameContext';
import { DrawingTelephoneBoard as DrawingTelephoneGameBoard } from '@/games/DrawingTelephoneBoard';
import { MAX_STROKE_POINTS, type DrawingPoint } from '@/games/gameStore';
import { PongBoard } from '@/games/PongBoard';
import { useMeshUi } from '@/mesh/MeshUiContext';
import { signal } from '@/theme/signal';
import type { GameId } from '@/transport';

const DRAWING_COLORS = [signal.deep, signal.blue, signal.twilight, signal.mist];

const GAME_ICONS: Record<string, (props: { color: string; size: number }) => React.JSX.Element> = {
  chess: ChessIcon,
  pong: PongIcon,
  telephone: TelephoneIcon,
};

function PlayerAction({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.smallButton,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}>
      <Text style={styles.smallButtonLabel}>{label}</Text>
    </Pressable>
  );
}

function JoinGameButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.joinButton, pressed && styles.pressed]}>
      <Text style={styles.joinButtonLabel}>Join game</Text>
    </Pressable>
  );
}

export function MeshPingBoard() {
  const { identity } = useMeshUi();
  const {
    participants,
    pingResults,
    batonHolderId,
    pingPeer,
    passBaton,
  } = useGames();
  const players = participants['mesh-ping'].filter((item) => item.id !== identity.id);
  const holderName =
    batonHolderId === identity.id
      ? 'You'
      : participants['mesh-ping'].find((item) => item.id === batonHolderId)?.name;
  const canPass = !batonHolderId || batonHolderId === identity.id;

  const run = async (action: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    const result = await action();
    if (!result.ok) Alert.alert('Mesh Ping', result.error);
  };

  return (
    <View style={styles.board}>
      <View style={styles.boardHeading}>
        <View>
          <Text style={styles.boardTitle}>Live players</Text>
          <Text style={styles.boardBody}>
            {holderName ? `${holderName} holds the baton.` : 'The first pass starts the baton.'}
          </Text>
        </View>
      </View>
      {players.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Waiting for another joined phone nearby.</Text>
        </View>
      ) : (
        players.map((player) => {
          const result = pingResults[player.id];
          return (
            <View key={player.id} style={styles.playerRow}>
              <View style={styles.playerCopy}>
                <Text style={styles.playerName}>{player.name}</Text>
                <Text style={styles.playerMeta}>
                  {result ? `${result.rttMs} ms round trip · ${result.attempts} pings` : 'Not pinged yet'}
                </Text>
              </View>
              <View style={styles.rowActions}>
                <PlayerAction label="Ping" onPress={() => void run(() => pingPeer(player.id))} />
                <PlayerAction
                  label="Pass"
                  disabled={!canPass}
                  onPress={() => void run(() => passBaton(player.id))}
                />
              </View>
            </View>
          );
        })
      )}
    </View>
  );
}

function StrokeView({
  points,
  color,
  width,
  height,
}: {
  points: DrawingPoint[];
  color: string;
  width: number;
  height: number;
}) {
  return (
    <>
      {points.slice(1).map((point, index) => {
        const previous = points[index];
        const x1 = (previous.x / 100) * width;
        const y1 = (previous.y / 100) * height;
        const x2 = (point.x / 100) * width;
        const y2 = (point.y / 100) * height;
        const length = Math.hypot(x2 - x1, y2 - y1);
        const angle = Math.atan2(y2 - y1, x2 - x1);
        return (
          <View
            key={`${index}-${point.x}-${point.y}`}
            style={[
              styles.stroke,
              {
                backgroundColor: color,
                left: (x1 + x2 - length) / 2,
                top: (y1 + y2) / 2 - 2,
                transform: [{ rotate: `${angle}rad` }],
                width: length,
              },
            ]}
          />
        );
      })}
    </>
  );
}

export function DrawingTelephoneBoard({
  setScrollEnabled,
}: {
  setScrollEnabled: (enabled: boolean) => void;
}) {
  const { identity } = useMeshUi();
  const {
    participants,
    telephoneRound,
    startTelephoneRound,
    submitStroke,
  } = useGames();
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 220 });
  const [draft, setDraft] = useState<DrawingPoint[]>([]);
  const currentPlayerId = telephoneRound?.playerIds[telephoneRound.turnIndex];
  const isMyTurn = Boolean(telephoneRound && !telephoneRound.finished && currentPlayerId === identity.id);
  const currentName =
    currentPlayerId === identity.id
      ? 'You'
      : participants.telephone.find((player) => player.id === currentPlayerId)?.name ?? 'Nearby player';

  const drawingPoint = (x: number, y: number) => ({
      x: Math.max(0, Math.min(100, (x / canvasSize.width) * 100)),
      y: Math.max(0, Math.min(100, (y / canvasSize.height) * 100)),
  });

  const addPoint = (x: number, y: number) => {
    if (!isMyTurn) return;
    const point = drawingPoint(x, y);
    setDraft((current) => {
      if (current.length >= MAX_STROKE_POINTS) return current;
      const previous = current[current.length - 1];
      if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 2) {
        return current;
      }
      return [...current, point];
    });
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => isMyTurn,
        onMoveShouldSetPanResponder: () => isMyTurn,
        onPanResponderGrant: (event) => {
          setScrollEnabled(false);
          setDraft([
            drawingPoint(event.nativeEvent.locationX, event.nativeEvent.locationY),
          ]);
        },
        onPanResponderMove: (event) => {
          addPoint(event.nativeEvent.locationX, event.nativeEvent.locationY);
        },
        onPanResponderRelease: () => setScrollEnabled(true),
        onPanResponderTerminate: () => setScrollEnabled(true),
      }),
    // Canvas dimensions and turn ownership intentionally rebuild the responder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvasSize.height, canvasSize.width, isMyTurn],
  );

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setCanvasSize({ width: Math.max(1, width), height: Math.max(1, height) });
  };

  const begin = async () => {
    const result = await startTelephoneRound();
    if (!result.ok) Alert.alert('Drawing Telephone', result.error);
    else setDraft([]);
  };

  const send = async () => {
    const result = await submitStroke(draft);
    if (!result.ok) Alert.alert('Drawing Telephone', result.error);
    else setDraft([]);
  };

  return (
    <View style={styles.board}>
      <View style={styles.boardHeading}>
        <View style={styles.playerCopy}>
          <Text style={styles.boardTitle}>
            {!telephoneRound
              ? 'Ready for a round'
              : telephoneRound.finished
                ? 'Doodle complete'
                : `${currentName}'s turn`}
          </Text>
          <Text style={styles.boardBody}>
            {telephoneRound
              ? `${telephoneRound.strokes.length}/${telephoneRound.playerIds.length} turns drawn`
              : 'Waiting for nearby players'}
          </Text>
        </View>
        {telephoneRound ? (
          <Chip
            label={telephoneRound.finished ? 'Reveal' : `Turn ${telephoneRound.turnIndex + 1}`}
            tone={telephoneRound.finished ? 'blue' : 'sky'}
          />
        ) : null}
      </View>

      <View
        onLayout={handleLayout}
        style={styles.canvas}
        {...panResponder.panHandlers}>
        {telephoneRound?.strokes.map((stroke, index) => (
          <StrokeView
            key={stroke.id}
            color={DRAWING_COLORS[index % DRAWING_COLORS.length]}
            height={canvasSize.height}
            points={stroke.points}
            width={canvasSize.width}
          />
        ))}
        {draft.length > 0 ? (
          <StrokeView
            color={DRAWING_COLORS[(telephoneRound?.strokes.length ?? 0) % DRAWING_COLORS.length]}
            height={canvasSize.height}
            points={draft}
            width={canvasSize.width}
          />
        ) : null}
        {!telephoneRound ? <Text style={styles.canvasHint}>Start a round, then draw one line per turn.</Text> : null}
        {telephoneRound && !telephoneRound.finished && !isMyTurn ? (
          <Text style={styles.canvasHint}>Waiting for {currentName}…</Text>
        ) : null}
      </View>

      {!telephoneRound || telephoneRound.finished ? (
        <MistButton label={telephoneRound ? 'Play another round' : 'Start round'} onPress={() => void begin()} />
      ) : isMyTurn ? (
        <View style={styles.drawingActions}>
          <OutlinedButton
            label="Clear line"
            onPress={() => setDraft([])}
            style={styles.flexButton}
          />
          <View style={styles.flexButton}>
            <MistButton label="Send line" disabled={draft.length < 2} onPress={() => void send()} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

export default function GameScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useMemo(() => mockGames.find((item) => item.id === id), [id]);
  const supportedGameId: GameId | undefined =
    id === 'pong' || id === 'telephone' || id === 'chess' ? id : undefined;
  const { visibleNoredPeers } = useMeshUi();
  const { joinedGames, participants, joinGame, leaveGame, invitePlayer } = useGames();
  const [scrollEnabled, setScrollEnabled] = useState(true);
  const [showPlayers, setShowPlayers] = useState(false);
  const [invitedIds, setInvitedIds] = useState<string[]>([]);
  const joined = supportedGameId ? joinedGames[supportedGameId] : false;
  const joinedPlayerIds = new Set(
    supportedGameId
      ? participants[supportedGameId].map((participant) => participant.id)
      : [],
  );

  const join = async () => {
    if (!supportedGameId) return;
    const result = await joinGame(supportedGameId);
    if (!result.ok) Alert.alert(game?.name ?? 'Game', result.error);
  };

  const invite = async (peerId: string) => {
    if (!supportedGameId) return;
    const result = await invitePlayer(supportedGameId, peerId);
    if (!result.ok) Alert.alert('Could not invite player', result.error);
    else setInvitedIds((current) => [...new Set([...current, peerId])]);
  };

  const HeroIcon = GAME_ICONS[id ?? ''] ?? GamesIcon;

  return (
    <SafeAreaView edges={['bottom']} style={styles.safe}>
      <Stack.Screen options={{ title: game?.name ?? 'Game' }} />
      <ScrollView contentContainerStyle={styles.body} scrollEnabled={scrollEnabled}>
        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <HeroIcon color={signal.white} size={24} />
          </View>
          <Text style={styles.title}>{game?.name ?? 'Unknown game'}</Text>
          <View style={styles.chips}>
            <Chip label={game?.players ?? 'Nearby'} tone="amber" />
            <Chip label="Nearby Bluetooth" />
          </View>
        </View>

        {joined ? (
          <>
            <Pressable
              accessibilityRole="button"
              onPress={() => setShowPlayers((current) => !current)}
              style={({ pressed }) => [
                styles.addPlayersButton,
                pressed && styles.pressed,
              ]}>
              <View style={styles.addIcon}>
                <Text style={styles.addIconText}>+</Text>
              </View>
              <View style={styles.addPlayersCopy}>
                <Text style={styles.addPlayersTitle}>Add players</Text>
                <Text style={styles.addPlayersMeta}>Invite someone nearby over Bluetooth</Text>
              </View>
              <Text style={styles.addChevron}>{showPlayers ? '−' : '›'}</Text>
            </Pressable>
            {showPlayers ? (
              <View style={styles.invitePanel}>
                <Text style={styles.inviteHeading}>NEARBY PLAYERS</Text>
                {visibleNoredPeers.length === 0 ? (
                  <Text style={styles.inviteEmpty}>
                    No Nored players are visible yet. Keep both apps open and nearby.
                  </Text>
                ) : (
                  visibleNoredPeers.map((peer) => {
                    const alreadyJoined = joinedPlayerIds.has(peer.id);
                    const invited = invitedIds.includes(peer.id);
                    return (
                      <View key={peer.id} style={styles.inviteRow}>
                        <View style={styles.inviteAvatar}>
                          <Text style={styles.inviteAvatarText}>
                            {peer.name.trim().slice(0, 1).toUpperCase() || '?'}
                          </Text>
                        </View>
                        <View style={styles.playerCopy}>
                          <Text style={styles.playerName}>{peer.name}</Text>
                          <Text style={styles.playerMeta}>
                            {alreadyJoined
                              ? 'Already in this game'
                              : peer.pendingLoss
                                ? 'Out of range'
                                : 'Nearby on Bluetooth'}
                          </Text>
                        </View>
                        <PlayerAction
                          label={
                            alreadyJoined ? 'Joined' : peer.pendingLoss ? 'Away' : invited ? 'Sent' : 'Invite'
                          }
                          disabled={alreadyJoined || invited || peer.pendingLoss}
                          onPress={() => void invite(peer.id)}
                        />
                      </View>
                    );
                  })
                )}
              </View>
            ) : null}
          </>
        ) : null}

        {!joined ? (
          <View style={styles.board}>
            <View style={styles.statusDot} />
            <Text style={styles.boardTitle}>Not joined</Text>
            <Text style={styles.boardBody}>
              Every phone that wants to play must open this game and join.
            </Text>
          </View>
        ) : id === 'pong' ? (
          <PongBoard />
        ) : id === 'telephone' ? (
          <DrawingTelephoneGameBoard setScrollEnabled={setScrollEnabled} />
        ) : id === 'chess' ? (
          <ChessBoard />
        ) : (
          <View style={styles.board}>
            <Text style={styles.boardTitle}>Coming soon</Text>
            <Text style={styles.boardBody}>This game does not have a live packet protocol yet.</Text>
          </View>
        )}

        {joined ? (
          <OutlinedButton
            label="Leave room"
            onPress={() => supportedGameId && void leaveGame(supportedGameId)}
          />
        ) : (
          <JoinGameButton onPress={() => void join()} />
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
    backgroundColor: signal.blue,
    borderRadius: 12,
    height: 44,
    justifyContent: 'center',
    marginBottom: 14,
    width: 44,
  },
  title: { color: signal.ink, fontSize: 32, fontWeight: '800', lineHeight: 37 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  board: {
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
  },
  boardHeading: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  statusDot: {
    backgroundColor: signal.fog,
    borderRadius: 4,
    height: 8,
    marginBottom: 10,
    width: 8,
  },
  boardTitle: { color: signal.ink, fontSize: 20, fontWeight: '700' },
  boardBody: { color: signal.slate, fontSize: 16, lineHeight: 24, marginTop: 8 },
  empty: {
    backgroundColor: signal.paper,
    borderRadius: 12,
    marginTop: 18,
    padding: 18,
  },
  emptyText: { color: signal.slate, fontSize: 14, lineHeight: 20 },
  playerRow: {
    alignItems: 'center',
    borderTopColor: signal.fog,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginTop: 16,
    paddingTop: 16,
  },
  playerCopy: { flex: 1 },
  playerName: { color: signal.ink, fontSize: 16, fontWeight: '700' },
  playerMeta: { color: signal.slate, fontSize: 12, marginTop: 4 },
  rowActions: { flexDirection: 'row', gap: 6 },
  smallButton: {
    backgroundColor: signal.paper,
    borderColor: signal.fog,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  smallButtonLabel: { color: signal.blue, fontSize: 12, fontWeight: '700' },
  joinButton: {
    alignItems: 'center',
    backgroundColor: signal.deep,
    borderRadius: 10,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  joinButtonLabel: { color: signal.white, fontSize: 17, fontWeight: '700' },
  addPlayersButton: {
    alignItems: 'center',
    backgroundColor: signal.white,
    borderColor: signal.deep,
    borderRadius: 14,
    borderWidth: 1.5,
    flexDirection: 'row',
    padding: 14,
  },
  addIcon: {
    alignItems: 'center',
    backgroundColor: signal.deep,
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  addIconText: { color: signal.white, fontSize: 25, fontWeight: '500', lineHeight: 27 },
  addPlayersCopy: { flex: 1, marginLeft: 12 },
  addPlayersTitle: { color: signal.ink, fontSize: 16, fontWeight: '700' },
  addPlayersMeta: { color: signal.slate, fontSize: 12, marginTop: 2 },
  addChevron: { color: signal.deep, fontSize: 25, marginLeft: 8 },
  invitePanel: {
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
  },
  inviteHeading: {
    color: signal.slate,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.7,
    marginBottom: 4,
  },
  inviteEmpty: { color: signal.slate, fontSize: 14, lineHeight: 20, paddingVertical: 12 },
  inviteRow: {
    alignItems: 'center',
    borderTopColor: signal.fog,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
    paddingTop: 10,
  },
  inviteAvatar: {
    alignItems: 'center',
    backgroundColor: signal.sky,
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  inviteAvatarText: { color: signal.ink, fontSize: 15, fontWeight: '800' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.35 },
  canvas: {
    alignItems: 'center',
    backgroundColor: signal.paper,
    borderColor: signal.fog,
    borderRadius: 12,
    borderWidth: 1,
    height: 220,
    justifyContent: 'center',
    marginBottom: 16,
    marginTop: 18,
    overflow: 'hidden',
    position: 'relative',
  },
  canvasHint: {
    color: signal.slate,
    fontSize: 14,
    maxWidth: 220,
    textAlign: 'center',
  },
  stroke: {
    borderRadius: 2,
    height: 4,
    position: 'absolute',
  },
  drawingActions: { flexDirection: 'row', gap: 10 },
  flexButton: { flex: 1 },
});
