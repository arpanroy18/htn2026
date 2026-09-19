import { useRouterData, useRouterService } from '@/mesh/RouterContext';
import { Stack, useLocalSearchParams } from 'expo-router';
import {
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
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
import { Avatar, Chip, IconButton } from '@/components/signal/ui';
import { useAlerts } from '@/mesh/AlertContext';
import { severityTone } from '@/mesh/alertStore';
import { useChat } from '@/mesh/ChatContext';
import { useMeshUi } from '@/mesh/MeshUiContext';
import { ALERT_THREAD_PREFIX, isAlertThreadId, type ChatDelivery, type ChatMessage } from '@/mesh/chatStore';
import { MAX_VOICE_SECONDS, VOICE_RECORDING_OPTIONS } from '@/mesh/mediaFiles';
import { signal } from '@/theme/signal';

// Gesture nav bar on Android sits right on top of the composer, so add a little
// breathing room below the safe-area inset.
const ANDROID_NAV_BAR_GAP = Platform.OS === 'android' ? 12 : 0;

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
  if (message.kind === 'image') {
    return <ImageBubble message={message} />;
  }
  if (message.kind === 'audio') {
    return <AudioBubble message={message} />;
  }
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

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function ImageBubble({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  if (!message.localUri) {
    return (
      <View style={styles.mediaPlaceholder}>
        <ActivityIndicator color={signal.blue} />
        <Text style={styles.mediaStatus}>
          {message.transferError ??
            `Receiving photo ${Math.round((message.transferProgress ?? 0) * 100)}%`}
        </Text>
      </View>
    );
  }
  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={({ pressed }) => pressed && styles.pressed}>
        <Image
          contentFit="cover"
          source={{ uri: message.localUri }}
          style={[
            styles.chatImage,
            message.width && message.height && message.width < message.height
              ? styles.chatImagePortrait
              : null,
          ]}
        />
        {(message.transferProgress ?? 1) < 1 ? (
          <View style={styles.mediaOverlay}>
            <Text style={styles.mediaOverlayText}>
              {Math.round((message.transferProgress ?? 0) * 100)}%
            </Text>
          </View>
        ) : null}
      </Pressable>
      <Modal animationType="fade" onRequestClose={() => setOpen(false)} visible={open}>
        <Pressable onPress={() => setOpen(false)} style={styles.viewer}>
          <Image contentFit="contain" source={{ uri: message.localUri }} style={styles.viewerImage} />
          <Text style={styles.viewerHint}>Tap to close</Text>
        </Pressable>
      </Modal>
    </>
  );
}

function AudioBubble({ message }: { message: ChatMessage }) {
  if (!message.localUri) {
    return (
      <View style={styles.mediaPlaceholder}>
        <ActivityIndicator color={signal.blue} />
        <Text style={styles.mediaStatus}>
          {message.transferError ??
            `Receiving voice note ${Math.round((message.transferProgress ?? 0) * 100)}%`}
        </Text>
      </View>
    );
  }

  return <AudioBubblePlayer message={message} />;
}

function AudioBubblePlayer({ message }: { message: ChatMessage }) {
  const player = useAudioPlayer({ uri: message.localUri! });
  const status = useAudioPlayerStatus(player);
  const progress =
    status.duration > 0 ? Math.min(1, status.currentTime / status.duration) : 0;

  const toggle = () => {
    if (status.playing) {
      player.pause();
    } else {
      if (status.duration > 0 && status.currentTime >= status.duration - 0.1) {
        void player.seekTo(0);
      }
      player.play();
    }
  };

  return (
    <Pressable
      accessibilityLabel={status.playing ? 'Pause voice note' : 'Play voice note'}
      accessibilityRole="button"
      onPress={toggle}
      style={[styles.audioBubble, message.mine && styles.audioBubbleMine]}>
      <Text style={[styles.audioPlay, message.mine && styles.bodyMine]}>
        {status.playing ? 'Ⅱ' : '▶'}
      </Text>
      <View style={styles.audioMain}>
        <View style={styles.waveform}>
          {Array.from({ length: 18 }, (_, index) => (
            <View
              key={index}
              style={[
                styles.waveBar,
                message.mine && styles.waveBarMine,
                index / 18 <= progress && styles.waveBarActive,
              ]}
            />
          ))}
        </View>
        <Text style={[styles.audioDuration, message.mine && styles.bodyMine]}>
          {formatDuration(
            status.duration > 0
              ? status.currentTime * 1000
              : (message.durationMs ?? 0),
          )}
        </Text>
      </View>
    </Pressable>
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
  const { identity, noredPeers } = useMeshUi();
  const meshRouter = useRouterService();
  const { contacts } = useRouterData();
  const { alerts, broadcastAlert } = useAlerts();
  const {
    threadFor,
    messagesFor,
    openDm,
    sendText,
    sendImage,
    sendVoiceNote,
    markRead,
    clearActive,
  } = useChat();
  const insets = useSafeAreaInsets();
  const headerHeight = insets.top + 44;
  const threadId = Array.isArray(params.id) ? params.id[0] : params.id;
  const isAlertThread = isAlertThreadId(threadId);
  const alertId = isAlertThread && threadId ? threadId.slice(ALERT_THREAD_PREFIX.length) : undefined;
  const alertItem = alerts.find((item) => item.id === alertId);
  const thread = threadFor(threadId ?? '');
  const title = isAlertThread ? 'Alert' : (thread?.name ?? params.title ?? 'Chat');
  const isGroup = isAlertThread || (thread?.kind ?? params.kind) === 'group';
  const memberIds = thread?.memberIds ?? [];
  const inRangeCount = memberIds.filter((id) =>
    id !== identity.id && noredPeers.some((peer) => peer.id === id && peer.identityConfirmed),
  ).length;
  const meshInRange = noredPeers.some((peer) => peer.identityConfirmed);
  const inRange = isAlertThread
    ? meshInRange
    : isGroup
      ? inRangeCount > 0
      : noredPeers.some(
          (peer) => peer.id === (thread?.peerId ?? threadId) && peer.identityConfirmed,
        );

  const savedContact = !!contacts[thread?.peerId ?? threadId];
  const addContact = () => {
    void meshRouter.addContact(thread?.peerId ?? threadId).catch((error) => Alert.alert('Contact not saved', error.message));
  };

  const [draft, setDraft] = useState('');
  const [emergency, setEmergency] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const keyboardVisible = keyboardHeight > 0;
  const [preparingMedia, setPreparingMedia] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [startingRecording, setStartingRecording] = useState(false);
  const [recordingDurationMs, setRecordingDurationMs] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const recordingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingStartedAt = useRef<number | null>(null);
  const recorderPrepared = useRef(false);
  const audioRecorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const items = messagesFor(threadId ?? '');
  const rows = useMemo(() => groupMessages(items), [items]);

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (event) => setKeyboardHeight(event.endCoordinates.height),
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardHeight(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    if (!threadId) return;
    if (!isGroup) openDm(threadId, title);
    markRead(threadId);
    return () => clearActive();
  }, [clearActive, isGroup, markRead, openDm, threadId, title]);

  useEffect(
    () => () => {
      if (recordingTimer.current) clearTimeout(recordingTimer.current);
      if (recorderPrepared.current) {
        recorderPrepared.current = false;
        void audioRecorder.stop().catch(() => undefined);
      }
    },
    [audioRecorder],
  );

  useEffect(() => {
    if (!isRecording) return;
    const interval = setInterval(() => {
      if (recordingStartedAt.current != null) {
        setRecordingDurationMs(Date.now() - recordingStartedAt.current);
      }
    }, 100);
    return () => clearInterval(interval);
  }, [isRecording]);

  const subtitle = useMemo(() => {
    if (isAlertThread) {
      return inRange
        ? 'Comments stay on this alert · not a new broadcast'
        : 'No phones in range · comments will queue';
    }
    if (isGroup) {
      const total = Math.max(memberIds.length, 1);
      if (!inRange) return `${total} members · out of range · will queue`;
      return `${total} members · ${inRangeCount} in range · Bluetooth`;
    }
    if (!inRange) return contacts[thread?.peerId ?? threadId]
      ? 'Text relays through nearby phones · media waits for a direct connection'
      : 'Add as a contact while nearby to send from afar';
    return '1:1 · Bluetooth';
  }, [contacts, inRange, inRangeCount, isAlertThread, isGroup, memberIds.length, thread?.peerId, threadId]);

  const send = () => {
    const body = draft.trim();
    if (!body || !threadId) return;
    if (!isAlertThread && emergency) {
      void broadcastAlert({ body, severity: 'HELP' }).then((result) => {
        if (result.ok) setDraft('');
        else Alert.alert('Alert not sent', result.error);
      });
      return;
    }
    void sendText(threadId, body)
      .then(() => setDraft(''))
      .catch((error) => Alert.alert('Message not queued', error instanceof Error ? error.message : 'Could not save message.'));
  };

  const finishRecording = useCallback(
    async (sendRecording: boolean) => {
      if (!threadId) return;
      const durationMs =
        recordingStartedAt.current != null
          ? Date.now() - recordingStartedAt.current
          : recordingDurationMs;
      if (recordingTimer.current) {
        clearTimeout(recordingTimer.current);
        recordingTimer.current = null;
      }
      recordingStartedAt.current = null;
      setIsRecording(false);
      setStartingRecording(false);
      setRecordingDurationMs(0);

      if (recorderPrepared.current) {
        recorderPrepared.current = false;
        try {
          await audioRecorder.stop();
          await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
          if (sendRecording && audioRecorder.uri && durationMs >= 300) {
            setPreparingMedia(true);
            await sendVoiceNote(threadId, audioRecorder.uri, durationMs);
          }
        } catch (error) {
          Alert.alert(
            'Could not send voice note',
            error instanceof Error ? error.message : 'The voice note could not be prepared.',
          );
        } finally {
          setPreparingMedia(false);
        }
      }
    },
    [audioRecorder, recordingDurationMs, sendVoiceNote, threadId],
  );

  const startRecording = async () => {
    if (!threadId || preparingMedia || isRecording || startingRecording) return;
    setStartingRecording(true);
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Microphone permission needed', 'Allow microphone access to record a voice note.');
      setStartingRecording(false);
      return;
    }
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await audioRecorder.prepareToRecordAsync();
      recorderPrepared.current = true;
      audioRecorder.record({ forDuration: MAX_VOICE_SECONDS });
      recordingStartedAt.current = Date.now();
      setIsRecording(true);
      setStartingRecording(false);
      recordingTimer.current = setTimeout(() => {
        void finishRecording(true);
      }, MAX_VOICE_SECONDS * 1000);
    } catch (error) {
      recorderPrepared.current = false;
      setStartingRecording(false);
      const message = error instanceof Error ? error.message : 'Voice recording could not start.';
      Alert.alert(
        'Could not record',
        message.includes('ExpoAudio') || message.includes('native')
          ? `${message}\n\nRebuild the app so audio support is included:\nnpx expo run:ios --device`
          : message,
      );
    }
  };

  const chooseImage = async () => {
    if (!threadId || preparingMedia || isRecording || startingRecording) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Photos permission needed', 'Allow photo access to send an image.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 1,
      selectionLimit: 1,
    });
    const image = result.assets?.[0];
    if (!image || result.canceled) return;
    setPreparingMedia(true);
    try {
      await sendImage(threadId, image.uri, image.width ?? 0, image.height ?? 0);
    } catch (error) {
      Alert.alert(
        'Could not send image',
        error instanceof Error ? error.message : 'The image could not be prepared.',
      );
    } finally {
      setPreparingMedia(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={headerHeight}
      style={[
        styles.safe,
        // Android is edge-to-edge, so adjustResize never shrinks the window and
        // KeyboardAvoidingView has nothing to react to. Lift the content manually.
        Platform.OS === 'android' && { paddingBottom: keyboardHeight },
      ]}>
      <Stack.Screen options={{ title }} />
      <View style={styles.threadBar}>
          <Text style={styles.subtitle}>{subtitle}</Text>
          {isGroup && !isAlertThread ? (
            <Pressable
              onPress={() => setEmergency((v) => !v)}
              style={({ pressed }) => [styles.emergencyToggle, emergency && styles.emergencyToggleOn, pressed && styles.pressed]}>
              <AlertsIcon color={emergency ? signal.white : signal.slate} size={14} />
              <Text style={[styles.emergencyLabel, emergency && styles.emergencyLabelOn]}>Emergency</Text>
            </Pressable>
          ) : null}
        </View>

        {!isGroup && inRange && !savedContact ? (
          <Pressable onPress={addContact} style={{ padding: 12 }}><Text style={{ color: signal.blue, textAlign: 'center' }}>Add contact for remote messaging</Text></Pressable>
        ) : null}
        <ScrollView
          contentContainerStyle={styles.messages}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          ref={scrollRef}
          showsVerticalScrollIndicator={false}>
          {isAlertThread && alertItem ? (
            <View style={styles.alertCard}>
              <View style={styles.alertCardTop}>
                <Chip label={alertItem.severity} tone={severityTone(alertItem.severity)} />
                <Text style={styles.alertCardMeta}>
                  {alertItem.sender} · {alertItem.time}
                </Text>
              </View>
              <Text style={styles.alertCardBody}>{alertItem.body}</Text>
            </View>
          ) : null}
          {rows.length === 0 ? (
            <Text style={styles.empty}>
              {isAlertThread
                ? 'Comments on this alert reach nearby phones without sending a new alert.'
                : isGroup
                ? inRange
                  ? 'Group is live on the mesh. Send a text.'
                  : 'No members in range. You can still type — it will queue.'
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
            {
              paddingBottom: keyboardVisible
                ? 10
                : Math.max(insets.bottom + ANDROID_NAV_BAR_GAP, 10),
            },
          ]}>
          {emergency && !isAlertThread ? (
            <Text style={styles.emergencyHint}>Sends as an EMERGENCY broadcast to every reachable phone</Text>
          ) : null}
          {isRecording || startingRecording ? (
            <View style={styles.recordingRow}>
              <Pressable
                onPress={() => void finishRecording(false)}
                style={({ pressed }) => [styles.recordingCancel, pressed && styles.pressed]}>
                <Text style={styles.recordingCancelText}>Cancel</Text>
              </Pressable>
              <View style={styles.recordingStatus}>
                {startingRecording ? (
                  <ActivityIndicator color={signal.blue} size="small" />
                ) : (
                  <View style={styles.recordingDot} />
                )}
                <Text style={styles.recordingTime}>
                  {startingRecording
                    ? 'Starting…'
                    : `${formatDuration(recordingDurationMs)} / 1:00`}
                </Text>
              </View>
              <IconButton
                disabled={startingRecording}
                onPress={() => void finishRecording(true)}
                tone="outline">
                <SendIcon color={signal.blue} size={16} />
              </IconButton>
            </View>
          ) : (
            <View style={styles.composerRow}>
              <IconButton onPress={() => void chooseImage()} tone="outline">
                <PlusIcon color={signal.blue} size={16} />
              </IconButton>
              <View style={styles.inputPill}>
                <TextInput
                  accessibilityLabel="Message"
                  editable={!preparingMedia}
                  maxLength={emergency && !isAlertThread ? 280 : 2000}
                  multiline
                  onChangeText={setDraft}
                  placeholder={
                    preparingMedia
                      ? 'Preparing media…'
                      : isAlertThread
                        ? 'Comment'
                        : emergency
                          ? 'Emergency broadcast'
                          : 'Message'
                  }
                  placeholderTextColor={signal.slate}
                  style={styles.input}
                  value={draft}
                />
                {!draft.trim() ? (
                  <Pressable
                    accessibilityLabel="Choose image"
                    accessibilityRole="button"
                    disabled={preparingMedia}
                    onPress={() => void chooseImage()}
                    style={({ pressed }) => [styles.inlineIcon, pressed && styles.pressed]}>
                    {preparingMedia ? (
                      <ActivityIndicator color={signal.slate} size="small" />
                    ) : (
                      <ImageIcon color={signal.slate} size={18} />
                    )}
                  </Pressable>
                ) : null}
              </View>
              {draft.trim() ? (
                <IconButton onPress={send} tone="outline">
                  <SendIcon color={signal.blue} size={16} />
                </IconButton>
              ) : (
                <IconButton onPress={() => void startRecording()} tone="outline">
                  <MicIcon color={signal.blue} size={18} />
                </IconButton>
              )}
            </View>
          )}
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
  alertCard: {
    backgroundColor: signal.mist,
    borderRadius: 16,
    gap: 8,
    marginBottom: 12,
    padding: 16,
  },
  alertCardTop: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  alertCardMeta: { color: signal.slate, fontSize: 12 },
  alertCardBody: { color: signal.ink, fontSize: 16, lineHeight: 22 },
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
  mediaPlaceholder: {
    alignItems: 'center',
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 16,
    borderWidth: 1,
    gap: 8,
    minHeight: 92,
    justifyContent: 'center',
    padding: 14,
    width: 220,
  },
  mediaStatus: { color: signal.slate, fontSize: 12, textAlign: 'center' },
  chatImage: { borderRadius: 16, height: 170, width: 240 },
  chatImagePortrait: { height: 260, width: 195 },
  mediaOverlay: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 16,
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  mediaOverlayText: { color: signal.white, fontSize: 15, fontWeight: '700' },
  viewer: {
    alignItems: 'center',
    backgroundColor: '#000',
    flex: 1,
    justifyContent: 'center',
  },
  viewerImage: { height: '88%', width: '100%' },
  viewerHint: { bottom: 28, color: signal.white, fontSize: 13, position: 'absolute' },
  audioBubble: {
    alignItems: 'center',
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minWidth: 225,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  audioBubbleMine: { backgroundColor: signal.blue, borderColor: signal.blue },
  audioPlay: { color: signal.blue, fontSize: 18, width: 20 },
  audioMain: { flex: 1, gap: 6 },
  waveform: { alignItems: 'center', flexDirection: 'row', gap: 3, height: 24 },
  waveBar: { backgroundColor: signal.fog, borderRadius: 2, height: 10, width: 3 },
  waveBarMine: { backgroundColor: 'rgba(255,255,255,0.45)' },
  waveBarActive: { backgroundColor: signal.deep, height: 18 },
  audioDuration: { color: signal.slate, fontSize: 11 },
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
  recordingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    minHeight: 40,
  },
  recordingCancel: { paddingHorizontal: 4, paddingVertical: 8 },
  recordingCancelText: { color: signal.slate, fontSize: 14, fontWeight: '600' },
  recordingStatus: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  recordingDot: { backgroundColor: '#ef4444', borderRadius: 5, height: 10, width: 10 },
  recordingTime: { color: signal.ink, fontSize: 15, fontVariant: ['tabular-nums'] },
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
