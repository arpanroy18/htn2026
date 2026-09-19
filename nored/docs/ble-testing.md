# Nored BLE physical test

## Current checkpoint

Milestones 1 and 2 are implemented. Android scans as a BLE central; iOS advertises as a BLE peripheral. Android connects automatically, reads the iPhone identity, subscribes to the future TX characteristic, and writes its identity back. This metadata handshake makes both phones appear in Nearby without OS pairing.

Packet transfer, framing, ACKs, and Chat intentionally remain disabled until this discovery checkpoint passes on the target phones.

## Build and install

This feature requires development builds and does not work in Expo Go.

```sh
npm install
npx expo prebuild
npx expo run:android --device
npx expo run:ios --device
```

Rebuild each native app after changes under `modules/nored-bluetooth`. JavaScript-only changes can use Fast Refresh.

For an offline cold-launch test, install a Release build with `npm run android:offline -- --device` or `npm run ios:offline -- --device`. The `offline-demo` EAS profile provides the equivalent internally distributed build with its JavaScript bundle embedded.

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

Capture the on-screen `DEVICE LOG` if either peer does not appear. More native detail is available through Android Logcat using the `NoredBLE` tag and the Xcode console using `NoredBLE`.

## Foreground and topology limits

- This checkpoint is foreground-only. It does not configure either phone as a background router.
- Android-to-Android and iPhone-to-iPhone discovery are unavailable in the fixed-role checkpoint.
- Android advertises no service yet, so `BLUETOOTH_ADVERTISE` is deliberately absent. It will be added with Android peripheral support.
- No message content is logged. Device UUIDs are shortened in logs; Android system addresses are visible only in native connection diagnostics.
