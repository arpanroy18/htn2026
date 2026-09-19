import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { meshTransport, type DeviceIdentity, type Peer, type TransportState } from '@/transport';

function hasDisplayName(peer: Peer) {
  const name = peer.name?.trim();
  if (!name) return false;
  return name.toLowerCase() !== 'unknown device';
}

function peersEqual(a: Peer, b: Peer) {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.nored === b.nored &&
    a.identityConfirmed === b.identityConfirmed &&
    a.rssi === b.rssi
  );
}

export function signalLabel(rssi?: number) {
  if (rssi === undefined) return 'Unknown';
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
  noredPeers: Peer[];
  otherPeers: Peer[];
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
  const lastLogAt = useRef(0);

  const upsertPeer = useCallback((peer: Peer) => {
    if (!peer.nored && !hasDisplayName(peer)) return;
    setPeers((current) => {
      const withoutReplaced = peer.replacesId
        ? current.filter((item) => item.id !== peer.replacesId && item.id !== peer.id)
        : current;
      const index = withoutReplaced.findIndex((item) => item.id === peer.id);
      if (index === -1) return [...withoutReplaced, peer];
      const merged = {
        ...withoutReplaced[index],
        name: peer.name,
        rssi: peer.rssi,
        lastSeen: peer.lastSeen,
        nored: withoutReplaced[index].nored || peer.nored,
        identityConfirmed:
          withoutReplaced[index].identityConfirmed || peer.identityConfirmed,
        replacesId: peer.replacesId ?? withoutReplaced[index].replacesId,
      };
      if (withoutReplaced === current && peersEqual(withoutReplaced[index], merged)) return current;
      const next = withoutReplaced.slice();
      next[index] = merged;
      return next;
    });
  }, []);

  useEffect(() => {
    const subscriptions = [
      meshTransport.onPeerDiscovered(upsertPeer),
      meshTransport.onPeerLost((peerId) =>
        setPeers((current) => current.filter((peer) => peer.id !== peerId)),
      ),
      meshTransport.onStateChanged(setState),
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
      .then((items) => setPeers(items.filter((peer) => peer.nored || hasDisplayName(peer))))
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Bluetooth failed to start.');
      });

    return () => {
      subscriptions.forEach((subscription) => subscription.remove());
      void meshTransport.stop();
    };
  }, [upsertPeer]);

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
    try {
      await meshTransport.stop();
      await meshTransport.start();
      const items = await meshTransport.getPeers();
      setPeers(items.filter((peer) => peer.nored || hasDisplayName(peer)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Rescan failed.');
    }
  }, []);

  const noredPeers = useMemo(() => {
    return peers
      .filter(
        (peer) =>
          peer.nored &&
          peer.identityConfirmed &&
          peer.id !== identity.id,
      )
      .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  }, [identity.id, peers]);

  const otherPeers = useMemo(() => {
    const noredNames = new Set(noredPeers.map((peer) => peer.name.trim().toLowerCase()));
    const noredIds = new Set(noredPeers.map((peer) => peer.id));
    return peers
      .filter(
        (peer) =>
          !peer.nored &&
          !noredIds.has(peer.id) &&
          !noredNames.has(peer.name.trim().toLowerCase()),
      )
      .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  }, [peers, noredPeers]);

  const value = useMemo(
    () => ({
      identity,
      draftName,
      setDraftName,
      saveName,
      saving,
      peers,
      noredPeers,
      otherPeers,
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
      otherPeers,
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
