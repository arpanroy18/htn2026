# Hyperframes Composition Brief: Nored

## Objective
Create a short launch-style brag video for Nored that shows the product *in use* via captured phone-screen demo clips (rendered mock UI videos), not static cards.

## Output
- Composition directory: `brag-output-2026-09-20-034621/composition/`
- Rendered video: `brag-output-2026-09-20-034621/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 20 seconds

## Source Material
- Project root: `/Users/arpan/Desktop/Coding/htn2026`
- Primary files read: `SPECS.md`, `DESIGN.md`, `nored/src/app/(tabs)/*.tsx`, `nored/src/app/chat/[id].tsx`, `nored/src/theme/signal.ts`
- Product name: Nored
- Tagline / strongest claim: "Talk when the towers can't." / offline Bluetooth mesh chat
- Key UI moment: Nearby peer list, chat bubbles with delivery status, voice transcription, EMERGENCY alert, games list
- Copy that must appear verbatim:
  - "No signal." / "No problem."
  - "OFFLINE MESH"
  - "trailhead at dawn?"
  - "Queued → Relayed → Seen"
  - "See transcription"
  - "HELP"
  - "Talk when the towers can't."

## Creative Direction
- Tone preset: app-store
- Creative direction: feature-demo launch film with captured product footage in phone frames
- Interpretation: hook is text-only; every feature scene embeds a pre-rendered product demo `<video>` inside a phone mockup. Labels are minimal kicker text beside or above the phone.
- Angle: prove the offline mesh use case with moving UI, not stat cards.
- Hook: signal bars dead → slam full → "No problem."
- Outro: Nored logo + tagline
- Avoid: generic SaaS language, abstract motion graphics, static mockups without video

## Visual Identity
- Background: #f6f6f6
- Text: #1b1b1b
- Accent: #2c6bed
- Display font: Inter 800 (system-ui fallback)
- Body font: Inter 400/600
- Visual references: Signal-inspired palette from `nored/src/theme/signal.ts`, tab bar (Nearby/Chats/Alerts/Games), chat bubbles, peer rows

## Storyboard
1. Hook — 3s — signal flip + Nored wordmark
2. Nearby product video — 4s — phone frame with peer discovery clip
3. Chat product video — 3.5s — DM relay clip
4. AI product video — 3.5s — voice transcription clip
5. Alert product video — 3s — emergency broadcast clip
6. Games + outro — 3s — games clip then logo

## Audio
- Audio role: warm bed with professional accents
- Audio arc: fade in → steady under demos → bell on emergency → fade out on logo
- Music: happy-beats-business-moves-vol-10-by-ende-dot-app.mp3
- Music treatment: 0.32 volume, fade in 0.5s, fade out last 1.5s
- Music cue guidance: bundled preset; strong cues 15.82/18.01/18.55/20.19s; beat-grid for sequential reveals
- Audio-reactive treatment: subtle; phone frame shadow/glow breathes with RMS
- Audio-coupled moments: hook slam, peer cards, send click, emergency bell, logo payoff
- SFX selection guidance: card-place for arrivals, mouseclick for sends, bell for emergency, impactSoft for hook/logo
- SFX analysis guidance: `.agents/skills/brag/assets/sfx/sfx-analysis.md`
- Audio files: `composition/assets/`

## Hyperframes Instructions
- Pre-render product demo clips from `composition/demos/*/index.html` into `composition/assets/product/*.mp4`
- Main `index.html` embeds clips via `<video>` inside phone mockup frames
- At least 5 feature scenes must show captured product video (not static HTML)
- Run `hyperframes check` before render
- Total duration 20s
