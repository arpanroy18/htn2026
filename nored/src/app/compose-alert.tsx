import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AlertsIcon } from '@/components/signal/icons';
import { Chip, OutlinedButton, RowPress } from '@/components/signal/ui';
import { useAlerts } from '@/mesh/AlertContext';
import { ALERT_MAX_BODY, type Severity, severityTone } from '@/mesh/alertStore';
import { signal } from '@/theme/signal';

const severities: Severity[] = ['INFO', 'HELP', 'DANGER'];

export default function ComposeAlertScreen() {
  const { broadcastAlert } = useAlerts();
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<Severity>('HELP');
  const [location, setLocation] = useState(true);
  const [sending, setSending] = useState(false);
  const insets = useSafeAreaInsets();

  const broadcast = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    const result = await broadcastAlert({
      body: text,
      severity,
      hasLocation: location,
    });
    setSending(false);
    if (result.ok) {
      router.back();
      return;
    }
    Alert.alert('Could not broadcast', result.error);
  };

  return (
    <SafeAreaView edges={['bottom']} style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top + 56}
        style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <AlertsIcon color={signal.ink} size={22} />
          </View>
          <View style={styles.heroCopy}>
            <Text style={styles.heroTitle}>Emergency broadcast</Text>
          </View>
        </View>

        <Text style={styles.label}>SEVERITY</Text>
        <View style={styles.row}>
          {severities.map((item) => {
            const tone = severityTone(item);
            const selected = severity === item;
            const accent =
              tone === 'yellow' ? signal.yellow : tone === 'orange' ? signal.orange : signal.red;
            return (
              <RowPress
                key={item}
                onPress={() => setSeverity(item)}
                style={[styles.seg, selected && { borderColor: accent, borderWidth: 1.5 }]}>
                <Text style={[styles.segText, selected && { color: accent }]}>{item}</Text>
              </RowPress>
            );
          })}
        </View>

        <View style={styles.labelRow}>
          <Text style={styles.label}>MESSAGE</Text>
          <Text style={styles.label}>{body.length} / {ALERT_MAX_BODY}</Text>
        </View>
        <TextInput
          maxLength={ALERT_MAX_BODY}
          multiline
          onChangeText={setBody}
          placeholder="What should everyone nearby know?"
          placeholderTextColor={signal.slate}
          scrollEnabled
          style={styles.input}
          value={body}
        />

        <View style={styles.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.toggleTitle}>Attach approximate location</Text>
            <Text style={styles.toggleBody}>Shown as a tag on the alert card.</Text>
          </View>
          <Switch
            ios_backgroundColor={signal.fog}
            onValueChange={setLocation}
            thumbColor={signal.white}
            trackColor={{ false: signal.fog, true: signal.blue }}
            value={location}
          />
        </View>

        <Text style={styles.label}>PREVIEW</Text>
        <View style={styles.preview}>
          <View style={styles.previewTop}>
            <Chip label={severity} tone={severityTone(severity)} />
            <Text style={styles.previewMeta}>now · 0 hops</Text>
          </View>
          <Text style={styles.previewBody}>{body || 'Your message will preview here.'}</Text>
          {location ? <Text style={styles.previewLocation}>Location attached</Text> : null}
        </View>

        <OutlinedButton
          disabled={!body.trim() || sending}
          label={sending ? 'Broadcasting…' : 'Broadcast to mesh'}
          onPress={() => void broadcast()}
        />
      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { backgroundColor: signal.paper, flex: 1 },
  body: { gap: 12, padding: 24 },
  hero: {
    alignItems: 'center',
    backgroundColor: signal.sky,
    borderRadius: 16,
    flexDirection: 'row',
    gap: 14,
    padding: 20,
  },
  heroIcon: {
    alignItems: 'center',
    backgroundColor: signal.white,
    borderRadius: 12,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  heroCopy: {},
  heroTitle: { color: signal.ink, fontSize: 20, fontWeight: '800', lineHeight: 24 },
  label: { color: signal.slate, fontSize: 11, fontWeight: '600', letterSpacing: 1.4 },
  labelRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  row: { flexDirection: 'row', gap: 8 },
  seg: {
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    paddingVertical: 12,
  },
  segOn: { borderColor: signal.blue, borderWidth: 1.5 },
  segText: { color: signal.slate, fontSize: 13, fontWeight: '600', textAlign: 'center' },
  segTextOn: { color: signal.blue },
  input: {
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 16,
    borderWidth: 1,
    color: signal.ink,
    fontSize: 16,
    lineHeight: 24,
    // Bounded: a 280-char body scrolls inside the box instead of pushing the button off-screen.
    maxHeight: 168,
    minHeight: 120,
    padding: 16,
    textAlignVertical: 'top',
  },
  toggleRow: {
    alignItems: 'center',
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 16,
  },
  toggleTitle: { color: signal.ink, fontSize: 15, fontWeight: '600' },
  toggleBody: { color: signal.slate, fontSize: 13, lineHeight: 18, marginTop: 4 },
  preview: {
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    padding: 20,
  },
  previewTop: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  previewMeta: { color: signal.slate, fontSize: 12 },
  previewBody: { color: signal.ink, fontSize: 16, lineHeight: 23 },
  previewLocation: { color: signal.slate, fontSize: 13 },
});
