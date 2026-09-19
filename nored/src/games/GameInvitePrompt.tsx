import { router } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { signal } from '@/theme/signal';

import { useGames } from './GameContext';

const gameNames = {
  'mesh-ping': 'Mesh Ping',
  pong: 'Bluetooth Pong',
  telephone: 'Drawing Telephone',
  chess: 'Bluetooth Chess',
} as const;

export function GameInvitePrompt() {
  const { pendingInvite, acceptInvite, dismissInvite } = useGames();
  const [accepting, setAccepting] = useState(false);

  const accept = async () => {
    if (!pendingInvite || accepting) return;
    const gameId = pendingInvite.gameId;
    setAccepting(true);
    const result = await acceptInvite();
    setAccepting(false);
    if (result.ok) {
      router.push({ pathname: '/game/[id]', params: { id: gameId } });
    }
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={dismissInvite}
      transparent
      visible={Boolean(pendingInvite)}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.icon}>
            <Text style={styles.iconText}>+</Text>
          </View>
          <Text style={styles.eyebrow}>BLUETOOTH GAME INVITE</Text>
          <Text style={styles.title}>{pendingInvite?.fromName} wants to play</Text>
          <Text style={styles.body}>
            Join {pendingInvite ? gameNames[pendingInvite.gameId] : 'this game'} with a nearby
            player. No internet is required.
          </Text>
          <Pressable
            disabled={accepting}
            onPress={() => void accept()}
            style={({ pressed }) => [
              styles.accept,
              pressed && styles.pressed,
              accepting && styles.disabled,
            ]}>
            <Text style={styles.acceptLabel}>{accepting ? 'Joining…' : 'Join game'}</Text>
          </Pressable>
          <Pressable onPress={dismissInvite} style={({ pressed }) => pressed && styles.pressed}>
            <Text style={styles.dismiss}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(27, 27, 27, 0.45)',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    alignItems: 'center',
    backgroundColor: signal.white,
    borderRadius: 20,
    maxWidth: 420,
    padding: 28,
    width: '100%',
  },
  icon: {
    alignItems: 'center',
    backgroundColor: signal.sky,
    borderRadius: 24,
    height: 48,
    justifyContent: 'center',
    marginBottom: 16,
    width: 48,
  },
  iconText: { color: signal.ink, fontSize: 30, fontWeight: '500', lineHeight: 32 },
  eyebrow: {
    color: signal.deep,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  title: {
    color: signal.ink,
    fontSize: 24,
    fontWeight: '800',
    marginTop: 8,
    textAlign: 'center',
  },
  body: {
    color: signal.slate,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 22,
    marginTop: 10,
    textAlign: 'center',
  },
  accept: {
    alignItems: 'center',
    backgroundColor: signal.deep,
    borderRadius: 10,
    paddingVertical: 13,
    width: '100%',
  },
  acceptLabel: { color: signal.white, fontSize: 16, fontWeight: '700' },
  dismiss: { color: signal.slate, fontSize: 15, marginTop: 16 },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },
});
