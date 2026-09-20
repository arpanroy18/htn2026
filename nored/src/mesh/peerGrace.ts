/** How long a confirmed peer stays visible/reachable in the UI after a brief BLE dropout. */
export const PEER_GRACE_MS = 20_000;

/**
 * How long the mesh router keeps a peer's session alive after the same dropout.
 * Kept strictly longer than PEER_GRACE_MS so that any peer still shown in the UI is
 * guaranteed to still have a routable session — otherwise a visibly "reconnecting" peer
 * could fail game invites / message sends because its session was already torn down.
 */
export const SESSION_GRACE_MS = PEER_GRACE_MS + 5_000;
