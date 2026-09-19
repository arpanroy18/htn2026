import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import { useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { useMeshUi } from '@/mesh/MeshUiContext';
import { signal } from '@/theme/signal';

import { chessColorForPlayer, legalTargets, playerCanMove } from './chessGame';
import { useGames } from './GameContext';

const PIECES: Record<Color, Record<PieceSymbol, string>> = {
  w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
  b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
};

function squaresFor(color: Color) {
  const files = color === 'w' ? 'abcdefgh' : 'hgfedcba';
  const ranks = color === 'w' ? '87654321' : '12345678';
  return [...ranks].flatMap((rank) => [...files].map((file) => `${file}${rank}` as Square));
}

export function ChessBoard() {
  const { identity } = useMeshUi();
  const { participants, chessMatch, startChess, moveChess, resignChess } = useGames();
  const [selected, setSelected] = useState<string>();
  const [boardWidth, setBoardWidth] = useState(320);
  const chess = useMemo(() => new Chess(chessMatch?.fen), [chessMatch?.fen]);
  const myColor = chessMatch
    ? chessColorForPlayer(chessMatch, identity.id) ?? 'w'
    : 'w';
  const squares = useMemo(() => squaresFor(myColor), [myColor]);
  const targets = selected && chessMatch ? legalTargets(chessMatch.fen, selected) : [];
  const myTurn = Boolean(chessMatch && playerCanMove(chessMatch, identity.id));

  const run = async (
    action: () => Promise<{ ok: true } | { ok: false; error: string }>,
  ) => {
    const result = await action();
    if (!result.ok) Alert.alert('Bluetooth Chess', result.error);
    return result.ok;
  };

  const chooseSquare = (square: Square) => {
    if (!chessMatch || !myTurn) return;
    const piece = chess.get(square);
    if (selected && targets.includes(square)) {
      const movingPiece = chess.get(selected as Square);
      const promotes =
        movingPiece?.type === 'p' && (square.endsWith('1') || square.endsWith('8'));
      const finish = async (promotion = 'q') => {
        if (await run(() => moveChess(selected, square, promotion))) {
          setSelected(undefined);
        }
      };
      if (promotes) {
        Alert.alert('Promote pawn', 'Choose a piece.', [
          { text: 'Queen', onPress: () => void finish('q') },
          { text: 'Rook', onPress: () => void finish('r') },
          { text: 'Bishop', onPress: () => void finish('b') },
          { text: 'Knight', onPress: () => void finish('n') },
        ]);
      } else {
        void finish();
      }
      return;
    }
    if (piece?.color === myColor) setSelected(square);
    else setSelected(undefined);
  };

  const start = async () => {
    if (await run(startChess)) setSelected(undefined);
  };

  const status = (() => {
    if (!chessMatch) return `${participants.chess.length} players joined`;
    if (chessMatch.status === 'checkmate') {
      return chessMatch.winnerId === identity.id ? 'Checkmate — you win' : 'Checkmate — you lose';
    }
    if (chessMatch.status === 'draw') return 'Draw';
    if (chessMatch.status === 'resigned') {
      return chessMatch.winnerId === identity.id ? 'Opponent resigned — you win' : 'You resigned';
    }
    if (chess.inCheck()) return myTurn ? 'Your king is in check' : 'Opponent is in check';
    return myTurn ? 'Your move' : "Opponent's move";
  })();

  const opponentId = chessMatch
    ? chessMatch.whiteId === identity.id
      ? chessMatch.blackId
      : chessMatch.whiteId
    : undefined;
  const opponentName =
    participants.chess.find((player) => player.id === opponentId)?.name ?? 'Nearby opponent';

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>{status}</Text>
          <Text style={styles.subtitle}>
            {chessMatch
              ? `You are ${myColor === 'w' ? 'White' : 'Black'} · ${opponentName}`
              : 'Invite one nearby player, then start.'}
          </Text>
        </View>
        {chessMatch?.status === 'playing' ? (
          <View style={[styles.colorDot, myColor === 'b' && styles.colorDotBlack]} />
        ) : null}
      </View>

      <View
        onLayout={(event) => setBoardWidth(event.nativeEvent.layout.width)}
        style={styles.board}>
        {squares.map((square, index) => {
          const piece = chess.get(square);
          const file = square.charCodeAt(0) - 97;
          const rank = Number(square[1]);
          const dark = (file + rank) % 2 === 1;
          const isSelected = selected === square;
          const isTarget = targets.includes(square);
          const isLastMove =
            chessMatch?.lastMove?.from === square || chessMatch?.lastMove?.to === square;
          return (
            <Pressable
              key={square}
              accessibilityLabel={`${square}${piece ? ` ${piece.color === 'w' ? 'white' : 'black'} ${piece.type}` : ''}`}
              onPress={() => chooseSquare(square)}
              style={[
                styles.square,
                {
                  backgroundColor: dark ? '#91a7d8' : '#eaf0fc',
                  height: boardWidth / 8,
                  width: boardWidth / 8,
                },
                isLastMove && styles.lastMove,
                isSelected && styles.selected,
              ]}>
              {piece ? (
                <Text style={[styles.piece, { fontSize: boardWidth / 11 }]}>
                  {PIECES[piece.color][piece.type]}
                </Text>
              ) : null}
              {isTarget ? <View style={styles.target} /> : null}
              {index >= 56 ? <Text style={styles.fileLabel}>{square[0]}</Text> : null}
            </Pressable>
          );
        })}
      </View>

      {!chessMatch || chessMatch.status !== 'playing' ? (
        <Pressable
          onPress={() => void start()}
          style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
          <Text style={styles.primaryLabel}>{chessMatch ? 'New match' : 'Start match'}</Text>
        </Pressable>
      ) : (
        <Pressable
          onPress={() =>
            Alert.alert('Resign match?', 'Your opponent will win.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Resign', style: 'destructive', onPress: () => void run(resignChess) },
            ])
          }
          style={({ pressed }) => [styles.resign, pressed && styles.pressed]}>
          <Text style={styles.resignLabel}>Resign</Text>
        </Pressable>
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
    padding: 16,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  title: { color: signal.ink, fontSize: 20, fontWeight: '800' },
  subtitle: { color: signal.slate, fontSize: 13, marginTop: 4 },
  colorDot: {
    backgroundColor: signal.white,
    borderColor: signal.ink,
    borderRadius: 14,
    borderWidth: 2,
    height: 28,
    width: 28,
  },
  colorDotBlack: { backgroundColor: signal.ink },
  board: {
    alignSelf: 'center',
    aspectRatio: 1,
    borderColor: signal.twilight,
    borderRadius: 4,
    borderWidth: 2,
    flexDirection: 'row',
    flexWrap: 'wrap',
    overflow: 'hidden',
    width: '100%',
  },
  square: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  piece: { color: signal.ink, lineHeight: 45 },
  selected: { borderColor: signal.deep, borderWidth: 3 },
  lastMove: { backgroundColor: '#f4dc78' },
  target: {
    backgroundColor: 'rgba(41,66,255,0.45)',
    borderRadius: 8,
    height: 16,
    position: 'absolute',
    width: 16,
  },
  fileLabel: {
    bottom: 1,
    color: signal.slate,
    fontSize: 8,
    fontWeight: '700',
    position: 'absolute',
    right: 2,
  },
  primary: {
    alignItems: 'center',
    backgroundColor: signal.deep,
    borderRadius: 10,
    marginTop: 14,
    paddingVertical: 13,
  },
  primaryLabel: { color: signal.white, fontSize: 16, fontWeight: '700' },
  resign: {
    alignItems: 'center',
    borderColor: signal.fog,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 14,
    paddingVertical: 12,
  },
  resignLabel: { color: signal.slate, fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.7 },
});
