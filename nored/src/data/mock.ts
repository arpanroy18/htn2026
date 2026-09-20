export type { AlertItem, Severity } from '@/mesh/alertStore';

export type GameCard = {
  id: string;
  name: string;
  blurb: string;
  players: string;
};

export const mockGames: GameCard[] = [
  {
    id: 'pong',
    name: 'Pong',
    blurb: 'Two paddles, one ball, and nearby head-to-head play without internet.',
    players: '2 players',
  },
  {
    id: 'telephone',
    name: 'Telephone',
    blurb: 'Start a secret phrase, then rotate every chain through drawings and guesses.',
    players: '3–8',
  },
  {
    id: 'chess',
    name: 'Chess',
    blurb: 'Standard chess with legal moves, checkmate, and direct turn synchronization.',
    players: '2 players',
  },
];
