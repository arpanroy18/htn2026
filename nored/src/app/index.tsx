import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { meshTransport, type DeviceIdentity, type Peer, type TransportState } from '@/transport';

const colors = {
  ink: '#171A1F',
  muted: '#737984',
  paper: '#F4F1EA',
  card: '#FFFFFF',
  red: '#E4472F',
  green: '#35A56B',
  line: '#E1DDD4',
};

function signalLabel(rssi?: number) {
  if (rssi === undefined) return 'Signal unknown';
  if (rssi >= -60) return 'Strong signal';
  if (rssi >= -75) return 'Medium signal';
  return 'Weak signal';
}

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
    signalLabel(a.rssi) === signalLabel(b.rssi)
  );
}

function statusCopy(state: TransportState) {
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

const PeerRow = memo(function PeerRow({ peer }: { peer: Peer }) {
  return (
    <View style={styles.peerCard}>
      <View style={[styles.peerIndicator, peer.nored && styles.peerIndicatorNored]} />
      <View style={styles.peerMain}>
        <Text style={styles.peerName}>{peer.name}</Text>
        <Text style={styles.peerId}>{peer.nored ? 'NORED' : 'ID'} {peer.id.slice(0, 8)}</Text>
      </View>
      <View style={styles.peerMeta}>
        <Text style={styles.signal}>{signalLabel(peer.rssi)}</Text>
        <Text style={styles.seen}>In range</Text>
      </View>
    </View>
  );
});

export default function NearbyScreen() {
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

  const saveName = async () => {
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
  };

  const shortId = useMemo(() => identity.id.slice(0, 8), [identity.id]);
  const noredPeers = useMemo(() => {
    const latestByName = new Map<string, Peer>();
    for (const peer of peers) {
      if (!peer.nored) continue;
      const key = peer.name.trim().toLowerCase();
      const existing = latestByName.get(key);
      if (!existing || peer.lastSeen >= existing.lastSeen) {
        latestByName.set(key, peer);
      }
    }
    return [...latestByName.values()];
  }, [peers]);
  const otherPeers = useMemo(() => {
    const noredNames = new Set(noredPeers.map((peer) => peer.name.trim().toLowerCase()));
    const noredIds = new Set(noredPeers.map((peer) => peer.id));
    return peers.filter(
      (peer) =>
        !peer.nored &&
        !noredIds.has(peer.id) &&
        !noredNames.has(peer.name.trim().toLowerCase()),
    );
  }, [peers, noredPeers]);

  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <View>
            <Text style={styles.wordmark}>NORED</Text>
            <Text style={styles.eyebrow}>OFFLINE MESH</Text>
          </View>
          <View style={[styles.statusDot, state !== 'running' && styles.statusDotWaiting]} />
        </View>

        <View style={styles.identityCard}>
          <Text style={styles.label}>THIS PHONE</Text>
          <View style={styles.nameRow}>
            <TextInput
              accessibilityLabel="Your nearby display name"
              autoCapitalize="words"
              maxLength={40}
              onChangeText={setDraftName}
              onSubmitEditing={saveName}
              returnKeyType="done"
              style={styles.nameInput}
              value={draftName}
            />
            <Pressable
              accessibilityRole="button"
              disabled={saving || !draftName.trim() || draftName.trim() === identity.name}
              onPress={saveName}
              style={({ pressed }) => [styles.saveButton, pressed && styles.pressed]}>
              <Text style={styles.saveButtonText}>{saving ? '…' : 'SAVE'}</Text>
            </Pressable>
          </View>
          <Text style={styles.deviceId}>ID {shortId}</Text>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Nearby</Text>
          <View style={styles.scanning}>
            {state === 'running' && <ActivityIndicator color={colors.red} size="small" />}
            <Text style={styles.scanningText}>{statusCopy(state)}</Text>
          </View>
        </View>

        {error && <Text style={styles.error}>{error}</Text>}

        <ScrollView contentContainerStyle={styles.lists} showsVerticalScrollIndicator={false}>
          <Text style={styles.groupLabel}>NORED USERS · {noredPeers.length}</Text>
          {noredPeers.length === 0 ? (
            <Text style={styles.groupEmpty}>No other Nored phones in range yet. Keep this app open so you stay visible.</Text>
          ) : (
            noredPeers.map((peer) => <PeerRow key={peer.id} peer={peer} />)
          )}

          <Text style={[styles.groupLabel, styles.groupLabelSpaced]}>BLUETOOTH · {otherPeers.length}</Text>
          {otherPeers.length === 0 ? (
            <Text style={styles.groupEmpty}>No named Bluetooth devices right now.</Text>
          ) : (
            otherPeers.map((peer) => <PeerRow key={peer.id} peer={peer} />)
          )}
        </ScrollView>

        <View style={styles.logPanel}>
          <Text style={styles.logTitle}>DEVICE LOG</Text>
          <Text numberOfLines={3} style={styles.logText}>
            {logs.length ? logs.slice(0, 3).join('\n') : '[BLE] waiting for native transport'}
          </Text>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.paper, flex: 1 },
  safeArea: { flex: 1, paddingHorizontal: 20 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 24,
    paddingTop: 16,
  },
  wordmark: { color: colors.ink, fontSize: 31, fontWeight: '900', letterSpacing: -1.6 },
  eyebrow: { color: colors.red, fontSize: 11, fontWeight: '800', letterSpacing: 2.6, marginTop: 1 },
  statusDot: { backgroundColor: colors.green, borderRadius: 7, height: 14, width: 14 },
  statusDotWaiting: { backgroundColor: '#D49B35' },
  identityCard: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
  },
  label: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.7 },
  nameRow: { alignItems: 'center', flexDirection: 'row', gap: 10, marginTop: 6 },
  nameInput: {
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    color: colors.ink,
    flex: 1,
    fontSize: 19,
    fontWeight: '700',
    paddingVertical: 8,
  },
  saveButton: { backgroundColor: colors.ink, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  saveButtonText: { color: '#FFF', fontSize: 11, fontWeight: '800', letterSpacing: 0.7 },
  pressed: { opacity: 0.7 },
  deviceId: { color: colors.muted, fontSize: 11, marginTop: 8 },
  sectionHeader: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 12,
    paddingTop: 28,
  },
  sectionTitle: { color: colors.ink, fontSize: 28, fontWeight: '800', letterSpacing: -0.8 },
  scanning: { alignItems: 'center', flexDirection: 'row', gap: 6, paddingBottom: 3 },
  scanningText: { color: colors.muted, fontSize: 12 },
  error: { color: '#A92D20', fontSize: 13, marginBottom: 10 },
  lists: { gap: 10, paddingBottom: 12 },
  groupLabel: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.6, marginBottom: 2, marginTop: 4 },
  groupLabelSpaced: { marginTop: 18 },
  groupEmpty: { color: colors.muted, fontSize: 13, lineHeight: 19, paddingBottom: 4 },
  emptyList: { flexGrow: 1 },
  peerCard: {
    alignItems: 'center',
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    padding: 16,
  },
  peerIndicator: { backgroundColor: colors.green, borderRadius: 5, height: 10, marginRight: 12, width: 10 },
  peerIndicatorNored: { backgroundColor: colors.red },
  peerMain: { flex: 1 },
  peerName: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  peerId: { color: colors.muted, fontSize: 11, marginTop: 3 },
  peerMeta: { alignItems: 'flex-end' },
  signal: { color: colors.ink, fontSize: 12, fontWeight: '600' },
  seen: { color: colors.muted, fontSize: 11, marginTop: 4 },
  emptyState: { alignItems: 'center', flex: 1, justifyContent: 'center', paddingHorizontal: 38 },
  radar: {
    alignItems: 'center',
    borderColor: '#E7B9B1',
    borderRadius: 38,
    borderWidth: 1,
    height: 76,
    justifyContent: 'center',
    marginBottom: 18,
    width: 76,
  },
  radarInner: { backgroundColor: colors.red, borderRadius: 9, height: 18, width: 18 },
  emptyTitle: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  emptyBody: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 7, textAlign: 'center' },
  logPanel: {
    backgroundColor: '#22262C',
    borderRadius: 13,
    marginBottom: 10,
    minHeight: 68,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  logTitle: { color: '#999FA8', fontSize: 9, fontWeight: '800', letterSpacing: 1.4 },
  logText: { color: '#D9DDE2', fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }), fontSize: 10, lineHeight: 14, marginTop: 5 },
});
