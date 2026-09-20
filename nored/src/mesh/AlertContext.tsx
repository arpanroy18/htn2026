import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { notifyIncomingAlert, prepareAlertNotifications } from './alertNotifier';
import { ALERT_MAX_BODY, ALERT_RATE_LIMIT_MS, makeAlertPacket, type AlertItem, type Severity } from './alertStore';
import { useRouterData, useRouterService } from './RouterContext';

type BroadcastResult = { ok: true } | { ok: false; error: string };
type AlertUi = {
  alerts: AlertItem[];
  listening: boolean;
  unreadCount: number;
  /** Most recent alert from another phone that has not been dismissed from the in-app banner. */
  incoming: AlertItem | null;
  dismissIncoming: () => void;
  setListening: (value: boolean) => void;
  setAlertsFocused: (focused: boolean) => void;
  broadcastAlert: (input: {
    body: string;
    severity: Severity;
    hasLocation?: boolean;
  }) => Promise<BroadcastResult>;
};
const AlertContext = createContext<AlertUi | null>(null);
export function AlertProvider({ children }: { children: ReactNode }) {
  const router = useRouterService();
  const { alerts } = useRouterData();
  const [listening, updateListening] = useState(router.listening);
  const [readThrough, setReadThrough] = useState(() =>
    alerts.reduce((latest, alert) => Math.max(latest, alert.timestamp), 0),
  );
  const [incoming, setIncoming] = useState<AlertItem | null>(null);
  const lastBroadcastAt = useRef(0);
  // Alerts already in the inbox when the app opened are history, not news.
  const announced = useRef<Set<string> | null>(null);
  useEffect(() => { void prepareAlertNotifications(); }, []);
  useEffect(() => {
    if (!announced.current) { announced.current = new Set(alerts.map((alert) => alert.id)); return; }
    const fresh = alerts.filter((alert) => !alert.mine && !announced.current!.has(alert.id));
    if (!fresh.length) return;
    for (const alert of fresh) { announced.current.add(alert.id); void notifyIncomingAlert(alert); }
    setIncoming(fresh.reduce((latest, alert) => (alert.timestamp >= latest.timestamp ? alert : latest)));
  }, [alerts]);
  const dismissIncoming = useCallback(() => setIncoming(null), []);
  const setListening = useCallback((value: boolean) => { router.setListening(value); updateListening(value); }, [router]);
  const setAlertsFocused = useCallback((focused: boolean) => {
    if (focused) {
      setReadThrough(alerts.reduce((latest, alert) => Math.max(latest, alert.timestamp), 0));
      setIncoming(null);
    }
  }, [alerts]);
  const unreadCount = useMemo(
    () => alerts.filter((alert) => !alert.mine && alert.timestamp > readThrough).length,
    [alerts, readThrough],
  );
  const broadcastAlert = useCallback(async (input: { body: string; severity: Severity; hasLocation?: boolean }): Promise<BroadcastResult> => {
    const body = input.body.trim();
    if (!body || body.length > ALERT_MAX_BODY) return { ok: false, error: `Use between 1 and ${ALERT_MAX_BODY} characters.` };
    const wait = ALERT_RATE_LIMIT_MS - (Date.now() - lastBroadcastAt.current);
    if (wait > 0) return { ok: false, error: `Wait ${Math.ceil(wait / 1000)}s before broadcasting again.` };
    try {
      await router.enqueue(makeAlertPacket({ ...input, body, senderId: router.identity.id }));
      lastBroadcastAt.current = Date.now();
      return { ok: true };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Could not save alert.' }; }
  }, [router]);
  const value = useMemo(
    () => ({
      alerts,
      listening,
      unreadCount,
      incoming,
      dismissIncoming,
      setListening,
      setAlertsFocused,
      broadcastAlert,
    }),
    [alerts, broadcastAlert, dismissIncoming, incoming, listening, unreadCount, setAlertsFocused, setListening],
  );
  return <AlertContext.Provider value={value}>{children}</AlertContext.Provider>;
}
export function useAlerts() {
  const value = useContext(AlertContext);
  if (!value) throw new Error('useAlerts must be used inside AlertProvider');
  return value;
}
