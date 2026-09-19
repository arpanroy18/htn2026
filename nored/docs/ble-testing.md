# Current mesh implementation

See [store-and-forward.md](store-and-forward.md) for the current architecture, contacts workflow, rebuild requirements, and delayed-delivery demo. See [mesh-acceptance.md](mesh-acceptance.md) for honest physical verification status. The checkpoint below is historical; alerts and direct media are now implemented, and chat persistence uses SQLite.

# Nored BLE physical test

## Current checkpoint

Discovery plus 1:1 Bluetooth text are implemented. Each phone advertises and scans, hosts a GATT server, and connects as a central to nearby Nored phones. Text packets are chunked across the Inbox write / Outbox notify characteristics. The Chats tab lists only real threads (no placeholder people).

## Build and install

This feature requires development builds and does not work in Expo Go. Native changes under `modules/nored-bluetooth` need a rebuild.

```sh
npm install
npx expo prebuild
npx expo run:android --device
npx expo run:ios --device
```

JavaScript-only changes can use Fast Refresh.

For an offline cold-launch test, install a Release build with `npm run android:offline -- --device` or `npm run ios:offline -- --device`.

The iOS build needs Xcode 26.4 or a compatible EAS macOS image for Expo SDK 57. Xcode 26.1 fails while compiling ExpoModulesJSI before it reaches NoredBluetooth.

## Discovery acceptance test

1. Install the development build on one Android phone and one iPhone.
2. Enable airplane mode on both phones, then manually re-enable Bluetooth. Keep Wi-Fi and cellular off.
3. Open Nored and grant only its Bluetooth/Nearby Devices request. Android 11 and older may show a location permission because BLE scanning requires it on those releases.
4. Keep Nored foregrounded on both phones for 30 seconds.
5. Confirm the Android lists the iPhone with its name, short UUID, RSSI category, and recent last-seen value.
6. Confirm the iPhone lists the Android with its name and short UUID. RSSI is expected to be unavailable in the iOS peripheral role.
7. Toggle Bluetooth off on each phone, turn it on again, and confirm the peer disappears and returns without restarting Nored.
8. Close and reopen the apps and confirm each phone retains its UUID and edited display name.
9. Open a chat immediately when a peer first appears, before waiting for the identity log. Confirm the thread remains the same after the short hardware ID is replaced by the Nored UUID.
10. Change a display name while both phones remain connected. Confirm the other phone updates without reinstalling or changing the system Bluetooth device name.

## 1:1 text acceptance test

1. From Nearby, tap the other Nored phone. Chats should open an empty 1:1 thread named after that phone.
2. Send a short text. It should appear locally as Sent, then show on the other phone within a few seconds.
3. Reply from the other phone. Both threads should keep order per sender.
4. Send a longer message (a few hundred characters). It should reassemble as a single bubble.
5. Walk one phone out of range, send a message, then walk back. The queued bubble should flush without typing it again.
6. Confirm Chats lists only these real threads, with an Out of range chip when the peer is gone.
7. Send while a peer has just appeared but its identity is still connecting. The bubble must remain Queued until the Bluetooth write completes.
8. Rapidly send 10 short messages in each direction. Confirm ordering, no duplicate bubbles, and no permanently queued message.
9. Send simultaneously from both phones and confirm both threads receive the opposite message.

Capture the on-screen `DEVICE LOG` if either peer does not appear or a send stays queued while both phones are in range. More native detail is available through Android Logcat using the `NoredBLE` tag and the Xcode console using `NoredBLE`. Message bodies are not logged.

## Compatibility matrix

Run the full discovery and text tests for each available pairing:

- Two iPhones on different iOS versions, including iOS 26.x with iOS 27.
- iPhone to Android, in both send directions.
- Two Android phones on different Android API levels.
- Three phones in one room, including two phones with the same display name.

For every pairing, also test:

1. Cold-launch both apps with Bluetooth already enabled.
2. Launch one app 30 seconds after the other.
3. Toggle Bluetooth off and on, then wait up to 30 seconds for canonical identity recovery.
4. Rename either phone while connected.
5. Walk out of range, queue a message, return, and wait up to 10 seconds for retry.
6. Send a 1,500-character UTF-8 message containing emoji.
7. Force-close and reopen the app. The device UUID and display name must remain unchanged.

Record the app version, OS versions, phone models, both short Nored UUIDs, and the first error log if a case fails.

## Foreground and topology limits

- This checkpoint is foreground-only. It does not configure either phone as a background router.
- Discovery and delivery are guaranteed only while Nored is open in the foreground on both phones.
- Both platforms advertise the Nored BLE service and run a GATT server, so iPhone and Android can each send and receive text.
- Advertisement names are not device identity. Nored confirms the persisted app UUID and current display name over GATT before considering a peer sendable.
- Group chats, alerts, voice, and images are still UI-only.
