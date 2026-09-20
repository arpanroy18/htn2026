/** True when a peer's display name identifies a Nored badge (GAP or identity). */
export function isBadgePeer(name?: string | null) {
  const normalized = name?.trim().toLowerCase() ?? '';
  return normalized.startsWith('nored badge') || normalized.startsWith('nored-badge');
}
