import { signal } from '@/theme/signal';
import type { DeviceIdentity, Peer } from '@/transport';

export const AVATAR_ICON_IDS = [
  'nearby',
  'chats',
  'alerts',
  'games',
  'gear',
  'mic',
  'image',
  'send',
] as const;

export type AvatarIconId = (typeof AVATAR_ICON_IDS)[number];

export const AVATAR_TONES = [
  { bg: signal.sky, fg: signal.ink },
  { bg: signal.mist, fg: signal.ink },
  { bg: signal.deep, fg: signal.white },
  { bg: signal.blue, fg: signal.white },
  { bg: signal.yellow, fg: signal.ink },
  { bg: signal.orange, fg: signal.white },
  { bg: '#c8e6c9', fg: signal.ink },
  { bg: '#f8bbd0', fg: signal.ink },
  { bg: signal.twilight, fg: signal.white },
] as const;

export type AvatarProfile = {
  icon: AvatarIconId;
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
  const icon = AVATAR_ICON_IDS[hash % AVATAR_ICON_IDS.length];
  const colorIndex = (hash * 31) % AVATAR_TONES.length;
  return { icon, colorIndex, tone: AVATAR_TONES[colorIndex] };
}

export function resolveAvatar(
  seed: string,
  icon?: string,
  colorIndex?: number,
): AvatarProfile {
  const fallback = avatarFromSeed(seed);
  const resolvedIcon = AVATAR_ICON_IDS.includes(icon as AvatarIconId)
    ? (icon as AvatarIconId)
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
