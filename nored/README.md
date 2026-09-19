# Nored

Offline Bluetooth mesh chat built with Expo.

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Fetch the on-device Whisper model (~75 MB, required for voice transcription)

   ```bash
   npm run models:fetch
   ```

   This downloads to your Mac (`assets/models/`). It is bundled into the app at build time.

3. Build a development client on your **physical iPhone** (required for `whisper.rn` and audio conversion; Expo Go and simulators are not supported for transcription)

   ```bash
   npm run ios:device
   ```

   Re-run this after adding native dependencies. Voice notes are stored as `.m4a` for mesh transfer; transcription converts them to 16 kHz mono WAV on-device before running Whisper.

   This targets the wired device **aadyaphone**. Do not use the iPhone 18 Pro simulator for transcription — Whisper needs a real device.

   To list connected devices:

   ```bash
   xcrun xctrace list devices
   ```

   Generic Android/iOS commands still work:

   ```bash
   npx expo run:ios
   npx expo run:android
   ```

4. Start the dev server

   ```bash
   npx expo start
   ```

Voice notes show a **See transcription** control below the player. Transcription runs fully on-device after you tap it.

## New developer setup (transcription)

If someone else clones the repo on a new laptop, transcription is **not** ready after `npm install` alone. They need a one-time dev setup on the laptop; the phone does not download anything at tap-time.

| Step | Command | When |
|------|---------|------|
| Install JS deps | `npm install` | Once per clone |
| Download Whisper weights | `npm run models:fetch` | Once per clone (file is gitignored) |
| Build dev client on a physical phone | `npm run ios:device` or `npx expo run:ios --device` | Once per clone, and again after native dependency changes |
| Start Metro | `npx expo start` | Every dev session |

**What is not in git**

- `assets/models/ggml-tiny.bin` (~75 MB) — run `npm run models:fetch` before building.

**Native npm packages** (installed by `npm install`, but require a native rebuild):

- `whisper.rn` — on-device Whisper
- `react-native-audio-converter` — converts voice-note `.m4a` to WAV before inference
- `buffer` — polyfill used by whisper.rn

**Expo Go will not work** for transcription (custom native modules + bundled model). Use a dev client built with `expo run:ios`.

**Simulator will not work** for transcription — use a physical iPhone.

**Verify the model before building**

```bash
ls -lh assets/models/ggml-tiny.bin
```

**Pick a different device name**

```bash
xcrun xctrace list devices
npx expo run:ios --device "Your iPhone Name"
```

## Scripts

- `npm run models:fetch` — download `ggml-tiny.bin` into `assets/models/` (on your Mac, before building)
- `npm run ios:device` — build and install on wired **aadyaphone**
- `npm test` — run mesh and transcription unit tests
- `npm run lint` — ESLint
