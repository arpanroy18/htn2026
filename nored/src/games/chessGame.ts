import { Chess, type Color, type Square } from 'chess.js';

import type { ChessMatch } from './gameStore';

export const INITIAL_CHESS_FEN = new Chess().fen();

export function chessColorForPlayer(match: ChessMatch, playerId: string): Color | undefined {
  if (match.whiteId === playerId) return 'w';
  if (match.blackId === playerId) return 'b';
  return undefined;
}

export function legalTargets(fen: string, square: string) {
  try {
    const chess = new Chess(fen);
    return chess
      .moves({ square: square as Square, verbose: true })
      .map((move) => move.to);
  } catch {
    return [];
  }
}

export function applyChessMove(
  match: ChessMatch,
  move: { from: string; to: string; promotion?: string },
): ChessMatch | undefined {
  if (match.status !== 'playing') return undefined;
  try {
    const chess = new Chess(match.fen);
    const moved = chess.move({
      from: move.from as Square,
      to: move.to as Square,
      promotion: move.promotion ?? 'q',
    });
    if (!moved) return undefined;
    const next: ChessMatch = {
      ...match,
      fen: chess.fen(),
      lastMove: move,
    };
    if (chess.isCheckmate()) {
      next.status = 'checkmate';
      next.winnerId = moved.color === 'w' ? match.whiteId : match.blackId;
    } else if (chess.isDraw()) {
      next.status = 'draw';
    }
    return next;
  } catch {
    return undefined;
  }
}

export function playerCanMove(match: ChessMatch, playerId: string) {
  if (match.status !== 'playing') return false;
  const chess = new Chess(match.fen);
  return chessColorForPlayer(match, playerId) === chess.turn();
}

