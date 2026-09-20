import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { PEER_GRACE_MS } from '@/mesh/peerGrace';
import { meshTransport, type DeviceIdentity, type Peer, type TransportState } from '@/transport';

function hasDisplayName(peer: Peer) {
  const name = peer.name?.trim();
  if (!name) return false;
  return name.toLowerCase() !== 'unknown device';
}

function rssiBucket(rssi?: number | null) {
  if (!isValidRssi(rssi)) return 0;
  if (rssi >= -60) return 3;
  if (rssi >= -75) return 2;
  return 1;
}

function stabilizeRssi(next?: number | null, previous?: number | null): number | undefined {
  if (!isValidRssi(next)) return isValidRssi(previous) ? previous : undefined;
  if (!isValidRssi(previous)) return next;
  const nextBucket = rssiBucket(next);
  const previousBucket = rssiBucket(previous);
  if (nextBucket === previousBucket) return previous;
  if (nextBucket > previousBucket) {
    if (nextBucket === 3 && next < -58) return previous;
    if (nextBucket === 2 && next < -73) return previous;
    return next;
  }
  if (previousBucket === 3 && next > -62) return previous;
  if (previousBucket === 2 && next > -77) return previous;
  return next;
}

function peersEqual(a: Peer, b: Peer) {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.nored === b.nored &&
    a.identityConfirmed === b.identityConfirmed &&
    a.pendingLoss === b.pendingLoss &&
    rssiBucket(a.rssi) === rssiBucket(b.rssi) &&
    a.avatarIcon === b.avatarIcon &&
    a.avatarColor === b.avatarColor
  );
}

function comparePeers(a: Peer, b: Peer, order: string[]) {
  const left = order.indexOf(a.id);
  const right = order.indexOf(b.id);
  const rankA = left === -1 ? Number.MAX_SAFE_INTEGER : left;
  const rankB = right === -1 ? Number.MAX_SAFE_INTEGER : right;
  if (rankA !== rankB) return rankA - rankB;
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

function rememberPeerOrder(order: string[], id: string, replacesId?: string) {
  if (replacesId && replacesId !== id) {
    const previous = order.indexOf(replacesId);
    const existing = order.indexOf(id);
    if (previous >= 0 && existing >= 0) {
      order.splice(previous, 1);
      return;
    }
    if (previous >= 0) {
      order[previous] = id;
      return;
    }
  }
  if (!order.includes(id)) order.push(id);
}

function nextPeerOrder(order: string[], id: string, replacesId?: string) {
  const next = order.slice();
  rememberPeerOrder(next, id, replacesId);
  if (next.length === order.length && next.every((value, index) => value === order[index])) return order;
  return next;
}

function orderFromPeers(peers: Peer[]) {
  const order: string[] = [];
  for (const peer of peers) rememberPeerOrder(order, peer.id, peer.replacesId);
  return order;
}

export function isValidRssi(rssi?: number | null): rssi is number {
  return typeof rssi === 'number' && Number.isFinite(rssi) && rssi !== 127 && rssi >= -127 && rssi <= 20;
}

export function signalLabel(rssi?: number | null) {
  if (!isValidRssi(rssi)) return 'Unknown';
  if (rssi >= -60) return 'Strong';
  if (rssi >= -75) return 'Medium';
  return 'Weak';
}

export function hopLabel(peer: Peer) {
  return peer.nored ? 'Direct' : 'Bluetooth';
}

type MeshUi = {
  identity: DeviceIdentity;
  draftName: string;
  setDraftName: (value: string) => void;
  saveName: () => Promise<void>;
  saving: boolean;
  peers: Peer[];
  /** Confirmed Nored peers in range — use for counts, messaging, and in-range checks. */
  noredPeers: Peer[];
  /** Confirmed Nored peers for Nearby list, including briefly reconnecting ones. */
  visibleNoredPeers: Peer[];
  otherPeers: Peer[];
  livePeerCount: number;
  state: TransportState;
  error?: string;
  logs: string[];
  rescan: () => Promise<void>;
};

const MeshUiContext = createContext<MeshUi | null>(null);

export function MeshUiProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<DeviceIdentity>(() => meshTransport.getIdentity());
  const [draftName, setDraftName] = useState(identity.name);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [state, setState] = useState<TransportState>('starting');
  const [error, setError] = useState<string>();
  const [logs, setLogs] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [peerOrder, setPeerOrder] = useState<string[]>([]);
  const lastLogAt = useRef(0);
  const removalTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const cancelScheduledRemoval = useCallback((peerId: string) => {
    const timer = removalTimers.current.get(peerId);
    if (!timer) return;
    clearTimeout(timer);
    removalTimers.current.delete(peerId);
  }, []);

  const scheduleRemoval = useCallback((peerId: string) => {
    if (removalTimers.current.has(peerId)) return;
    const timer = setTimeout(() => {
      removalTimers.current.delete(peerId);
      setPeers((current) => current.filter((peer) => peer.id !== peerId));
    }, PEER_GRACE_MS);
    removalTimers.current.set(peerId, timer);
  }, []);

  const upsertPeer = useCallback((peer: Peer) => {
    cancelScheduledRemoval(peer.id);
    if (!peer.nored && !hasDisplayName(peer)) return;
    setPeerOrder((order) => nextPeerOrder(order, peer.id, peer.replacesId));
    setPeers((current) => {
      const replaced = peer.replacesId
        ? current.find((item) => item.id === peer.replacesId)
        : undefined;
      const withoutReplaced = peer.replacesId
        ? current.filter((item) => item.id !== peer.replacesId && item.id !== peer.id)
        : current;
      const index = withoutReplaced.findIndex((item) => item.id === peer.id);
      const previousRssi = index === -1 ? replaced?.rssi : withoutReplaced[index].rssi;
      const rssi = stabilizeRssi(peer.rssi, previousRssi);
      if (index === -1) return [...withoutReplaced, { ...peer, rssi, pendingLoss: false }];
      const merged = {
        ...withoutReplaced[index],
        name:
          withoutReplaced[index].identityConfirmed && !peer.identityConfirmed
            ? withoutReplaced[index].name
            : peer.name,
        rssi,
        lastSeen: peer.lastSeen,
        nored: withoutReplaced[index].nored || peer.nored,
        identityConfirmed:
          withoutReplaced[index].identityConfirmed || peer.identityConfirmed,
        avatarIcon: peer.avatarIcon ?? withoutReplaced[index].avatarIcon,
        avatarColor: peer.avatarColor ?? withoutReplaced[index].avatarColor,
        replacesId: peer.replacesId ?? withoutReplaced[index].replacesId,
        pendingLoss: false,
      };
      if (withoutReplaced === current && peersEqual(withoutReplaced[index], merged)) return current;
      const next = withoutReplaced.slice();
      next[index] = merged;
      return next;
    });
  }, [cancelScheduledRemoval]);

  useEffect(() => {
    const subscriptions = [
      meshTransport.onPeerDiscovered(upsertPeer),
      meshTransport.onPeerLost((peerId) => {
        setPeers((current) => {
          const index = current.findIndex((peer) => peer.id === peerId);
          if (index === -1) return current;
          const peer = current[index];
          const canGrace =
            (peer.nored && peer.identityConfirmed) || (!peer.nored && hasDisplayName(peer));
          if (!canGrace) {
            cancelScheduledRemoval(peerId);
            return current.filter((item) => item.id !== peerId);
          }
          if (peer.pendingLoss) return current;
          scheduleRemoval(peerId);
          const next = current.slice();
          next[index] = { ...peer, pendingLoss: true };
          return next;
        });
      }),
      meshTransport.onStateChanged((next) => {
        setState(next);
        if (next === 'poweredOff' || next === 'stopped' || next === 'unauthorized') {
          removalTimers.current.forEach((timer) => clearTimeout(timer));
          removalTimers.current.clear();
          setPeerOrder([]);
          setPeers([]);
        }
      }),
      meshTransport.onLog((message) => {
        const now = Date.now();
        if (now - lastLogAt.current < 1500) return;
        lastLogAt.current = now;
        setLogs((current) => [message, ...current].slice(0, 3));
      }),
    ];

    meshTransport
      .start()
      .then(() => meshTransport.getPeers())
      .then((items) => {
        const visible = items.filter((peer) => peer.nored || hasDisplayName(peer));
        setPeerOrder(orderFromPeers(visible));
        setPeers(visible);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Bluetooth failed to start.');
      });

    return () => {
      subscriptions.forEach((subscription) => subscription.remove());
      removalTimers.current.forEach((timer) => clearTimeout(timer));
      removalTimers.current.clear();
      void meshTransport.stop();
    };
  }, [cancelScheduledRemoval, scheduleRemoval, upsertPeer]);

  const saveName = useCallback(async () => {
    setSaving(true);
    setError(undefined);
    try {
      const nextIdentity = await meshTransport.setDisplayName(draftName);
      setIdentity(nextIdentity);
      setDraftName(nextIdentity.name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the name.');
    } finally {
      setSaving(false);
    }
  }, [draftName]);

  const rescan = useCallback(async () => {
    setError(undefined);
    removalTimers.current.forEach((timer) => clearTimeout(timer));
    removalTimers.current.clear();
    try {
      await meshTransport.stop();
      await meshTransport.start();
      const items = await meshTransport.getPeers();
      const visible = items.filter((peer) => peer.nored || hasDisplayName(peer));
      setPeerOrder(orderFromPeers(visible));
      setPeers(visible);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Rescan failed.');
    }
  }, []);

  const visibleNoredPeers = useMemo(() => {
    return peers
      .filter(
        (peer) =>
          peer.nored &&
          peer.identityConfirmed &&
          peer.id !== identity.id,
      )
      .sort((a, b) => comparePeers(a, b, peerOrder));
  }, [identity.id, peerOrder, peers]);

  const noredPeers = useMemo(() => {
    return visibleNoredPeers.filter((peer) => !peer.pendingLoss);
  }, [visibleNoredPeers]);

  const otherPeers = useMemo(() => {
    const noredNames = new Set(visibleNoredPeers.map((peer) => peer.name.trim().toLowerCase()));
    const noredIds = new Set(visibleNoredPeers.map((peer) => peer.id));
    return peers
      .filter(
        (peer) =>
          !peer.nored &&
          !noredIds.has(peer.id) &&
          !noredNames.has(peer.name.trim().toLowerCase()),
      )
      .sort((a, b) => comparePeers(a, b, peerOrder));
  }, [peerOrder, peers, visibleNoredPeers]);

  const liveOtherPeers = useMemo(() => {
    return otherPeers.filter((peer) => !peer.pendingLoss);
  }, [otherPeers]);

  const value = useMemo(
    () => ({
      identity,
      draftName,
      setDraftName,
      saveName,
      saving,
      peers,
      noredPeers,
      visibleNoredPeers,
      otherPeers,
      livePeerCount: noredPeers.length + liveOtherPeers.length,
      state,
      error,
      logs,
      rescan,
    }),
    [
      identity,
      draftName,
      saveName,
      saving,
      peers,
      noredPeers,
      visibleNoredPeers,
      otherPeers,
      liveOtherPeers.length,
      state,
      error,
      logs,
      rescan,
    ],
  );

  return <MeshUiContext.Provider value={value}>{children}</MeshUiContext.Provider>;
}

export function useMeshUi() {
  const value = useContext(MeshUiContext);
  if (!value) throw new Error('useMeshUi must be used inside MeshUiProvider');
  return value;
}

export function statusCopy(state: TransportState) {
  switch (state) {
    case 'running':
      return 'Looking nearby';
    case 'starting':
      return 'Starting Bluetooth';
    case 'poweredOff':
      return 'Turn Bluetooth on';
    case 'unauthorized':
      return 'Bluetooth permission needed';
    case 'unsupported':
      return 'BLE unavailable';
    case 'stopped':
      return 'Stopped';
    default:
      return 'Checking Bluetooth';
  }
}
