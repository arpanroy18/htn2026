import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import {
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

import { AlertsIcon, ImageIcon, MicIcon, PlusIcon, SendIcon } from '@/components/signal/icons';
import { Avatar, IconButton } from '@/components/signal/ui';
import { messagesFor, threadById, type ChatMessage, type DeliveryStatus } from '@/data/mock';
import { signal } from '@/theme/signal';

function statusLabel(status?: DeliveryStatus) {
  if (!status) return '';
  return status[0].toUpperCase() + status.slice(1);
}

function Waveform() {
  const bars = [6, 14, 10, 18, 8, 16, 12, 20, 9, 15, 7, 13];
  return (
    <View style={styles.wave}>
      {bars.map((height, index) => (
        <View key={index} style={[styles.bar, { height }]} />
      ))}
    </View>
  );
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
      {message.kind === 'text' ? <Text style={[styles.body, mine && styles.bodyMine]}>{message.body}</Text> : null}
      {message.kind === 'audio' ? (
        <View>
          <View style={styles.audioRow}>
            <View style={[styles.play, mine && styles.playMine]} />
            <Waveform />
            <Text style={[styles.duration, mine && styles.bodyMine]}>{message.duration}</Text>
          </View>
          {message.transcriptUnavailable ? (
            <Text style={[styles.badge, mine && styles.bodyMineMuted]}>Transcript unavailable</Text>
          ) : null}
          {message.transcript ? (
            <View style={styles.sideBySide}>
              <Text style={[styles.transcript, mine && styles.bodyMine]}>{message.transcript}</Text>
              {message.translation ? (
                <Text style={[styles.translation, mine && styles.bodyMineMuted]}>{message.translation}</Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
      {message.kind === 'image' ? (
        <Pressable style={({ pressed }) => [styles.image, pressed && styles.pressed]}>
          <View style={styles.imageFill} />
          <Text style={[styles.imageCaption, mine && styles.bodyMine]}>{message.body}</Text>
        </Pressable>
      ) : null}
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
  const thread = threadById(params.id);
  const title = params.title ?? thread?.name ?? 'Chat';
  const kind = params.kind ?? thread?.kind ?? 'dm';
  const isGroup = kind === 'group';

  const [draft, setDraft] = useState('');
  const [emergency, setEmergency] = useState(false);
  const [threadId, setThreadId] = useState(params.id);
  const [items, setItems] = useState<ChatMessage[]>(() => messagesFor(params.id));

  if (threadId !== params.id) {
    setThreadId(params.id);
    setItems(messagesFor(params.id));
  }

  const rows = useMemo(() => groupMessages(items), [items]);

  const subtitle = useMemo(() => {
    if (thread?.outOfRange) return 'Out of range · will queue';
    if (isGroup) return `${thread?.members ?? '—'} members · mesh group`;
    return '1:1 · local history';
  }, [isGroup, thread]);

  const send = () => {
    const body = draft.trim();
    if (!body) return;
    setItems((current) => [
      ...current,
      {
        id: String(Date.now()),
        sender: 'You',
        mine: true,
        kind: 'text',
        body,
        status: thread?.outOfRange ? 'sent' : 'relayed',
        time: 'now',
      },
    ]);
    setDraft('');
  };

  return (
    <SafeAreaView edges={['bottom']} style={styles.safe}>
      <Stack.Screen options={{ title }} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
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

        <ScrollView contentContainerStyle={styles.messages} showsVerticalScrollIndicator={false}>
          {rows.map(({ message, first, last }) => (
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
          ))}
        </ScrollView>

        <View style={[styles.composer, emergency && styles.composerEmergency]}>
          {emergency ? (
            <Text style={styles.emergencyHint}>Styled as an emergency broadcast · mesh flood not connected yet</Text>
          ) : null}
          <View style={styles.composerRow}>
            <IconButton onPress={() => {}} tone="outline">
              <PlusIcon color={signal.blue} size={16} />
            </IconButton>
            <View style={styles.inputPill}>
              <TextInput
                accessibilityLabel="Message"
                maxLength={2000}
                multiline
                onChangeText={setDraft}
                placeholder="Message"
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
    </SafeAreaView>
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
  messages: { gap: 2, padding: 20, paddingBottom: 12 },
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
  bodyMineMuted: { color: 'rgba(255,255,255,0.72)' },
  audioRow: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  play: {
    borderColor: signal.ink,
    borderLeftWidth: 10,
    borderBottomWidth: 6,
    borderTopWidth: 6,
    borderBottomColor: 'transparent',
    borderTopColor: 'transparent',
    height: 0,
    width: 0,
  },
  playMine: { borderLeftColor: signal.white },
  wave: { alignItems: 'flex-end', flexDirection: 'row', gap: 3, height: 20 },
  bar: { backgroundColor: signal.ink, borderRadius: 1, width: 3 },
  duration: { color: signal.ink, fontSize: 13, fontWeight: '600' },
  badge: { color: signal.slate, fontSize: 12, marginTop: 8 },
  sideBySide: { gap: 6, marginTop: 10 },
  transcript: { color: signal.ink, fontSize: 14, lineHeight: 21 },
  translation: { color: signal.slate, fontSize: 14, lineHeight: 21 },
  image: { width: 180 },
  imageFill: {
    backgroundColor: signal.sky,
    borderRadius: 14,
    height: 120,
  },
  imageCaption: { color: signal.ink, fontSize: 13, marginTop: 8 },
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
