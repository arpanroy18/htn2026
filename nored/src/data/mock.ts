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
    id: 'trivia',
    name: 'Trivia Relay',
    blurb: 'Multiple-choice questions acknowledged hop by hop. Results catch up when peers rejoin.',
    players: 'Group or 1:1',
  },
  {
    id: 'telephone',
    name: 'Drawing Telephone',
    blurb: 'Each peer alters a tiny doodle. Compressed deltas only — one BLE frame per turn.',
    players: '3–8',
  },
  {
    id: 'word-chain',
    name: 'Word Chain',
    blurb: 'Add a word to a shared story. The mesh reconstructs the chain in order.',
    players: '2–8',
  },
  {
    id: 'beacon',
    name: 'Find the Beacon',
    blurb: 'One phone is “it.” Others hunt by RSSI hot/cold. Game and proximity test in one.',
    players: '3–6',
  },
];
