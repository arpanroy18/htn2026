import type { AlertPacket } from '@/transport';

import { createId, formatThreadTime } from './chatStore';

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

export const ALERT_RATE_LIMIT_MS = 5000;
export const ALERT_TTL_HOPS = 10;
export const EMERGENCY_BROADCAST_ID = 'emergency-broadcast';

export function isAlertPinned(severity: Severity) {
  return severity === 'DANGER' || severity === 'HELP';
}

export type SeverityTone = 'yellow' | 'orange' | 'red';

export function severityTone(severity: Severity): SeverityTone {
  if (severity === 'DANGER') return 'red';
  if (severity === 'HELP') return 'orange';
  return 'yellow';
}

export function makeAlertPacket(input: {
  id?: string;
  senderId: string;
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
    recipientId: EMERGENCY_BROADCAST_ID,
    type: 'alert',
    timestamp: Date.now(),
    body: input.body,
    severity: input.severity,
    hasLocation: input.hasLocation,
    hops: input.hops ?? 0,
    ttlHops: input.ttlHops ?? ALERT_TTL_HOPS,
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
