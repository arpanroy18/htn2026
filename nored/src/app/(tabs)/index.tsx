import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Screen, ScreenHeader } from '@/components/signal/screen';
import { GearIcon, SignalBars } from '@/components/signal/icons';
import { Avatar, GroupedList, IconButton, OutlinedButton, RowPress } from '@/components/signal/ui';
import { useChat } from '@/mesh/ChatContext';
import { hopLabel, isValidRssi, signalLabel, statusCopy, useMeshUi } from '@/mesh/MeshUiContext';
import { signal } from '@/theme/signal';
import type { Peer } from '@/transport';

function levelFor(rssi?: number): 0 | 1 | 2 | 3 {
  if (!isValidRssi(rssi)) return 0;
  if (rssi >= -60) return 3;
  if (rssi >= -75) return 2;
  return 1;
}

function PeerRow({ peer, onPress, onLongPress }: { peer: Peer; onPress: () => void; onLongPress: () => void }) {
  return (
    <RowPress onLongPress={onLongPress} onPress={onPress} style={styles.peer}>
      <Avatar
        color={peer.avatarColor}
        icon={peer.avatarIcon}
        name={peer.name}
        peerId={peer.id}
        size={44}
      />
      <View style={styles.peerMain}>
        <Text style={styles.peerName}>{peer.name}</Text>
        <Text style={styles.peerMeta}>
          {hopLabel(peer)} · {peer.id.slice(0, 8)}
        </Text>
      </View>
      <View style={styles.peerRight}>
        <SignalBars color={signal.deep} level={levelFor(peer.rssi)} mutedColor={signal.fog} size={16} />
        <Text style={styles.signalLabel}>{signalLabel(peer.rssi)}</Text>
      </View>
    </RowPress>
  );
}

export default function NearbyScreen() {
  const {
    identity,
    draftName,
    setDraftName,
    saveName,
    saving,
    noredPeers,
    otherPeers,
    state,
    error,
    logs,
    rescan,
  } = useMeshUi();
  const { openDm: rememberDm } = useChat();
  const [rescanning, setRescanning] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const shortId = identity.id.slice(0, 8);
  const dirty = draftName.trim().length > 0 && draftName.trim() !== identity.name;

  const openDm = (peer: Peer) => {
    if (!peer.nored) return;
    rememberDm(peer.id, peer.name);
    router.push({
      pathname: '/chat/[id]',
      params: { id: peer.id, title: peer.name, kind: 'dm' },
    });
  };

  const invite = (peer: Peer) => {
    router.push({ pathname: '/invite', params: { peerId: peer.id, peerName: peer.name } });
  };

  const onRescan = async () => {
    setRescanning(true);
    try {
      await rescan();
    } finally {
      setRescanning(false);
    }
  };

  const commitName = async () => {
    if (dirty) await saveName();
    setEditingName(false);
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
      <Screen>
        <ScreenHeader
          action={
            <IconButton onPress={() => router.push('/settings')} tone="ghost">
              <GearIcon color={signal.slate} size={24} />
            </IconButton>
          }
          title="Nearby"
        />

        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          <RowPress onPress={() => setEditingName(true)} style={styles.identity}>
            <Avatar
              color={identity.avatarColor}
              icon={identity.avatarIcon}
              name={identity.name}
              peerId={identity.id}
              size={52}
            />
            <View style={styles.identityMain}>
              {editingName ? (
                <TextInput
                  autoFocus
                  accessibilityLabel="Your nearby display name"
                  autoCapitalize="words"
                  maxLength={40}
                  onBlur={commitName}
                  onChangeText={setDraftName}
                  onSubmitEditing={commitName}
                  returnKeyType="done"
                  style={styles.nameInput}
                  value={draftName}
                />
              ) : (
                <Text style={styles.identityName}>{identity.name}</Text>
              )}
              <Text style={styles.identityMeta}>
                {saving ? 'Saving…' : `You · ${shortId}`}
              </Text>
            </View>
            <Text style={styles.editHint}>{editingName ? '' : 'Edit'}</Text>
          </RowPress>

          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>In range</Text>
            <View style={styles.scanRow}>
              {state === 'running' && <ActivityIndicator color={signal.deep} size="small" />}
              <Text style={styles.scanText}>{statusCopy(state)}</Text>
            </View>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Text style={styles.groupLabel}>NORED · {noredPeers.length}</Text>
          {noredPeers.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.empty}>No other Nored phones yet. Keep the app open so you stay visible.</Text>
            </View>
          ) : (
            <GroupedList>
              {noredPeers.map((peer) => (
                <PeerRow key={peer.id} onLongPress={() => invite(peer)} onPress={() => openDm(peer)} peer={peer} />
              ))}
            </GroupedList>
          )}

          <Text style={[styles.groupLabel, styles.spaced]}>BLUETOOTH · {otherPeers.length}</Text>
          {otherPeers.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.empty}>No named Bluetooth devices right now.</Text>
            </View>
          ) : (
            <GroupedList>
              {otherPeers.map((peer) => (
                <PeerRow key={peer.id} onLongPress={() => invite(peer)} onPress={() => invite(peer)} peer={peer} />
              ))}
            </GroupedList>
          )}

          <Text style={styles.hint}>Tap a Nored phone to send Bluetooth text. Hold to invite into a group.</Text>

          <View style={styles.actions}>
            <OutlinedButton disabled={rescanning} label={rescanning ? 'Scanning…' : 'Rescan'} onPress={onRescan} style={styles.actionBtn} />
            <OutlinedButton label="New group" onPress={() => router.push('/new-group')} style={styles.actionBtn} />
          </View>

          <View style={styles.log}>
            <Text style={styles.logTitle}>DEVICE LOG</Text>
            <Text style={styles.logText}>
              {logs.length ? logs.slice(0, 3).join('\n') : '[BLE] waiting for native transport'}
            </Text>
          </View>
        </ScrollView>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { gap: 10, paddingBottom: 36, paddingHorizontal: 24 },
  identity: {
    alignItems: 'center',
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 14,
    marginBottom: 8,
    padding: 16,
  },
  identityMain: { flex: 1 },
  identityName: { color: signal.ink, fontSize: 20, fontWeight: '700' },
  nameInput: {
    borderBottomColor: signal.blue,
    borderBottomWidth: 1.5,
    color: signal.ink,
    fontSize: 20,
    fontWeight: '700',
    paddingVertical: 2,
  },
  identityMeta: { color: signal.slate, fontSize: 13, marginTop: 3 },
  editHint: { color: signal.blue, fontSize: 14, fontWeight: '600' },
  sectionHead: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  sectionTitle: { color: signal.ink, fontSize: 22, fontWeight: '800', lineHeight: 27 },
  scanRow: { alignItems: 'center', flexDirection: 'row', gap: 6, paddingBottom: 3 },
  scanText: { color: signal.slate, fontSize: 13 },
  error: { color: signal.ink, fontSize: 14, lineHeight: 21 },
  groupLabel: {
    color: signal.slate,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.4,
    marginTop: 10,
    marginBottom: 2,
  },
  spaced: { marginTop: 20 },
  emptyCard: {
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 16,
    borderWidth: 1,
    padding: 18,
  },
  empty: { color: signal.slate, fontSize: 15, lineHeight: 22 },
  peer: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    padding: 14,
  },
  peerMain: { flex: 1 },
  peerName: { color: signal.ink, fontSize: 16, fontWeight: '600' },
  peerMeta: { color: signal.slate, fontSize: 13, marginTop: 2 },
  peerRight: { alignItems: 'flex-end', gap: 4 },
  signalLabel: { color: signal.slate, fontSize: 11, fontWeight: '600' },
  hint: { color: signal.slate, fontSize: 13, marginTop: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 4 },
  actionBtn: { flex: 1, paddingHorizontal: 12 },
  log: {
    backgroundColor: signal.twilight,
    borderRadius: 16,
    marginTop: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  logTitle: { color: signal.fog, fontSize: 11, fontWeight: '600', letterSpacing: 1.3 },
  logText: {
    color: signal.fog,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 11,
    lineHeight: 16,
    marginTop: 8,
  },
});
