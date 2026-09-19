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
- Background / locked-screen mesh operation (foreground-only, see §4.1)
- Push notifications (no server; alerts are local notifications only)

## 3. Functional Requirements

### 3.1 Peer Discovery & Network View
- Auto-discover peers via BLE advertise + scan, no manual pairing.
- Two-phase discovery: the advertisement carries only the service UUID, since iOS cannot set manufacturer-specific data. Device ID and display name are read from the `Identity` characteristic after connecting.
- Device list shows: display name, device ID (short hash), RSSI/signal bucket, last-seen timestamp, hop count (direct vs relayed).
- Presence TTL: mark stale after 30s no-seen, remove after 120s.
- Manual: rename self, rescan button.
- Max tested target MVP: 4-6 concurrent GATT links per device (platform ceiling), up to 8 peers held in the list.
- App must be foregrounded for MVP operation (see §4.1).

Acceptance:
- [ ] Two phones with app open see each other <5s at <10m, no pairing dialog.
- [ ] iPhone and Android discover each other, not only same-platform pairs.

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
- Cap MVP: 8 members / group, 20 groups stored locally. Note only 4-6 members are ever directly linked at once (§4.1); the rest are reached by relay and store-and-forward.
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

Budget assumption: BLE GATT sustains roughly 5-20 KB/s. Every limit below is derived from that ceiling.

| Type | Limit MVP | Behavior |
|------|-----------|----------|
| Text | 2000 chars | Plaintext, no markdown except line breaks |
| Audio | 60s max, Opus 16kbps mono (~120KB) | Record in-app, waveform UI, tap-to-play |
| Image | 1024px max side, JPEG 0.6, <200KB | Auto-compress before send, tap-to-fullscreen |
| Files | Post-MVP | 2MB over BLE is ~3 min; deferred until a fast path exists (§4.3) |

- All messages schema: `{ id, senderId, threadId, type, payloadRef, ts, ttlHops, hash }`
- Chunking: any payload larger than one BLE frame is chunked. Frame payload = `negotiatedMTU - 3`, target 180 bytes, floor 20 bytes if negotiation fails.
- Chunk header: `{ msgId, seq, total, crc }`. Reassembly timeout 10s, then NACK resend.
- TTL: default 5 hops, emergency 10 hops. Dedup by `id` cache (last 500).

Acceptance:
- [ ] 200KB image transfers <30s phone-to-phone at <5m.
- [ ] 60s voice note transfers <30s phone-to-phone at <5m.

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

### 4.0 Transport Decision
Single transport for MVP: **raw BLE GATT, dual-role**. Every device simultaneously runs a GATT server (peripheral: advertises the service UUID, serves characteristics) and a GATT client (central: scans, connects, subscribes).

`MultipeerConnectivity` and Nearby Connections are both rejected: the former is Apple-only, the latter Android-only, and they cannot talk to each other. Neither can carry a mixed iOS/Android mesh, so raw GATT is the only common denominator.

- Service UUID: one custom 128-bit UUID, identical constant on both platforms.
- Characteristics: `Identity` (read), `Inbox` (write), `Outbox` (notify).
- Topology: flood mesh with store-and-forward. No routing table for MVP.
- Discovery interval: advertise 200ms, scan duty-cycled for battery (scan 3s / sleep 2s).
- Security MVP: static pre-shared event key + per-device ID. Post-MVP: Noise / E2EE per DM.

### 4.1 Platform Constraints (hard)
| Behavior | iOS | Android |
|---|---|---|
| Service UUID in background ads | Overflow area, **iOS-visible only** | Fully visible |
| Local name / manufacturer data in ads | Not settable | Settable |
| Background scanning | Must specify service UUIDs | Allowed, throttled |
| Negotiated ATT MTU | ~185 bytes | up to 517 bytes |

Consequences:
- Chunk size is set by the iOS MTU floor (~180 bytes), never Android's 517.
- Device ID cannot ride in the advertisement, hence two-phase discovery (§3.1).
- A backgrounded iPhone is invisible to Android scanners. MVP is foreground-only; background modes are declared in config but not relied on for the demo.

### 4.2 Implementation Split
- Central role: `react-native-ble-plx` (mature, covers both platforms).
- Peripheral role: one local Expo module wrapping `CBPeripheralManager` (Swift) and `BluetoothGattServer` (Kotlin). No maintained RN library covers GATT server on both platforms.
- All mesh logic (flood, dedup, TTL, queue, chunk reassembly) lives in TypeScript above a `MeshTransport` interface and stays radio-agnostic. An in-memory fake transport implements the same interface for simulator development and tests.

### 4.3 Post-MVP Fast Path
- `MultipeerConnectivity` as an opportunistic iOS-to-iOS transport; AWDL gives MB/s and restores 500KB images plus file support.
- BLE L2CAP channels (`createL2capChannel` on Android API 29+, `publishL2CAPChannel` on iOS 11+) for bulk transfer.
- Both slot in as additional `MeshTransport` implementations. A node running two transports at once bridges between them.

## 5. Storage & Data
- Local only: SQLite (messages, peers, groups) + file store (audio/image blobs).
- Libraries: `expo-sqlite`, `expo-file-system` for blobs, `expo-secure-store` + `expo-crypto` for the identity keypair.
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
0. Expo dev build installed on all 4 devices + `MeshTransport` interface + in-memory fake transport
1. Mesh logic against the fake transport: flood, dedup, TTL, 1:1 text, UI shell (simulator only, no radios)
2. Real BLE transport: GATT server module + `ble-plx` central, then discover + device list + 1:1 text on hardware
3. Mesh relay + broadcast `EMERGENCY`
4. Groups + offline queue + persistence
5. Audio/image send + chunking
6. Local transcribe + translate

Steps 0-1 are radio-free, so a native-side bug can never block UI or mesh-logic progress.

## 9. Test Plan (Demo)

Device inventory: 3x iOS + 1x Android. All apps foregrounded, airplane mode on, Bluetooth on.

- **Cross-platform DM** — iPhone to Android: discover, DM text, voice, image.
- **Cross-platform relay** — proves multi-hop and interop in a single test:

```
iPhone A  ──BLE──  Android B  ──BLE──  iPhone C
        (A and C out of direct range)
```

  A broadcasts `EMERGENCY`, C receives via B in <10s.
- **Offline queue** — 4th iPhone out of range, A sends, walk it back into range, message flushes without resend.
- **On-device AI** — airplane mode transcription + translation.

Fallback if the GATT server module slips: an all-iOS mesh still satisfies every test except the two cross-platform ones.

## 10. Bluetooth Games

### Purpose
Leverage the peer-to-peer Bluetooth mesh to enable low-bandwidth multiplayer games during downtime or in scenarios with no internet—engaging, stress-relieving, icebreaker, or morale-boost activities for event attendees or first responders.

### MVP Game Proposals

- **"Mesh Ping"**: Simple latency/mesh reliability checker—users attempt to "pass" a ping or virtual baton around the mesh, with a leaderboard showing round-trip timing and how many hops it took. Visualizes mesh health in a fun way.
- **Trivia Relay**: Group or peer-to-peer quiz questions, where questions and answers are relayed with acknowledgments. Multiple choice or true/false, results shown when mesh is rejoined if temporarily offline.
- **Drawing Telephone**: Each peer receives and modifies a doodle; the result is shown at the end. Low-bandwidth by sending compressed bitmap or vector deltas.
- **Word Chain**: Each participant adds a word to a story or chain (e.g., classic "word association"), relayed through the mesh and reconstructed as a group activity.
- **Find the Beacon**: One user acts as "it"; others hunt by RSSI signal strength as a hot/cold indicator, useful as both a game and a test of mesh proximity/distance features.

### Requirements

- All game messages/operations happen offline over mesh/BLE, no central server.
- Minimal data per move; broadcast or specifically relayed as required by game logic.
- Per-move payload should fit in a single BLE frame (<=180 bytes) so games never need chunking.
- Works across platforms (iOS + Android) with the same mesh engine.
- Game logic designed to tolerate out-of-order, delayed, or repeated packets.
- Participation is opt-in, with dedicated "Games" tab or button to avoid accidental joins.

### Stretch/Ideas

- Support custom community mini-games via simple scripting or templates.
- Allow lightweight badge/achievement system for game participation, stored locally.
- Games should pause and resume cleanly if connection drops or app backgrounded.

### Out of Scope (for MVP)

- Real-time, low-latency action games.
- Games requiring heavy assets or large visuals.

---
