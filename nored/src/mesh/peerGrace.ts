/** How long a non-Nored discovery stays visible after a brief BLE dropout. */
export const PEER_GRACE_MS = 20_000;

/**
 * How long the mesh router keeps a peer's session alive after the same dropout.
 * Confirmed Nored peers can remain visible as out of range after this expires, but all
 * actions use the live peer set (or check the session) before attempting a direct send.
 */
export const SESSION_GRACE_MS = PEER_GRACE_MS + 5_000;
