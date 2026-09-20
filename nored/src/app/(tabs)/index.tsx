import { router } from 'expo-router';
import { useMemo, useState } from 'react';
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
import { GearIcon, RefreshIcon, SignalBars } from '@/components/signal/icons';
import { Avatar, GroupedList, IconButton, RowPress } from '@/components/signal/ui';
import { useChat } from '@/mesh/ChatContext';
import { hopLabel, isValidRssi, signalLabel, useMeshUi } from '@/mesh/MeshUiContext';
import { isBadgePeer } from '@/mesh/badgePeer';
import { signal } from '@/theme/signal';
import type { Peer } from '@/transport';

function levelFor(rssi?: number): 0 | 1 | 2 | 3 {
  if (!isValidRssi(rssi)) return 0;
  if (rssi >= -60) return 3;
  if (rssi >= -75) return 2;
  return 1;
}

function peerStatus(peer: Peer) {
  if (peer.pendingLoss) return `Out of range · ${peer.id.slice(0, 8)}`;
  return `${hopLabel(peer)} · ${peer.id.slice(0, 8)}`;
}

function PeerRow({
  peer,
  onPress,
  onLongPress,
}: {
  peer: Peer;
  onPress: () => void;
  onLongPress: () => void;
}) {
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
        <Text style={styles.peerMeta}>{peerStatus(peer)}</Text>
      </View>
      <View style={styles.peerRight}>
        <SignalBars
          color={signal.deep}
          level={peer.pendingLoss ? 0 : levelFor(peer.rssi)}
          mutedColor={signal.fog}
          size={16}
        />
        <Text style={styles.signalLabel}>
          {peer.pendingLoss ? 'Out of range' : signalLabel(peer.rssi)}
        </Text>
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
    visibleNoredPeers,
    error,
    rescan,
  } = useMeshUi();
  const { openDm: rememberDm } = useChat();
  const [rescanning, setRescanning] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const shortId = identity.id.slice(0, 8);
  const dirty = draftName.trim().length > 0 && draftName.trim() !== identity.name;
  const badgePeers = useMemo(
    () => visibleNoredPeers.filter((peer) => isBadgePeer(peer.name)),
    [visibleNoredPeers],
  );
  const userPeers = useMemo(
    () => visibleNoredPeers.filter((peer) => !isBadgePeer(peer.name)),
    [visibleNoredPeers],
  );
  const openDm = (peer: Peer) => {
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
            <View style={styles.headerActions}>
              <IconButton disabled={rescanning} onPress={() => void onRescan()} tone="ghost">
                {rescanning ? (
                  <ActivityIndicator color={signal.slate} size="small" />
                ) : (
                  <RefreshIcon color={signal.slate} size={22} />
                )}
              </IconButton>
              <IconButton onPress={() => router.push('/settings')} tone="ghost">
                <GearIcon color={signal.slate} size={24} />
              </IconButton>
            </View>
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
            <Text style={styles.sectionTitle}>People</Text>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Text style={styles.groupLabel}>USERS</Text>
          {userPeers.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.empty}>
                No other Nored users in range. Your own phone is shown above.
              </Text>
            </View>
          ) : (
            <GroupedList>
              {userPeers.map((peer) => (
                <PeerRow
                  key={peer.id}
                  onLongPress={() => invite(peer)}
                  onPress={() => openDm(peer)}
                  peer={peer}
                />
              ))}
            </GroupedList>
          )}

          <Text style={[styles.groupLabel, styles.spaced]}>BADGES</Text>
          {badgePeers.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.empty}>No Nored badges in range.</Text>
            </View>
          ) : (
            <GroupedList>
              {badgePeers.map((peer) => (
                <PeerRow
                  key={peer.id}
                  onLongPress={() => invite(peer)}
                  onPress={() => openDm(peer)}
                  peer={peer}
                />
              ))}
            </GroupedList>
          )}

        </ScrollView>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { gap: 10, paddingBottom: 36, paddingHorizontal: 24 },
  headerActions: { alignItems: 'center', flexDirection: 'row', gap: 4 },
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
  error: { color: signal.ink, fontSize: 14, lineHeight: 21 },
  groupLabel: {
    color: signal.slate,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.4,
    marginTop: 10,
    marginBottom: 2,
  },
  tightSpaced: { marginTop: 8 },
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
});
