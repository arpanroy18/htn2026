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
    name: 'Bluetooth Pong',
    blurb: 'Two paddles, one ball, and nearby head-to-head play without internet.',
    players: '2 players',
  },
  {
    id: 'telephone',
    name: 'Drawing Telephone',
    blurb: 'Each peer alters a tiny doodle. Compressed deltas only — one BLE frame per turn.',
    players: '3–8',
  },
  {
    id: 'chess',
    name: 'Bluetooth Chess',
    blurb: 'Standard chess with legal moves, checkmate, and direct turn synchronization.',
    players: '2 players',
  },
];
