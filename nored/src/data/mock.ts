export type { AlertItem, Severity } from '@/mesh/alertStore';

export type GameCard = {
  id: string;
  name: string;
  blurb: string;
  players: string;
};

export const mockGames: GameCard[] = [
  {
    id: 'mesh-ping',
    name: 'Mesh Ping',
    blurb: 'Pass a baton around the mesh. Leaderboard of hops and round-trip time.',
    players: '2–8 nearby',
  },
  {
    id: 'telephone',
    name: 'Drawing Telephone',
    blurb: 'Each peer alters a tiny doodle. Compressed deltas only — one BLE frame per turn.',
    players: '3–8',
  },
];
