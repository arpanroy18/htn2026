# Store-and-forward implementation

## Using it

Open a confirmed nearby person's chat and choose **Add contact for remote messaging**. Saved contacts appear above threads in Chats. After that person leaves, text can be handed to other Nored phones and delivered later. Receiving a text does not require saving its author.

Unregistered nearby people can still exchange direct messages. Their pending messages never travel through intermediaries. Photos and voice notes remain direct-only and wait for the destination to return. Groups remain placeholders.

## Architecture

`Chat/Alert UI → MeshRouter → RouterStore/SQLite + SendScheduler → MeshTransport → native BLE`

The native Swift/Kotlin transport is unchanged. The TypeScript transport accepts application packets, routing envelopes, and bounded control messages. The router owns encounter synchronization, receipt retries, duplicate suppression, expiry, forwarding, and destination acknowledgements. All application sends, including existing media packets, share one priority scheduler.

Application payloads, original IDs, authors and timestamps remain unchanged in routing envelopes. Each outgoing copy increments its hop count. Text uses five hops / 24 hours; alerts ten hops / six hours; destination ACKs ten hops / 24 hours. ACKs are themselves carried packets and do not create ACK loops. Native write completion is distinct from durable peer receipt and final delivery.

`Queued → Sending → Carrying → Delivered`; expired pending text becomes `Expired`. A transient failure returns to Queued/Carrying. A legacy direct peer produces `Sent`, never `Delivered`.

Hello establishes mesh capability after native identity confirmation. Inventories have at most 50 IDs per page and 3,000 encoded bytes. Full pages are assembled before replacing peer knowledge; incomplete inventories cannot delete local packets. Native frames remain serialized; priorities are selected between application packets. Retries back off to 30 seconds, with a fresh inventory every 30 seconds and after local changes. A nonresponding legacy peer becomes eligible for direct application packets after two seconds.

The packet store uses a versioned SQLite key/value table with separate rows for each packet, seen ID and contact, and separate chat, alert and journey records. Changes commit atomically; unchanged rows are not rewritten. The router holds a working snapshot in memory. The existing JSON history is imported once in the same transaction as pending packet records and the import marker. The original JSON file is retained as a backup until the user clears local data; clearing also deletes that backup and keeps the import marker to prevent resurrection.

Relays acknowledge only after persistence commits. Receiving text, durable deduplication, chat insertion and creation of its destination ACK share one transaction. IDs remain remembered through packet expiry plus 24 hours. Payload cleanup never deletes chat history. Routing payloads are capped at 10,000 packets / 32 MiB; exhausted storage rejects acceptance without a receipt. Local journey events retain the latest 2,000 events. Logs contain IDs and outcomes, not message payloads.

## Rebuild and demo

SQLite is a new native dependency. Install a rebuilt binary; an old development client cannot load it. `expo-sqlite` was installed through Expo's SDK 57 installer and added to the app configuration.

For device builds, use the existing development/offline-demo build profiles. Release/offline-demo binaries bundle JavaScript so the demo does not depend on Metro or Wi-Fi.

1. On A and C, enable Bluetooth, open Nored, and wait for confirmed discovery. On A, open C's chat and explicitly add C as a contact.
2. Separate C from A/B. Send text from A to saved contact C.
3. Bring B near A. A should show Carrying after B accepts. B must not show the private text in its chats.
4. Disconnect A completely. Force-close and reopen B.
5. Bring B near C. C must receive the original text exactly once, authored by A.
6. Separate B from C and bring B back near A. A must eventually show Delivered.
7. Repeat with an alert, alternative relay paths, and Bluetooth toggles. Use a fourth device for a three-edge delayed route.

Use airplane mode, Wi-Fi off, cellular off, Bluetooth on for every physical test. Each forwarding app must be open; background routing is not implemented.

## Validation and limitations

Automated results and every physical checklist item are recorded in [mesh-acceptance.md](mesh-acceptance.md). Simulated routing and native compilation do not establish physical BLE reliability.

- No physical phones were attached during implementation (only shutdown iOS simulators were listed).
- Media does not relay; partial incoming media restarts through the existing direct manifest/chunk retry flow.
- No cryptographic authentication or encryption was added. Existing device IDs are addressing identifiers; saved contacts do not authenticate relays or ACKs.
- Native BLE framing is unchanged and still needs real-device testing of partial transfers and rapid reconnects.
- Store transactions clone the in-memory snapshot; the bounded hackathon store is not intended for large deployment scale.
- Route history is local observations, not a complete reconstructed end-to-end journey.
- Web uses localStorage as a non-BLE preview, avoiding native SQLite/WASM requirements.

## Important files

| Files | Change |
|---|---|
| `src/mesh/MeshRouter.ts`, `protocol.ts`, `scheduler.ts` | Routing, wire validation, inventory/receipts, priority and cancellation |
| `src/mesh/routerStore.ts`, `persistence.ts`, `persistence.web.ts`, `migration.ts` | Transactional SQLite store, web adapter, one-time JSON import |
| `src/mesh/RouterContext.tsx`, `ChatContext.tsx`, `AlertContext.tsx` | Shared app lifecycle, durable UI state, media integration |
| `src/mesh/chatStore.ts`, `mediaTransfer.ts`, `MeshUiContext.tsx` | Delivery states, ordering, bounded media validation, presence updates |
| `src/transport/MeshTransport.ts`, `NoredBleTransport.ts` | Accept wire envelopes/control messages without changing enclosed identities |
| `src/app/_layout.tsx`, `src/app/chat/[id].tsx`, `src/app/(tabs)/chats.tsx` | Router provider, explicit nearby contact action, saved-contact list |
| `src/mesh/router.test.mjs` | Hardware-free encounter, persistence, protocol, media scheduler and failure tests |
| `app.json`, `package.json`, `package-lock.json`, `tsconfig.json` | SQLite dependency/plugin and testable TypeScript module imports |
