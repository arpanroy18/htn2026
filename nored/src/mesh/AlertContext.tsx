import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { ALERT_RATE_LIMIT_MS, makeAlertPacket, type AlertItem, type Severity } from './alertStore';
import { useRouterData, useRouterService } from './RouterContext';

type BroadcastResult = { ok: true } | { ok: false; error: string };
type AlertUi = {
  alerts: AlertItem[]; listening: boolean; setListening: (value: boolean) => void;
  broadcastAlert: (input: { body: string; severity: Severity; hasLocation?: boolean }) => Promise<BroadcastResult>;
};
const AlertContext = createContext<AlertUi | null>(null);
export function AlertProvider({ children }: { children: ReactNode }) {
  const router = useRouterService();
  const { alerts } = useRouterData();
  const [listening, updateListening] = useState(router.listening);
  const lastBroadcastAt = useRef(0);
  const setListening = useCallback((value: boolean) => { router.setListening(value); updateListening(value); }, [router]);
  const broadcastAlert = useCallback(async (input: { body: string; severity: Severity; hasLocation?: boolean }): Promise<BroadcastResult> => {
    const body = input.body.trim();
    if (!body || body.length > 280) return { ok: false, error: 'Use between 1 and 280 characters.' };
    if (Date.now() - lastBroadcastAt.current < ALERT_RATE_LIMIT_MS) return { ok: false, error: 'Wait a few seconds before broadcasting again.' };
    try {
      await router.enqueue(makeAlertPacket({ ...input, body, senderId: router.identity.id }));
      lastBroadcastAt.current = Date.now();
      return { ok: true };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Could not save alert.' }; }
  }, [router]);
  const value = useMemo(() => ({ alerts, listening, setListening, broadcastAlert }), [alerts, listening, setListening, broadcastAlert]);
  return <AlertContext.Provider value={value}>{children}</AlertContext.Provider>;
}
export function useAlerts() {
  const value = useContext(AlertContext);
  if (!value) throw new Error('useAlerts must be used inside AlertProvider');
  return value;
}
