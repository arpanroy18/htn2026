# Mesh validation and physical acceptance

Physical test date: not performed. Android device list was empty; iOS listed only shutdown simulators. No real-device PASS is claimed.

The never-met-recipient scenario is superseded by the agreed nearby-first saved-contact workflow. Groups have no live membership implementation and are outside this change.

## Automated and build results

| Check | Result |
|---|---|
| Unit/integration tests | PASS — 30 tests, including existing chat/media tests |
| TypeScript | PASS |
| ESLint | PASS |
| iOS / Android / web production bundle export | PASS |
| Android development APK | PASS — `:app:assembleDebug`, SQLite autolinked |
| iOS simulator development app | PASS — Debug simulator build, SQLite included |
| Physical BLE acceptance | NOT TESTED — no physical devices attached |

Run `npm test`, `npm run lint`, and `npx tsc --noEmit` from `nored/`. Router tests use simulated BLE, fake time, and both memory and real on-disk SQLite adapters. The SQLite test closes and reopens the database file; it also checks rollback and idempotent migration.

## Physical acceptance

Each item below is NOT TESTED on physical devices. Group behavior is not implemented; media relay is intentionally out of scope. Native framing supports only its existing behavior.

### A. Discovery

- **NOT TESTED** — Two nearby phones running Nored discover each other automatically.
- **NOT TESTED** — No manual OS Bluetooth pairing is required.
- **NOT TESTED** — Cross-platform Android ↔ iOS discovery works.
- **NOT TESTED** — Discovery generally occurs within 5 seconds at close range.
- **NOT TESTED** — Device appears only once in the nearby list.
- **NOT TESTED** — RSSI/signal information updates without creating duplicate peers.
- **NOT TESTED** — Last-seen timestamp updates.
- **NOT TESTED** — Peer becomes stale/disappears according to current presence timeout rules.
- **NOT TESTED** — Turning Bluetooth off updates app state without crashing.
- **NOT TESTED** — Turning Bluetooth back on resumes discovery.
- **NOT TESTED** — Leaving and returning to Nored does not create duplicate scanners/advertisers.
- **NOT TESTED** — App does not create repeated duplicate connections to the same peer.

### B. Direct connection

- **NOT TESTED** — Android can establish a usable BLE connection with iOS.
- **NOT TESTED** — iOS can exchange application packets with Android.
- **NOT TESTED** — Direct messaging works in both directions.
- **NOT TESTED** — Existing same-platform communication still works if it previously worked.
- **NOT TESTED** — Peer disconnect is detected.
- **NOT TESTED** — Peer reconnect works without restarting the app.
- **NOT TESTED** — Disconnect during a send does not crash either app.
- **NOT TESTED** — Reconnecting does not duplicate previously delivered messages.

### C. Direct text messaging

- **NOT TESTED** — A can send text directly to B.
- **NOT TESTED** — B receives the exact text.
- **NOT TESTED** — B can reply to A.
- **NOT TESTED** — Ten consecutive text messages succeed.
- **NOT TESTED** — Rapid consecutive sends do not corrupt message boundaries.
- **NOT TESTED** — Messages appear only once.
- **NOT TESTED** — Existing chat history still works.
- **NOT TESTED** — Current timestamps still display correctly.
- **NOT TESTED** — Existing message ordering behavior is preserved or improved.
- **NOT TESTED** — Delivery state does not falsely say "Delivered" before destination receipt.

### D. Framing / chunking

- **NOT TESTED** — Packets larger than one BLE write are chunked.
- **NOT TESTED** — Chunks reassemble into exactly one application packet.
- **NOT TESTED** — Out-of-order chunk handling works if supported by current transport.
- **NOT TESTED** — Duplicate chunks do not produce duplicate application messages.
- **NOT TESTED** — Partial assemblies time out cleanly.
- **NOT TESTED** — Failed/incomplete transfers do not appear as complete messages.
- **NOT TESTED** — Existing image/audio chunking still works if already implemented.

### E. Store-and-forward: one relay

- **NOT TESTED** — A stores the message locally.
- **NOT TESTED** — A forwards it to B when B is encountered.
- **NOT TESTED** — B accepts and persists it even though B is not the destination.
- **NOT TESTED** — A and B can disconnect.
- **NOT TESTED** — B retains the packet after disconnect.
- **NOT TESTED** — Later B discovers C.
- **NOT TESTED** — B automatically forwards the packet to C.
- **NOT TESTED** — C receives the original message.
- **NOT TESTED** — C displays it exactly once.
- **NOT TESTED** — A does not need to be connected during B → C delivery.

### F. Delayed delivery

- **NOT TESTED** — Recipient can be completely unavailable when message is created.
- **NOT TESTED** — Message remains queued across peer changes.
- **NOT TESTED** — An intermediary can carry the packet for a meaningful delay.
- **NOT TESTED** — Delivery resumes automatically when an eligible encounter happens.
- **NOT TESTED** — User does not need to manually press resend.
- **NOT TESTED** — App navigation does not delete queued packets.
- **NOT TESTED** — App restart preserves queued packets if persistence is implemented.

### G. Multi-hop forwarding

- **NOT TESTED** — D receives A's message.
- **NOT TESTED** — No continuous A→D path ever exists.
- **NOT TESTED** — Each relay persists the packet long enough to forward it.
- **NOT TESTED** — hopCount increases correctly.
- **NOT TESTED** — packetId remains unchanged.
- **NOT TESTED** — originId remains unchanged.
- **NOT TESTED** — payload remains unchanged.
- **NOT TESTED** — hop limit is respected.

### H. Deduplication

- **NOT TESTED** — D displays one message.
- **NOT TESTED** — Duplicate packet is recognized by packet ID.
- **NOT TESTED** — Duplicate packet does not trigger duplicate notification.
- **NOT TESTED** — Duplicate broadcast does not create multiple alert cards.
- **NOT TESTED** — Duplicate relay does not reset delivery metadata incorrectly.
- **NOT TESTED** — Duplicate ACKs are safe/idempotent.

### I. Inventory synchronization

- **NOT TESTED** — Peers exchange information about packets they already possess.
- **NOT TESTED** — Peer does not resend every stored packet unnecessarily.
- **NOT TESTED** — Missing packets are identified correctly.
- **NOT TESTED** — Already-known packets are skipped.
- **NOT TESTED** — Partial inventory exchange failure does not corrupt the packet store.
- **NOT TESTED** — Reconnect can retry synchronization cleanly.
- **NOT TESTED** — Inventory control messages themselves do not appear in user chats.

### J. TTL / hop limit

- **NOT TESTED** — Normal packet stops forwarding at configured hop limit.
- **NOT TESTED** — Emergency packet may use a larger hop limit.
- **NOT TESTED** — hopCount never decreases.
- **NOT TESTED** — Packet at its hop limit can still be consumed by its final destination if already received.
- **NOT TESTED** — Packet at its hop limit is not forwarded further.
- **NOT TESTED** — A looping topology does not create infinite transmissions.

### K. Expiry

- **NOT TESTED** — Expired packets are not forwarded.
- **NOT TESTED** — Expired packets are eventually cleaned from storage.
- **NOT TESTED** — Expired broadcasts do not reappear after reconnect.
- **NOT TESTED** — An expired direct message is not unexpectedly delivered much later.
- **NOT TESTED** — Expiry does not delete already-delivered chat history unless explicitly intended.

### L. Priority

- **NOT TESTED** — Emergency packet transfers first.
- **NOT TESTED** — Direct text transfers before lower-priority media.
- **NOT TESTED** — Priority queue does not starve packets forever under normal conditions.
- **NOT TESTED** — Existing emergency UI still works.
- **NOT TESTED** — Emergency packet remains deduplicated like normal packets.

### M. ACK semantics

- **NOT TESTED** — Relay receipt does not count as final delivery.
- **NOT TESTED** — Destination generates end-to-end ACK.
- **NOT TESTED** — ACK can itself travel store-and-forward.
- **NOT TESTED** — Sender eventually receives ACK.
- **NOT TESTED** — Sender marks original message `Delivered`.
- **NOT TESTED** — Duplicate ACK does not break state.
- **NOT TESTED** — ACK for unknown packet is handled safely.
- **NOT TESTED** — Current UI does not falsely represent relay receipt as final delivery.
- **NOT TESTED** — Code structure clearly separates transport ACK from future destination ACK.

### N. Persistence

- **NOT TESTED** — Packet store survives normal navigation.
- **NOT TESTED** — Queued message survives transport disconnect.
- **NOT TESTED** — Relay packet survives source disconnect.
- **NOT TESTED** — Existing chat history persistence still works.
- **NOT TESTED** — Restart does not corrupt packet records.
- **NOT TESTED** — Restart does not duplicate packets in chat history.
- **NOT TESTED** — Packet cleanup does not remove normal chat history accidentally.

### O. Broadcast

- **NOT TESTED** — Direct neighbor receives broadcast.
- **NOT TESTED** — Relay forwards broadcast.
- **NOT TESTED** — Node two or more hops away receives broadcast.
- **NOT TESTED** — Each user sees broadcast once.
- **NOT TESTED** — Broadcast obeys TTL.
- **NOT TESTED** — Broadcast obeys expiry.
- **NOT TESTED** — Broadcast does not loop forever.
- **NOT TESTED** — Existing emergency broadcast functionality still works.

### P. Groups

- **NOT TESTED** — Existing group creation still works.
- **NOT TESTED** — Existing membership display still works.
- **NOT TESTED** — Directly connected group members receive messages.
- **NOT TESTED** — Group packet can be carried through a non-destination relay if architecture permits.
- **NOT TESTED** — Group members do not receive duplicate messages.
- **NOT TESTED** — Store-and-forward changes do not break existing group history.

### Q. Existing media

- **NOT TESTED** — Direct image sending still works.
- **NOT TESTED** — Direct audio sending still works.
- **NOT TESTED** — Existing compression still works.
- **NOT TESTED** — Existing playback still works.
- **NOT TESTED** — Media transfer does not block emergency text indefinitely.
- **NOT TESTED** — Store-and-forward metadata does not corrupt binary payloads.
- **NOT TESTED** — Partial media transfer fails cleanly.

### R. Identity

- **NOT TESTED** — Persistent device ID does not change unexpectedly.
- **NOT TESTED** — Store-and-forward preserves original sender identity.
- **NOT TESTED** — Relay is not shown as message author.
- **NOT TESTED** — Display-name collisions remain disambiguated.
- **NOT TESTED** — Existing signatures/security metadata remain valid if present.

### S. Offline requirement

- **NOT TESTED** — Discovery works.
- **NOT TESTED** — Direct messaging works.
- **NOT TESTED** — Relay messaging works.
- **NOT TESTED** — Store-and-forward works.
- **NOT TESTED** — Broadcast works.
- **NOT TESTED** — Existing offline app features still work.
- **NOT TESTED** — No hidden Internet/backend dependency is required for core messaging.

### T. Stability

- **NOT TESTED** — 10 direct messages can be sent without crash.
- **NOT TESTED** — 10 queued/relayed messages can be processed without crash.
- **NOT TESTED** — Repeated peer enter/leave cycles do not crash.
- **NOT TESTED** — Bluetooth toggle does not crash.
- **NOT TESTED** — Malformed packet does not crash.
- **NOT TESTED** — Duplicate packet does not crash.
- **NOT TESTED** — Disconnect during synchronization does not crash.
- **NOT TESTED** — Reconnect can resume normal operation.
- **NOT TESTED** — Native BLE resources are cleaned up appropriately.

## Existing feature regression matrix

| Existing feature | Automated evidence | Physical status |
|---|---|---|
| BLE discovery, permissions, Bluetooth toggle | Native BLE unchanged; JS clears stale peers and refreshes last-seen | NOT TESTED |
| Direct DM and delivery states | Mock direct delivery, legacy fallback, bidirectional ten-message tests | NOT TESTED |
| Reconnect | Interrupted inventory, receipt retry, fresh-inventory tests | NOT TESTED |
| Chat history and persistence | Real SQLite transactions, restart and JSON migration tests | NOT TESTED |
| Broadcast / emergency alerts | Delayed broadcast, deduplication and listening-disabled relay tests | NOT TESTED |
| Chunking | Existing media out-of-order/duplicate/reassembly tests | NOT TESTED |
| Images / audio | Shared scheduler, media packet identity and reconnect tests; playback/compression not exercised | NOT TESTED |
| Navigation / contacts | Typecheck, lint and all-platform bundle export; no interactive UI run | NOT TESTED |

No confirmed physical regression can be reported without devices. Existing automated coverage remains required to pass. The obsolete JSON FileCreateOptions type error was removed; incomplete media is no longer ACKed solely because a persisted placeholder exists.

## Build artifacts

- Android development APK: `android/app/build/outputs/apk/debug/app-debug.apk`.
- iOS simulator app: `/tmp/nored-mesh-ios-build/Build/Products/Debug-iphonesimulator/nored.app`.
- Production JavaScript exports: `/tmp/nored-mesh-export` (iOS, Android, web).

These development binaries are not evidence of an offline physical demo. Install release/offline-demo builds on real phones for that test. The iOS artifact targets the simulator, not physical iPhone installation.
