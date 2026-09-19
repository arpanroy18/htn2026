# Nored — SPECS

## 1. Overview
P2P messaging over Bluetooth for no-signal / low-signal environments.
No servers, no cell, no Wi-Fi required. Devices form local mesh, store-and-forward messages.

Target: iOS + Android. Hackathon MVP: 2+ phones chatting offline via Bluetooth.

## 2. Goals / Non-Goals
**Goals:**
- Discover nearby peers offline
- 1:1, group, and emergency broadcast messaging offline
- Send text, voice, image offline
- On-device transcription + translation for audio

**Non-Goals (MVP):**
- Internet fallback / cloud sync
- Phone-number / account system
- File types beyond image/audio/text
- Full E2EE (best-effort only for MVP)

## 3. Functional Requirements

### 3.1 Peer Discovery & Network View
- Auto-discover peers via BLE advertise + scan, no manual pairing.
- Device list shows: display name, device ID (short hash), RSSI/signal bucket, last-seen timestamp, hop count (direct vs relayed).
- Presence TTL: mark stale after 30s no-seen, remove after 120s.
- Manual: rename self, rescan button.
- Max tested target MVP: 10-15 concurrent peers in range.

Acceptance:
- [ ] Two phones with app open see each other <5s at <10m, no pairing dialog.

### 3.2 Broadcast Channels (Emergency Alerts)
- Pre-seeded channel: `EMERGENCY` (listen-only toggle + high-priority notify).
- Any user can broadcast to all reachable nodes (flood with dedup).
- Emergency messages: bypass mute, trigger vibration + banner + persistent inbox pin.
- Rate-limit: 1 broadcast / 5s per device to prevent flood.
- Payload: 280-char text + optional location + severity tag (`INFO / HELP / DANGER`).

Acceptance:
- [ ] Broadcast from A reaches C via B relay with <10s latency in 3-node chain.

### 3.3 Group Chats
- Create group: name + invite in-range peers. Group ID = `uuidv4`.
- Membership propagated via mesh; no host required after creation.
- Cap MVP: 8 members / group, 20 groups stored locally.
- Show delivery state per message: `sent / relayed / seen` (best-effort).

Acceptance:
- [ ] Any member can send, all in-range members receive in order per-sender.

### 3.4 Direct Messaging (1:1)
- Peer ID = persistent pubkey-derived ID stored on device (no phone number).
- Chat opens from device list via tap.
- Offline queue: messages queued if peer out of range, auto-flush on rediscover.
- History persisted locally (SQLite), 1000 msgs / thread cap for MVP.

Acceptance:
- [ ] A sends to offline B, B receives on next contact without resend.

### 3.5 Message Types
| Type | Limit MVP | Behavior |
|------|-----------|----------|
| Text | 2000 chars | Plaintext, no markdown except line breaks |
| Audio | 60s max, Opus/M4A compressed | Record in-app, waveform UI, tap-to-play |
| Image | 1280px max side, JPEG 0.7, <500KB | Auto-compress before send, tap-to-fullscreen |

- All messages schema: `{ id, senderId, threadId, type, payloadRef, ts, ttlHops, hash }`
- Chunking: split >20KB payloads into BLE chunks with reassembly + CRC.
- TTL: default 5 hops, emergency 10 hops. Dedup by `id` cache (last 500).

Acceptance:
- [ ] 500KB image transfers <30s phone-to-phone at <5m.

### 3.6 On-Device AI: Transcription + Translation
- Runs fully offline, no network calls.
- Transcribe voice messages to text on receive (and pre-send preview).
- Translate: auto-detect + render to recipient locale, original kept side-by-side.
- Model target: Whisper-tiny / small quantized (CoreML / TFLite / ONNX), lazy-downloaded pre-event, cached on device.
- Fallback: if model missing or low-RAM, show audio-only with `transcript unavailable` badge.
- Privacy: raw audio never leaves device except as user-sent message.

Acceptance:
- [ ] 15s voice note transcribes <5s on-device, airplane mode on.
- [ ] EN <-> ES/FR translation renders inline without internet.

## 4. Mesh / Transport
- Transport: BLE 5.0 (iOS: MultipeerConnectivity + BLE, Android: Nearby Connections / BLE L2CAP).
- Topology: flood mesh with store-and-forward. No routing table for MVP.
- Discovery interval: advertise 200ms, scan duty-cycled for battery (scan 3s / sleep 2s).
- Security MVP: static pre-shared event key + per-device ID. Post-MVP: Noise / E2EE per DM.
- Battery guard: background mode low-power advertise only.

## 5. Storage & Data
- Local only: SQLite (messages, peers, groups) + file store (audio/image blobs).
- Schema keys: `devices(id, name, lastSeen, rssi)`, `threads(id, type, members)`, `messages(id, threadId, senderId, type, body, ts, status)`.
- No account. Identity = keypair generated on first launch. Name editable.
- Clear-data button in settings.

## 6. UX Requirements
- 3 tabs: `Nearby | Chats | Alerts`
- Nearby: list sorted by RSSI, tap = DM, long-press = invite to group.
- Chats: unified DM + groups, unread dot, queued/out-of-range badge.
- Composer: text field + mic + image picker + emergency toggle in group/alerts.
- Offline indicator persistent: `OFFLINE MESH • n peers`.
- Permissions onboarding: Bluetooth + mic + photos + notifications in 1 screen.

## 7. Edge Cases
- Duplicate / looped packets → drop by ID cache.
- Peer name collision → display `Name#abcd`.
- Out-of-order chunks → 10s reassembly timeout, then NACK resend.
- Storage full → evict oldest blobs first, keep text.
- App killed → queue persists, flush on relaunch.

## 8. MVP Build Order
1. BLE discover + device list + 1:1 text
2. Mesh relay + broadcast `EMERGENCY`
3. Groups + offline queue + persistence
4. Audio/image send
5. Local transcribe + translate

## 9. Test Plan (Demo)
- 2 phones, airplane mode + BT on: discover, DM text, voice, image.
- 3 phones in line (A—B—C, A/C out of direct range): A broadcasts, C receives via B.
- Airplane mode transcription + translation demo.
