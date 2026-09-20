import * as Notifications from 'expo-notifications';
import { Platform, Vibration } from 'react-native';

import { type AlertItem, severityPresentation } from './alertStore';

// Local-only (SPECS §2: no push server). One Android channel per severity so the OS applies
// the matching importance/vibration; iOS uses the handler below for foreground banners.
const CHANNELS = { INFO: 'alerts-info', HELP: 'alerts-help', DANGER: 'alerts-danger' } as const;
const native = Platform.OS === 'ios' || Platform.OS === 'android';
let prepared: Promise<boolean> | undefined;

export function prepareAlertNotifications(): Promise<boolean> {
  if (!native) return Promise.resolve(false);
  if (!prepared) prepared = (async () => {
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const urgent = notification.request.content.data?.urgent === true;
        return { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: urgent, shouldSetBadge: false };
      },
    });
    if (Platform.OS === 'android') {
      // Channels must exist before Android 13 will show the permission prompt.
      await Notifications.setNotificationChannelAsync(CHANNELS.INFO, {
        name: 'Info alerts', importance: Notifications.AndroidImportance.DEFAULT, vibrationPattern: null, sound: null,
      });
      await Notifications.setNotificationChannelAsync(CHANNELS.HELP, {
        name: 'Help alerts', importance: Notifications.AndroidImportance.HIGH, vibrationPattern: severityPresentation.HELP.vibration, bypassDnd: true,
      });
      await Notifications.setNotificationChannelAsync(CHANNELS.DANGER, {
        name: 'Danger alerts', importance: Notifications.AndroidImportance.MAX, vibrationPattern: severityPresentation.DANGER.vibration, bypassDnd: true,
      });
    }
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;
    const requested = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    return requested.granted;
  })().catch((error: unknown) => {
    console.warn('[ALERT] notifications unavailable', error instanceof Error ? error.message : error);
    return false;
  });
  return prepared;
}

export async function notifyIncomingAlert(item: AlertItem) {
  const ux = severityPresentation[item.severity];
  // Vibrate immediately and independently of the notification permission (bypasses mute).
  if (native && ux.vibration.length) Vibration.vibrate(ux.vibration);
  if (!(await prepareAlertNotifications())) return;
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: `alert-${item.id}`, // Same id twice (re-render, relay echo) replaces, never stacks.
      content: {
        title: `${ux.title} · ${item.sender}`,
        body: item.body,
        sound: ux.sound ? 'default' : false,
        data: { alertId: item.id, urgent: ux.urgent },
        ...(Platform.OS === 'android' ? { vibrate: ux.vibration, priority: ux.urgent ? 'max' : 'default' } : {}),
        ...(Platform.OS === 'ios' ? { interruptionLevel: ux.urgent ? 'timeSensitive' : 'active' } : {}),
      },
      // Immediate delivery; on Android the trigger carries the channel that sets importance.
      trigger: Platform.OS === 'android' ? { channelId: CHANNELS[item.severity] } : null,
    });
  } catch (error) {
    console.warn('[ALERT] could not present notification', error instanceof Error ? error.message : error);
  }
}
