import type { DeviceIdentity, Peer } from '@/transport';

export const ANIMAL_FACE_IDS = [
  'dog',
  'cat',
  'lion',
  'monkey',
  'panda',
  'koala',
  'bear',
  'pig',
  'sheep',
  'frog',
] as const;

export type AnimalFaceId = (typeof ANIMAL_FACE_IDS)[number];

export const AVATAR_TONES = [
  { bg: '#cfe8ff' },
  { bg: '#ffe08a' },
  { bg: '#ffb199' },
  { bg: '#c8e6c9' },
  { bg: '#f8bbd0' },
  { bg: '#d9c9ff' },
  { bg: '#ffd6a5' },
  { bg: '#b8e0d2' },
] as const;

export type AvatarProfile = {
  icon: AnimalFaceId;
  colorIndex: number;
  tone: (typeof AVATAR_TONES)[number];
};

export function stableHash(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function avatarFromSeed(seed: string): AvatarProfile {
  const hash = stableHash(seed);
  const icon = ANIMAL_FACE_IDS[hash % ANIMAL_FACE_IDS.length];
  const colorIndex = (hash * 31) % AVATAR_TONES.length;
  return { icon, colorIndex, tone: AVATAR_TONES[colorIndex] };
}

export function resolveAvatar(
  seed: string,
  icon?: string,
  colorIndex?: number,
): AvatarProfile {
  const fallback = avatarFromSeed(seed);
  const resolvedIcon = ANIMAL_FACE_IDS.includes(icon as AnimalFaceId)
    ? (icon as AnimalFaceId)
    : fallback.icon;
  const resolvedColor =
    typeof colorIndex === 'number' && colorIndex >= 0 && colorIndex < AVATAR_TONES.length
      ? colorIndex
      : fallback.colorIndex;
  return {
    icon: resolvedIcon,
    colorIndex: resolvedColor,
    tone: AVATAR_TONES[resolvedColor],
  };
}

export function avatarForPeer(
  peerId: string,
  identity: DeviceIdentity,
  peers?: Peer[],
): AvatarProfile {
  if (peerId === identity.id) {
    return resolveAvatar(identity.id, identity.avatarIcon, identity.avatarColor);
  }
  const peer = peers?.find((item) => item.id === peerId);
  return resolveAvatar(peerId, peer?.avatarIcon, peer?.avatarColor);
}
