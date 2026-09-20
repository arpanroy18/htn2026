import type { AlertPacket } from '@/transport';

import { createId, formatThreadTime } from './chatStore.ts';
import { ALERT_MAX_BODY, ALERT_RATE_LIMIT_MS, ALERT_TTL_HOPS, EMERGENCY_BROADCAST_ID } from './protocol.ts';

export { ALERT_MAX_BODY, ALERT_RATE_LIMIT_MS, ALERT_TTL_HOPS, EMERGENCY_BROADCAST_ID };

export type Severity = 'INFO' | 'HELP' | 'DANGER';

export type AlertItem = {
  id: string;
  senderId: string;
  sender: string;
  body: string;
  severity: Severity;
  timestamp: number;
  time: string;
  hops: number;
  pinned?: boolean;
  hasLocation?: boolean;
  mine?: boolean;
};

export function isAlertPinned(severity: Severity) {
  return severity === 'DANGER' || severity === 'HELP';
}

// One severity → UX table shared by the phone (notification, vibration, pin) and mirrored by
// the badge (LED colour, banner). INFO informs; HELP and DANGER interrupt.
export const severityPresentation: Record<Severity, {
  title: string; vibration: number[]; sound: boolean; urgent: boolean;
}> = {
  INFO: { title: 'Info alert', vibration: [], sound: false, urgent: false },
  HELP: { title: 'Help needed', vibration: [0, 250, 150, 250], sound: true, urgent: true },
  DANGER: { title: 'DANGER', vibration: [0, 400, 150, 400, 150, 400], sound: true, urgent: true },
};

export type SeverityTone = 'yellow' | 'orange' | 'red';

export function severityTone(severity: Severity): SeverityTone {
  if (severity === 'DANGER') return 'red';
  if (severity === 'HELP') return 'orange';
  return 'yellow';
}

export function makeAlertPacket(input: {
  id?: string;
  senderId: string;
  senderName?: string;
  body: string;
  severity: Severity;
  hasLocation?: boolean;
  hops?: number;
  ttlHops?: number;
}): AlertPacket {
  return {
    version: 1,
    id: input.id ?? createId(),
    senderId: input.senderId,
    senderName: input.senderName?.trim().slice(0, 40),
    recipientId: EMERGENCY_BROADCAST_ID,
    type: 'alert',
    timestamp: Date.now(),
    body: input.body.trim().slice(0, ALERT_MAX_BODY),
    severity: input.severity,
    hasLocation: input.hasLocation,
    hops: input.hops ?? 0,
    ttlHops: Math.min(ALERT_TTL_HOPS, input.ttlHops ?? ALERT_TTL_HOPS),
  };
}

export function alertFromPacket(
  packet: AlertPacket,
  senderName: string,
  mine: boolean,
): AlertItem {
  return {
    id: packet.id,
    senderId: packet.senderId,
    sender: mine ? 'You' : senderName,
    body: packet.body,
    severity: packet.severity,
    timestamp: packet.timestamp,
    time: formatThreadTime(packet.timestamp),
    hops: packet.hops ?? 0,
    pinned: isAlertPinned(packet.severity),
    hasLocation: packet.hasLocation,
    mine,
  };
}

export function appendAlert(alerts: AlertItem[], next: AlertItem): AlertItem[] {
  if (alerts.some((item) => item.id === next.id)) return alerts;
  return [next, ...alerts].slice(0, 200);
}

export function isAlertPacket(value: { type?: string; body?: unknown; severity?: unknown }): value is AlertPacket {
  return (
    value.type === 'alert' &&
    typeof value.body === 'string' &&
    (value.severity === 'INFO' || value.severity === 'HELP' || value.severity === 'DANGER')
  );
}
