import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AlertsIcon, ImageIcon, MicIcon, PlusIcon, SendIcon } from '@/components/signal/icons';
import { Avatar, IconButton } from '@/components/signal/ui';
import { useChat } from '@/mesh/ChatContext';
import { useMeshUi } from '@/mesh/MeshUiContext';
import type { ChatDelivery, ChatMessage } from '@/mesh/chatStore';
import { signal } from '@/theme/signal';

function statusLabel(status?: ChatDelivery) {
  if (!status) return '';
  return status[0].toUpperCase() + status.slice(1);
}

function Bubble({
  message,
  showTail,
}: {
  message: ChatMessage;
  showTail: boolean;
}) {
  const mine = message.mine;
  return (
    <View
      style={[
        styles.bubble,
        mine ? styles.bubbleMine : styles.bubbleTheirs,
        showTail && (mine ? styles.tailMine : styles.tailTheirs),
      ]}>
      <Text style={[styles.body, mine && styles.bodyMine]}>{message.body}</Text>
    </View>
  );
}

type Row = { message: ChatMessage; first: boolean; last: boolean };

function groupMessages(items: ChatMessage[]): Row[] {
  return items.map((message, index) => {
    const prev = items[index - 1];
    const next = items[index + 1];
    return {
      message,
      first: !prev || prev.sender !== message.sender,
      last: !next || next.sender !== message.sender,
    };
  });
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{ id: string; title?: string; kind?: string }>();
  const { noredPeers } = useMeshUi();
  const { threadFor, messagesFor, openDm, sendText, markRead, clearActive } = useChat();
  const insets = useSafeAreaInsets();
  const headerHeight = insets.top + 44;
  const threadId = Array.isArray(params.id) ? params.id[0] : params.id;
  const thread = threadFor(threadId ?? '');
  const title = thread?.name ?? params.title ?? 'Chat';
  const kind = params.kind ?? thread?.kind ?? 'dm';
  const isGroup = kind === 'group';
  const inRange = noredPeers.some(
    (peer) => peer.id === (thread?.peerId ?? threadId) && peer.identityConfirmed,
  );

  const [draft, setDraft] = useState('');
  const [emergency, setEmergency] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const items = messagesFor(threadId ?? '');
  const rows = useMemo(() => groupMessages(items), [items]);

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboardVisible(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardVisible(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    if (!threadId || isGroup) return;
    openDm(threadId, title);
    markRead(threadId);
    return () => clearActive();
  }, [clearActive, isGroup, markRead, openDm, threadId, title]);

  const subtitle = useMemo(() => {
    if (isGroup) return 'Groups are still local — Bluetooth text is 1:1 for now';
    if (!inRange) return 'Out of range · will queue until they reappear';
    return '1:1 · Bluetooth';
  }, [inRange, isGroup]);

  const send = () => {
    const body = draft.trim();
    if (!body || !threadId || isGroup) return;
    setDraft('');
    void sendText(threadId, body);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={headerHeight}
      style={styles.safe}>
      <Stack.Screen options={{ title }} />
      <View style={styles.threadBar}>
          <Text style={styles.subtitle}>{subtitle}</Text>
          {isGroup ? (
            <Pressable
              onPress={() => setEmergency((v) => !v)}
              style={({ pressed }) => [styles.emergencyToggle, emergency && styles.emergencyToggleOn, pressed && styles.pressed]}>
              <AlertsIcon color={emergency ? signal.white : signal.slate} size={14} />
              <Text style={[styles.emergencyLabel, emergency && styles.emergencyLabelOn]}>Emergency</Text>
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          contentContainerStyle={styles.messages}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          ref={scrollRef}
          showsVerticalScrollIndicator={false}>
          {rows.length === 0 ? (
            <Text style={styles.empty}>
              {isGroup
                ? 'Group mesh send is not wired yet.'
                : inRange
                  ? 'Bluetooth is linked. Send a text.'
                  : 'This phone is out of range. You can still type — it will queue.'}
            </Text>
          ) : (
            rows.map(({ message, first, last }) => (
              <View key={message.id} style={[styles.rowWrap, message.mine ? styles.rowWrapMine : styles.rowWrapTheirs, first && styles.rowSpaced]}>
                {!message.mine ? (
                  <View style={styles.avatarSlot}>{last ? <Avatar name={message.sender} size={26} /> : null}</View>
                ) : null}
                <View style={[styles.column, message.mine && styles.columnMine]}>
                  {!message.mine && first ? <Text style={styles.sender}>{message.sender}</Text> : null}
                  <Bubble message={message} showTail={last} />
                  {last ? (
                    <View style={[styles.metaRow, message.mine && styles.metaRowMine]}>
                      <Text style={styles.time}>{message.time}</Text>
                      {message.mine && message.status ? (
                        <>
                          <Text style={styles.metaDot}>·</Text>
                          <Text style={styles.status}>{statusLabel(message.status)}</Text>
                        </>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              </View>
            ))
          )}
        </ScrollView>

        <View
          style={[
            styles.composer,
            emergency && styles.composerEmergency,
            { paddingBottom: keyboardVisible ? 10 : Math.max(insets.bottom, 10) },
          ]}>
          {emergency ? (
            <Text style={styles.emergencyHint}>Emergency broadcasts are not sent over the mesh yet</Text>
          ) : null}
          <View style={styles.composerRow}>
            <IconButton onPress={() => {}} tone="outline">
              <PlusIcon color={signal.blue} size={16} />
            </IconButton>
            <View style={styles.inputPill}>
              <TextInput
                accessibilityLabel="Message"
                editable={!isGroup}
                maxLength={2000}
                multiline
                onChangeText={setDraft}
                placeholder={isGroup ? 'Groups coming later' : 'Message'}
                placeholderTextColor={signal.slate}
                style={styles.input}
                value={draft}
              />
              {!draft.trim() ? (
                <Pressable accessibilityRole="button" style={({ pressed }) => [styles.inlineIcon, pressed && styles.pressed]}>
                  <ImageIcon color={signal.slate} size={18} />
                </Pressable>
              ) : null}
            </View>
            {draft.trim() ? (
              <IconButton onPress={send} tone="outline">
                <SendIcon color={signal.blue} size={16} />
              </IconButton>
            ) : (
              <IconButton onPress={() => {}} tone="outline">
                <MicIcon color={signal.blue} size={18} />
              </IconButton>
            )}
          </View>
        </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  safe: { backgroundColor: signal.paper, flex: 1 },
  flex: { flex: 1 },
  threadBar: {
    alignItems: 'center',
    backgroundColor: signal.paper,
    borderBottomColor: signal.fog,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  subtitle: { color: signal.slate, flex: 1, fontSize: 13, lineHeight: 18, marginRight: 12 },
  emergencyToggle: {
    alignItems: 'center',
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  emergencyToggleOn: { backgroundColor: signal.blue, borderColor: signal.blue },
  emergencyLabel: { color: signal.slate, fontSize: 12, fontWeight: '600' },
  emergencyLabelOn: { color: signal.white },
  messages: { flexGrow: 1, gap: 2, padding: 20, paddingBottom: 12 },
  empty: { color: signal.slate, fontSize: 15, lineHeight: 22, marginTop: 12 },
  rowWrap: { flexDirection: 'row', gap: 8, maxWidth: '100%' },
  rowWrapTheirs: { alignSelf: 'flex-start' },
  rowWrapMine: { alignSelf: 'flex-end', justifyContent: 'flex-end' },
  rowSpaced: { marginTop: 10 },
  avatarSlot: { width: 26 },
  column: { alignItems: 'flex-start', maxWidth: 260 },
  columnMine: { alignItems: 'flex-end' },
  sender: { color: signal.slate, fontSize: 12, fontWeight: '600', marginBottom: 3, marginLeft: 2 },
  bubble: {
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleTheirs: {
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderWidth: 1,
  },
  bubbleMine: {
    backgroundColor: signal.blue,
  },
  tailTheirs: { borderBottomLeftRadius: 4 },
  tailMine: { borderBottomRightRadius: 4 },
  body: { color: signal.ink, fontSize: 16, lineHeight: 22 },
  bodyMine: { color: signal.white },
  metaRow: { alignItems: 'center', flexDirection: 'row', gap: 5, marginLeft: 4, marginTop: 4 },
  metaRowMine: { marginLeft: 0, marginRight: 4 },
  metaDot: { color: signal.slate, fontSize: 12 },
  time: { color: signal.slate, fontSize: 12 },
  status: { color: signal.slate, fontSize: 12 },
  composer: {
    backgroundColor: signal.white,
    borderTopColor: signal.fog,
    borderTopWidth: 1,
    paddingBottom: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  composerEmergency: {
    backgroundColor: signal.sky,
  },
  emergencyHint: { color: signal.slate, fontSize: 12, lineHeight: 17, marginBottom: 8 },
  composerRow: { alignItems: 'flex-end', flexDirection: 'row', gap: 8 },
  inputPill: {
    alignItems: 'flex-end',
    backgroundColor: signal.paper,
    borderColor: signal.fog,
    borderRadius: 20,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    minHeight: 40,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  input: {
    color: signal.ink,
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    maxHeight: 100,
    paddingVertical: 0,
  },
  inlineIcon: { paddingBottom: 2 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
});
