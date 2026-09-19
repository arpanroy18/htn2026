import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { meshTransport, type AlertPacket, type Packet } from '@/transport';

import {
  ALERT_RATE_LIMIT_MS,
  alertFromPacket,
  appendAlert,
  isAlertPacket,
  makeAlertPacket,
  type AlertItem,
  type Severity,
} from './alertStore';
import { peerName } from './chatStore';
import { useMeshUi } from './MeshUiContext';

type BroadcastResult = { ok: true } | { ok: false; error: string };

type AlertUi = {
  alerts: AlertItem[];
  listening: boolean;
  setListening: (value: boolean) => void;
  broadcastAlert: (input: {
    body: string;
    severity: Severity;
    hasLocation?: boolean;
  }) => Promise<BroadcastResult>;
};

const AlertContext = createContext<AlertUi | null>(null);

export function AlertProvider({ children }: { children: ReactNode }) {
  const { identity, noredPeers, peers } = useMeshUi();
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [listening, setListening] = useState(true);
  const seenIds = useRef(new Set<string>());
  const lastBroadcastAt = useRef(0);
  const listeningRef = useRef(listening);
  const peersRef = useRef(peers);
  const noredPeersRef = useRef(noredPeers);

  useEffect(() => {
    listeningRef.current = listening;
  }, [listening]);

  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);

  useEffect(() => {
    noredPeersRef.current = noredPeers;
  }, [noredPeers]);

  const remember = useCallback((id: string) => {
    seenIds.current.add(id);
    if (seenIds.current.size > 500) {
      seenIds.current = new Set([...seenIds.current].slice(-250));
    }
  }, []);

  const relayAlert = useCallback(async (packet: AlertPacket, excludePeerId: string) => {
    const hops = (packet.hops ?? 0) + 1;
    if (hops > (packet.ttlHops ?? 10)) return;
    const relayed = makeAlertPacket({
      id: packet.id,
      senderId: packet.senderId,
      body: packet.body,
      severity: packet.severity,
      hasLocation: packet.hasLocation,
      hops,
      ttlHops: packet.ttlHops,
    });
    const targets = noredPeersRef.current.filter(
      (peer) =>
        peer.identityConfirmed &&
        peer.id !== excludePeerId &&
        peer.id !== identity.id,
    );
    await Promise.allSettled(
      targets.map((peer) =>
        meshTransport.sendPacket(peer.id, { ...relayed, recipientId: peer.id }),
      ),
    );
  }, [identity.id]);

  const ingestAlert = useCallback(
    (packet: AlertPacket, mine: boolean) => {
      if (seenIds.current.has(packet.id)) return;
      remember(packet.id);
      if (!mine && !listeningRef.current) return;
      const name = peerName(peersRef.current, packet.senderId, 'Nearby peer');
      const item = alertFromPacket(packet, name, mine);
      setAlerts((current) => appendAlert(current, item));
    },
    [remember],
  );

  useEffect(() => {
    const subscription = meshTransport.onPacketReceived((fromPeerId, packet: Packet) => {
      if (!isAlertPacket(packet)) return;
      if (packet.senderId === identity.id) return;
      if (seenIds.current.has(packet.id)) return;
      ingestAlert(packet, false);
      void relayAlert(packet, fromPeerId);
    });
    return () => subscription.remove();
  }, [identity.id, ingestAlert, relayAlert]);

  const broadcastAlert = useCallback(
    async (input: {
      body: string;
      severity: Severity;
      hasLocation?: boolean;
    }): Promise<BroadcastResult> => {
      const body = input.body.trim();
      if (!body) return { ok: false, error: 'Message cannot be empty.' };
      if (body.length > 280) return { ok: false, error: 'Message must be 280 characters or less.' };

      const now = Date.now();
      if (now - lastBroadcastAt.current < ALERT_RATE_LIMIT_MS) {
        const waitSeconds = Math.ceil((ALERT_RATE_LIMIT_MS - (now - lastBroadcastAt.current)) / 1000);
        return { ok: false, error: `Wait ${waitSeconds}s before broadcasting again.` };
      }

      const packet = makeAlertPacket({
        senderId: identity.id,
        body,
        severity: input.severity,
        hasLocation: input.hasLocation,
      });

      ingestAlert(packet, true);
      lastBroadcastAt.current = now;

      const targets = noredPeersRef.current.filter((peer) => peer.identityConfirmed);
      await Promise.allSettled(
        targets.map((peer) =>
          meshTransport.sendPacket(peer.id, { ...packet, recipientId: peer.id }),
        ),
      );

      return { ok: true };
    },
    [identity.id, ingestAlert],
  );

  const value = useMemo(
    () => ({
      alerts,
      listening,
      setListening,
      broadcastAlert,
    }),
    [alerts, broadcastAlert, listening],
  );

  return <AlertContext.Provider value={value}>{children}</AlertContext.Provider>;
}

export function useAlerts() {
  const value = useContext(AlertContext);
  if (!value) throw new Error('useAlerts must be used inside AlertProvider');
  return value;
}
