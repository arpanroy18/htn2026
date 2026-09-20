import type { Peer } from '../transport/MeshTransport';
import type { Contact } from './routerStore';

export type PeerLabelContext = {
  selfId: string;
  peers?: Peer[];
  contacts?: Record<string, Contact>;
  /** Screen-specific names tried before giving up, e.g. a message sender or thread title. */
  fallbacks?: (string | undefined | null)[];
};

/**
 * Resolve a display name for any device id, including relay hops we have never met.
 * Live peer names win over saved contacts because an advertised name is the fresher one.
 */
export function peerLabel(id: string, context: PeerLabelContext): string {
  if (id === context.selfId) return 'You';
  const peer = context.peers?.find((item) => item.id === id);
  if (peer?.name) return peer.name;
  const contact = context.contacts?.[id];
  if (contact?.name) return contact.name;
  for (const fallback of context.fallbacks ?? []) if (fallback) return fallback;
  return `Peer ${id.slice(0, 8)}`;
}
