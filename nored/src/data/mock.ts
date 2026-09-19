export type Severity = 'INFO' | 'HELP' | 'DANGER';

export type AlertItem = {
  id: string;
  sender: string;
  body: string;
  severity: Severity;
  time: string;
  hops: number;
  pinned?: boolean;
  hasLocation?: boolean;
};

export type GameCard = {
  id: string;
  name: string;
  blurb: string;
  players: string;
};

export const mockAlerts: AlertItem[] = [
  {
    id: 'a1',
    sender: 'Riley',
    body: 'Lost child, red jacket, last seen at Gate C. Relay if you have eyes.',
    severity: 'HELP',
    time: '1m',
    hops: 3,
    pinned: true,
    hasLocation: true,
  },
  {
    id: 'a2',
    sender: 'You',
    body: 'Power strip tripped in med tent. Using battery lanterns.',
    severity: 'INFO',
    time: '16m',
    hops: 1,
  },
  {
    id: 'a3',
    sender: 'Devon',
    body: 'Unstable crowd near the west stairs. Avoid until cleared.',
    severity: 'DANGER',
    time: '41m',
    hops: 4,
    hasLocation: true,
  },
];

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
