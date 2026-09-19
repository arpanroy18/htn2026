export type DeliveryStatus = 'sent' | 'relayed' | 'seen';
export type Severity = 'INFO' | 'HELP' | 'DANGER';
export type MessageKind = 'text' | 'audio' | 'image';
export type ThreadKind = 'dm' | 'group';

export type Thread = {
  id: string;
  kind: ThreadKind;
  name: string;
  preview: string;
  time: string;
  unread: number;
  queued?: boolean;
  outOfRange?: boolean;
  members?: number;
};

export type ChatMessage = {
  id: string;
  sender: string;
  mine: boolean;
  kind: MessageKind;
  body?: string;
  status?: DeliveryStatus;
  transcript?: string;
  translation?: string;
  transcriptUnavailable?: boolean;
  duration?: string;
  time: string;
};

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

export const mockThreads: Thread[] = [
  {
    id: 'g-ops',
    kind: 'group',
    name: 'Hallway Ops',
    preview: 'Maya: Water station is dry — looping west.',
    time: '2m',
    unread: 3,
    members: 6,
  },
  {
    id: 'dm-jordan',
    kind: 'dm',
    name: 'Jordan#a41c',
    preview: 'Queued voice note · waiting for range',
    time: '11m',
    unread: 1,
    queued: true,
    outOfRange: true,
  },
  {
    id: 'g-med',
    kind: 'group',
    name: 'Med Tent',
    preview: 'You: Image of the supply board',
    time: '28m',
    unread: 0,
    members: 4,
  },
  {
    id: 'dm-priya',
    kind: 'dm',
    name: 'Priya',
    preview: 'Seen · “On my way, 2 hops.”',
    time: '1h',
    unread: 0,
  },
];

export const mockMessages: Record<string, ChatMessage[]> = {
  'g-ops': [
    {
      id: '1',
      sender: 'Alex',
      mine: false,
      kind: 'text',
      body: 'Mesh is thin near the loading dock. Stay on this thread.',
      time: '12:04',
    },
    {
      id: '2',
      sender: 'You',
      mine: true,
      kind: 'text',
      body: 'Copy. I’ll relay anything from the south lawn.',
      status: 'seen',
      time: '12:05',
    },
    {
      id: '3',
      sender: 'Maya',
      mine: false,
      kind: 'audio',
      duration: '0:12',
      transcript: 'Water station is dry. Looping west to the spare tanks.',
      translation: 'La estación de agua está seca. Voy al oeste por los tanques.',
      time: '12:07',
    },
    {
      id: '4',
      sender: 'You',
      mine: true,
      kind: 'image',
      body: 'Map sketch · 142 KB',
      status: 'relayed',
      time: '12:08',
    },
  ],
  'dm-jordan': [
    {
      id: '1',
      sender: 'You',
      mine: true,
      kind: 'text',
      body: 'If you drop out I’ll queue this.',
      status: 'sent',
      time: '11:51',
    },
    {
      id: '2',
      sender: 'You',
      mine: true,
      kind: 'audio',
      duration: '0:08',
      transcriptUnavailable: true,
      status: 'sent',
      time: '11:52',
    },
  ],
  'g-med': [
    {
      id: '1',
      sender: 'Sam',
      mine: false,
      kind: 'text',
      body: 'Need gauze count before the next wave.',
      time: '11:30',
    },
    {
      id: '2',
      sender: 'You',
      mine: true,
      kind: 'image',
      body: 'Supply board · 96 KB',
      status: 'seen',
      time: '11:41',
    },
  ],
  'dm-priya': [
    {
      id: '1',
      sender: 'Priya',
      mine: false,
      kind: 'text',
      body: 'Two hops from you. Keep the app open.',
      time: '10:18',
    },
    {
      id: '2',
      sender: 'You',
      mine: true,
      kind: 'text',
      body: 'On my way, 2 hops.',
      status: 'seen',
      time: '10:19',
    },
  ],
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

export function threadById(id: string): Thread | undefined {
  return mockThreads.find((thread) => thread.id === id);
}

export function messagesFor(id: string): ChatMessage[] {
  return mockMessages[id] ?? [
    {
      id: 'empty',
      sender: 'Mesh',
      mine: false,
      kind: 'text',
      body: 'No messages yet. This thread is local-only until the mesh is wired in.',
      time: 'now',
    },
  ];
}
