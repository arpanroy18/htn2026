import { useRouterData, useRouterService } from '@/mesh/RouterContext';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Image } from 'expo-image';
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

import { avatarForPeer } from '@/avatar/profile';
import { AlertsIcon, ImageIcon, MicIcon, SendIcon } from '@/components/signal/icons';
import { Avatar, AvatarStack, Chip, IconButton } from '@/components/signal/ui';
import { useVoiceRecorder } from '@/hooks/use-voice-recorder';
import { useAlerts } from '@/mesh/AlertContext';
import { ALERT_MAX_BODY, severityTone } from '@/mesh/alertStore';
import { useChat } from '@/mesh/ChatContext';
import { useMeshUi } from '@/mesh/MeshUiContext';
import { ALERT_THREAD_PREFIX, isAlertThreadId, type ChatDelivery, type ChatMessage } from '@/mesh/chatStore';
import { MAX_VOICE_SECONDS } from '@/mesh/mediaFiles';
import { pickPhotoAsync } from '@/mesh/photoPicker';
import { languageCodeAbbrev } from '@/transcription/viewerLocale';
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
  threadId,
  onRequestTranscript,
}: {
  message: ChatMessage;
  showTail: boolean;
  threadId: string;
  onRequestTranscript: (threadId: string, messageId: string) => void;
}) {
  const mine = message.mine;
  if (message.kind === 'image') {
    return <ImageBubble message={message} />;
  }
  if (message.kind === 'audio') {
    return (
      <AudioBubble
        message={message}
        onRequestTranscript={onRequestTranscript}
        threadId={threadId}
      />
    );
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

function MediaPlaceholder({ label, message }: { label: string; message: ChatMessage }) {
  const failed = Boolean(message.transferError);
  return (
    <View style={styles.mediaPlaceholder}>
      {failed ? null : <ActivityIndicator color={signal.blue} />}
      <Text style={[styles.mediaStatus, failed && styles.mediaStatusFailed]}>
        {message.transferError ??
          `Receiving ${label} ${Math.round((message.transferProgress ?? 0) * 100)}%`}
      </Text>
    </View>
  );
}

function ImageBubble({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  if (!message.localUri) {
    return <MediaPlaceholder label="photo" message={message} />;
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

function AudioBubble({
  message,
  threadId,
  onRequestTranscript,
}: {
  message: ChatMessage;
  threadId: string;
  onRequestTranscript: (threadId: string, messageId: string) => void;
}) {
  if (!message.localUri) {
    return <MediaPlaceholder label="voice note" message={message} />;
  }
  return (
    <AudioBubblePlayer
      message={message}
      onRequestTranscript={onRequestTranscript}
      threadId={threadId}
    />
  );
}

function TranscriptRow({
  message,
  mine,
  onPress,
}: {
  message: ChatMessage;
  mine: boolean;
  onPress: () => void;
}) {
  const status = message.transcriptStatus;
  const translationStatus = message.translationStatus;

  const transcriptAlign = mine ? styles.transcriptBelowMine : styles.transcriptBelowTheirs;
  const transcriptTextAlign = mine ? styles.transcriptTextMine : undefined;

  if (status === 'ready' && message.transcript) {
    const showTranslation =
      translationStatus === 'ready' &&
      message.translation &&
      message.translation !== message.transcript;
    const canRetryTranslation =
      translationStatus === 'unavailable' || translationStatus === 'skipped';

    return (
      <View style={[styles.transcriptBlock, transcriptAlign]}>
        <Text style={[styles.transcriptText, transcriptTextAlign]}>{message.transcript}</Text>
        {translationStatus === 'pending' ? (
          <Text style={[styles.transcriptMeta, transcriptTextAlign]}>Translating…</Text>
        ) : null}
        {showTranslation ? (
          <>
            <Text style={[styles.translationLabel, transcriptTextAlign]}>Translated</Text>
            <Text style={[styles.translationText, transcriptTextAlign]}>
              {message.translation}
            </Text>
          </>
        ) : null}
        {canRetryTranslation ? (
          <Pressable
            accessibilityLabel="Retry translation"
            accessibilityRole="button"
            onPress={onPress}
            style={styles.transcriptAction}>
            <Text style={[styles.transcriptMeta, transcriptTextAlign]}>
              {translationStatus === 'skipped'
                ? 'See translation'
                : 'Translation unavailable · Tap to retry'}
            </Text>
            {__DEV__ && message.translationError ? (
              <Text style={[styles.transcriptDebug, transcriptTextAlign]}>
                {message.translationError}
              </Text>
            ) : null}
          </Pressable>
        ) : null}
        {__DEV__ ? (
          <Text style={[styles.transcriptDebug, transcriptTextAlign]}>
            {message.transcriptLanguage
              ? `Detected: ${languageCodeAbbrev(message.transcriptLanguage)}`
              : 'Detected: ???'}
            {message.translatedTo ? ` · Target: ${languageCodeAbbrev(message.translatedTo)}` : ''}
            {message.translationStatus ? ` · ${message.translationStatus}` : ''}
          </Text>
        ) : null}
      </View>
    );
  }

  if (status === 'pending') {
    return (
      <Text style={[styles.transcriptMeta, transcriptAlign, transcriptTextAlign]}>
        Transcribing…
      </Text>
    );
  }

  if (status === 'unavailable') {
    return (
      <Pressable
        accessibilityLabel="Retry transcription"
        accessibilityRole="button"
        onPress={onPress}
        style={[styles.transcriptAction, transcriptAlign]}>
        <Text style={[styles.transcriptMeta, transcriptTextAlign]}>
          Transcript unavailable · Tap to retry
        </Text>
        {__DEV__ && message.transcriptError ? (
          <Text style={[styles.transcriptDebug, transcriptTextAlign]}>
            {message.transcriptError}
          </Text>
        ) : null}
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityLabel="See transcription"
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.transcriptAction, transcriptAlign]}>
      <Text style={[styles.transcriptActionText, transcriptTextAlign]}>
        See transcription
      </Text>
    </Pressable>
  );
}

function AudioBubblePlayer({
  message,
  threadId,
  onRequestTranscript,
}: {
  message: ChatMessage;
  threadId: string;
  onRequestTranscript: (threadId: string, messageId: string) => void;
}) {
  const player = useAudioPlayer({ uri: message.localUri! }, { updateInterval: 100 });
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

  const requestTranscript = useCallback(() => {
    onRequestTranscript(threadId, message.id);
  }, [message.id, onRequestTranscript, threadId]);

  return (
    <View style={styles.audioColumn}>
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
      <TranscriptRow message={message} mine={message.mine} onPress={requestTranscript} />
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
    requestTranscript,
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
  const [preparingPhoto, setPreparingPhoto] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const items = messagesFor(threadId ?? '');
  const rows = useMemo(() => groupMessages(items), [items]);

  const handleRecorded = useCallback(
    async (uri: string, durationMs: number) => {
      if (!threadId) return;
      await sendVoiceNote(threadId, uri, durationMs);
    },
    [sendVoiceNote, threadId],
  );
  const recorder = useVoiceRecorder(handleRecorded);
  const recording = recorder.status !== 'idle';
  const busy = recording || preparingPhoto;

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
    if (!inRange) return 'Text relays through nearby phones · media waits for a direct connection';
    return '1:1 · Bluetooth';
  }, [inRange, inRangeCount, isAlertThread, isGroup, memberIds.length]);

  const groupMembers = useMemo(() => {
    const members = thread?.memberIds ?? [];
    if (!isGroup || isAlertThread || members.length === 0) return [];
    return members.map((id) => {
      const peer = noredPeers.find((item) => item.id === id);
      const profile = avatarForPeer(id, identity, noredPeers);
      const label = id === identity.id ? 'You' : (thread?.memberNames[id] ?? peer?.name ?? 'Member');
      const memberInRange =
        id === identity.id || Boolean(peer?.identityConfirmed);
      return { id, label, profile, memberInRange, peer };
    });
  }, [identity, isAlertThread, isGroup, noredPeers, thread?.memberIds, thread?.memberNames]);

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

  const attachPhoto = useCallback(async () => {
    if (!threadId || busy) return;
    let picked: Awaited<ReturnType<typeof pickPhotoAsync>>;
    try {
      picked = await pickPhotoAsync();
    } catch (error) {
      Alert.alert(
        'Could not open photos',
        error instanceof Error ? error.message : 'The photo library could not be opened.',
      );
      return;
    }
    if (!picked) return;
    setPreparingPhoto(true);
    try {
      await sendImage(threadId, picked.uri, picked.width, picked.height);
    } catch (error) {
      Alert.alert(
        'Photo not sent',
        error instanceof Error ? error.message : 'The photo could not be prepared.',
      );
    } finally {
      setPreparingPhoto(false);
    }
  }, [busy, sendImage, threadId]);

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
      {groupMembers.length > 0 ? (
          <View style={styles.groupHeader}>
            <AvatarStack
              members={groupMembers.map((member) => ({
                id: member.id,
                name: member.label,
                peerId: member.id,
                icon: member.profile.icon,
                color: member.profile.colorIndex,
              }))}
              size={36}
            />
            <Text numberOfLines={1} style={styles.memberNames}>
              {groupMembers.map((member) => member.label).join(', ')}
            </Text>
            <View style={styles.groupMeta}>
              <Text style={styles.groupSubtitle}>{subtitle}</Text>
              <Pressable
                onPress={() => setEmergency((v) => !v)}
                style={({ pressed }) => [styles.emergencyToggle, emergency && styles.emergencyToggleOn, pressed && styles.pressed]}>
                <AlertsIcon color={emergency ? signal.white : signal.slate} size={14} />
                <Text style={[styles.emergencyLabel, emergency && styles.emergencyLabelOn]}>Emergency</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.threadBar}>
            <Text style={styles.subtitle}>{subtitle}</Text>
          </View>
        )}

        {!isGroup && inRange && !savedContact ? (
          <Pressable onPress={addContact} style={{ padding: 12 }}><Text style={{ color: signal.blue, textAlign: 'center' }}>Save contact</Text></Pressable>
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
            rows.map(({ message, first, last }) => {
              const senderProfile = avatarForPeer(message.senderId, identity, noredPeers);
              const pathLabel = message.path?.map((id) => {
                if (id === identity.id) return 'You';
                const peer = noredPeers.find((item) => item.id === id);
                if (peer?.name) return peer.name;
                if (contacts[id]?.name) return contacts[id].name;
                if (id === message.senderId) return message.sender;
                if (id === thread?.peerId) return thread.name;
                return `Peer ${id.slice(0, 8)}`;
              }).join(' → ');
              return (
              <View key={message.id} style={[styles.rowWrap, message.mine ? styles.rowWrapMine : styles.rowWrapTheirs, first && styles.rowSpaced]}>
                {!message.mine ? (
                  <View style={styles.avatarSlot}>
                    {last ? (
                      <Avatar
                        color={senderProfile.colorIndex}
                        icon={senderProfile.icon}
                        name={message.sender}
                        peerId={message.senderId}
                        size={26}
                      />
                    ) : null}
                  </View>
                ) : null}
                <View style={[styles.column, message.mine && styles.columnMine]}>
                  {!message.mine && first ? <Text style={styles.sender}>{message.sender}</Text> : null}
                  <Bubble
                    message={message}
                    onRequestTranscript={requestTranscript}
                    showTail={last}
                    threadId={threadId}
                  />
                  {pathLabel ? (
                    <Text
                      numberOfLines={2}
                      style={[styles.path, message.mine && styles.pathMine]}>
                      Path: {pathLabel}
                    </Text>
                  ) : null}
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
            );
            })
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
          {recording ? (
            <View style={styles.recordingRow}>
              <Pressable
                accessibilityLabel="Discard voice note"
                accessibilityRole="button"
                disabled={recorder.status === 'saving'}
                onPress={recorder.cancel}
                style={({ pressed }) => [styles.recordingCancel, pressed && styles.pressed]}>
                <Text style={styles.recordingCancelText}>Cancel</Text>
              </Pressable>
              <View style={styles.recordingStatus}>
                {recorder.status === 'recording' ? (
                  <View style={styles.recordingDot} />
                ) : (
                  <ActivityIndicator color={signal.blue} size="small" />
                )}
                <Text style={styles.recordingTime}>
                  {recorder.status === 'starting'
                    ? 'Starting…'
                    : recorder.status === 'saving'
                      ? 'Sending…'
                      : `${formatDuration(recorder.durationMs)} / ${formatDuration(MAX_VOICE_SECONDS * 1000)}`}
                </Text>
              </View>
              <IconButton
                disabled={recorder.status !== 'recording'}
                onPress={recorder.send}
                tone="outline">
                <SendIcon color={signal.blue} size={16} />
              </IconButton>
            </View>
          ) : (
            <View style={styles.composerRow}>
              <IconButton
                accessibilityLabel="Send a photo"
                disabled={busy}
                onPress={() => void attachPhoto()}
                tone="outline">
                {preparingPhoto ? (
                  <ActivityIndicator color={signal.blue} size="small" />
                ) : (
                  <ImageIcon color={signal.blue} size={18} />
                )}
              </IconButton>
              <View style={styles.inputPill}>
                <TextInput
                  accessibilityLabel="Message"
                  editable={!busy}
                  maxLength={emergency && !isAlertThread ? ALERT_MAX_BODY : 2000}
                  multiline
                  onChangeText={setDraft}
                  placeholder={
                    preparingPhoto
                      ? 'Preparing photo…'
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
              </View>
              {draft.trim() ? (
                <IconButton accessibilityLabel="Send" onPress={send} tone="outline">
                  <SendIcon color={signal.blue} size={16} />
                </IconButton>
              ) : (
                <IconButton
                  accessibilityLabel="Record a voice note"
                  disabled={busy}
                  onPress={recorder.start}
                  tone="outline">
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
  groupHeader: {
    alignItems: 'center',
    borderBottomColor: signal.fog,
    borderBottomWidth: 1,
    gap: 8,
    paddingBottom: 14,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  memberNames: {
    color: signal.ink,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
    maxWidth: '100%',
    textAlign: 'center',
  },
  groupMeta: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
  },
  groupSubtitle: {
    color: signal.slate,
    fontSize: 13,
    lineHeight: 18,
  },
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
  mediaStatusFailed: { color: '#b42318' },
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
  audioColumn: { gap: 6, maxWidth: 260 },
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
  transcriptBelowTheirs: { alignSelf: 'flex-start', marginLeft: 2 },
  transcriptBelowMine: { alignSelf: 'flex-end', marginRight: 2 },
  transcriptBlock: { gap: 2, marginTop: 2, maxWidth: 260 },
  transcriptTextMine: { textAlign: 'right' },
  transcriptAction: { marginTop: 2 },
  transcriptActionText: { color: signal.blue, fontSize: 12, fontWeight: '600' },
  transcriptMeta: { color: signal.slate, fontSize: 12, marginTop: 2 },
  transcriptText: { color: signal.slate, fontSize: 13, lineHeight: 18 },
  translationLabel: {
    color: signal.slate,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 4,
    opacity: 0.75,
    textTransform: 'uppercase',
  },
  translationText: { color: signal.ink, fontSize: 13, fontStyle: 'italic', lineHeight: 18 },
  transcriptDebug: { color: signal.slate, fontSize: 11, lineHeight: 15, marginTop: 2 },
  metaRow: { alignItems: 'center', flexDirection: 'row', gap: 5, marginLeft: 4, marginTop: 4 },
  metaRowMine: { marginLeft: 0, marginRight: 4 },
  metaDot: { color: signal.slate, fontSize: 12 },
  time: { color: signal.slate, fontSize: 12 },
  status: { color: signal.slate, fontSize: 12 },
  path: { color: signal.slate, fontSize: 11, lineHeight: 15, marginLeft: 4, marginTop: 4 },
  pathMine: { marginLeft: 0, marginRight: 4, textAlign: 'right' },
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
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
});
