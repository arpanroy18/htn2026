import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OutlinedButton, RowPress } from '@/components/signal/ui';
import { prepareAlertNotifications } from '@/mesh/alertNotifier';
import { signal } from '@/theme/signal';

const items = [
  {
    id: 'bluetooth',
    title: 'Bluetooth',
    body: 'Advertise and scan so nearby phones can form a mesh without Wi-Fi or cell.',
  },
  {
    id: 'mic',
    title: 'Microphone',
    body: 'Record voice notes in the composer. Audio never leaves the device except as a message you send.',
  },
  {
    id: 'photos',
    title: 'Photos',
    body: 'Pick an image. It will be compressed later before it is chunked over BLE.',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    body: 'Local banners for emergency broadcasts. There is no push server.',
  },
];

export default function OnboardingScreen() {
  const [allowed, setAllowed] = useState<Record<string, boolean>>({});
  const toggle = async (id: string, on: boolean) => {
    if (id === 'notifications' && !on) {
      const granted = await prepareAlertNotifications();
      setAllowed((current) => ({ ...current, [id]: granted }));
      return;
    }
    setAllowed((current) => ({ ...current, [id]: !on }));
  };

  return (
    <SafeAreaView edges={['bottom']} style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>Stay reachable offline</Text>
        <Text style={styles.lede}>
          Nored talks over Bluetooth only. Grant these on this phone so Nearby, voice, images, and alerts can light up when they are implemented.
        </Text>
        {items.map((item) => {
          const on = !!allowed[item.id];
          return (
            <View key={item.id} style={styles.card}>
              <Text style={styles.name}>{item.title}</Text>
              <Text style={styles.bodyText}>{item.body}</Text>
              <RowPress onPress={() => void toggle(item.id, on)} style={styles.allow}>
                <Text style={styles.allowText}>{on ? 'Marked allowed' : 'Allow'}</Text>
              </RowPress>
            </View>
          );
        })}
        <OutlinedButton label="Continue" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { backgroundColor: signal.paper, flex: 1 },
  body: { gap: 14, padding: 24 },
  title: { color: signal.ink, fontSize: 40, fontWeight: '800', lineHeight: 46 },
  lede: { color: signal.slate, fontSize: 16, lineHeight: 24, maxWidth: 480 },
  card: {
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 16,
    borderWidth: 1,
    gap: 8,
    padding: 24,
  },
  name: { color: signal.ink, fontSize: 20, fontWeight: '600' },
  bodyText: { color: signal.slate, fontSize: 16, lineHeight: 24 },
  allow: {
    alignSelf: 'flex-start',
    borderColor: signal.blue,
    borderRadius: 8,
    borderWidth: 1.5,
    marginTop: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  allowText: { color: signal.blue, fontSize: 16, fontWeight: '600' },
});
