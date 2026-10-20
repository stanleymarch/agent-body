# Agent Body

One IWSDK application and one shared state for desktop, mixed reality, and a
virtual room. Built from the official Mixed Reality scaffold; there is no second
browser app. `iwsdk.config.json` selects the scene, assets, components and features.

Published site: https://stanleymarch.github.io/agent-body/

```sh
npm ci
npm run --if-present typecheck
npm run dev
```

The CLI manages Vite and its browser. Use the Runtime/Editor toggle in that window.
Do not start a separate Vite process. Production builds use `npm run build`.

## Workspace: one Meta Horizon surface

Desktop and immersive modes share one Horizon-kit UIKitML panel
(`public/ui/agent.uikitml`). In the browser it is attached with a `ScreenSpace`
component; entering XR returns it to its authored world transform. The old
hand-styled DOM sidebar, settings card and chat overlay are gone. The only DOM
left is a hidden native text/password input that doubles as the Quest
system-keyboard bridge while editing a field.

Tabs: **Dialogue** (message, microphone, explicit Look/camera), **Character**
(bundled preset, custom VRM URL, prompt, scale, idle, gaze), **Connections**
(independent LLM/STT/TTS + encrypted QR transfer), **Memory** (notes, facts,
search, confirmed clear). Enter MR / Enter VR / Return to browser are the same
panel. Cyrillic text renders through bundled Noto Sans (SIL OFL 1.1,
`public/fonts/OFL.txt`; source: `notofonts/noto-fonts`).

`window.__agentBody` exists only in development builds.

## Avatar performance

The avatar performs alongside replies through an **optional typed tool**, not
inline text tags. The live system prompt offers `avatar_perform(emotion,
gesture)` with fixed vocabularies; a zod-validated schema rejects unknown
values. Without the call the avatar stays neutral, and the reply text is
ordinary prose — nothing is parsed out of it, so a small model cannot leak
markup into speech or memory. This reduces formatting failures; it is not a
guard against factual errors in the model's answer.

- Emotions `neutral happy angry sad relaxed surprised` drive VRM expression
  presets with an attack/hold/decay envelope.
- Gestures are backed by **real CC0 VRMA clips** where honestly covered
  (`public/animations/ATTRIBUTION.txt` pins sources, licenses and SHA-256):
  idle, speaking, listening-nod, thinking, kneeling apology (bow),
  encouragement (happy), startled (surprised). Wave and shake remain procedural
  — labelled as such, never described as clips.
- Speaking animation follows **actual audio playback**, not network token
  generation; mouth movement is approximate viseme timing.
- Clips restore the exact captured normalized-skeleton rest pose on completion,
  cancellation, and avatar replacement. A missing or failed clip falls back to
  procedural motion and logs it in development.

## Room understanding and camera

- `getRoomContext()` feeds the model **measured WebXR geometry only** (detected
  planes/meshes with dimensions and origins, browser semantic labels, capped at
  12 surfaces), explicitly labelled as metadata, not vision. Unbounded meshes
  report "dimensions not provided". The prompt forbids inferring objects,
  colours or people from geometry, and states plainly when no photo is attached.
- A photo is captured **only on an explicit command** ("look at this",
  "посмотри, что это", "сделай фото", "what do you see in the camera" — full
  message, anchored). One ephemeral JPEG (max 1024px) is attached to that single
  request; it is never stored in history or memory, and camera tracks are
  stopped before the request is sent. Mentioning a camera is not consent.
- Quest passthrough compositing does not expose camera pixels to WebXR. Capture
  uses `getUserMedia` when the browser exposes a camera; a feed is labelled
  `quest-camera` only on positive camera identity, and an ambiguous Quest feed
  is rejected with an actionable message instead of masquerading as the room.
  Permission denial, missing cameras, and timeouts all report honestly.
- Room geometry requires MR with plane/mesh detection granted (headset space
  setup). The emulator reports simulated geometry, not a physical room.

## Connections

Independent LLM, STT and TTS providers, endpoints, models and keys. Secrets are
never rendered back; blank retains, Clear removes, and the LLM key is copied to
TTS only by an explicit button. **OpenRouter free preset** fills
`google/gemma-4-31b-it:free` (text+image input, no audio input) and
`fish-audio/s2.1-pro-free:free` speech (`mp3`), but no credentials: enter your
own key. Free endpoints are shared-pool rate-limited — 429s happen and the app
reports them instead of falling back to a paid model or a fake reply.
Browser speech recognition/synthesis depend on runtime support. STT records
only while active; stopping releases tracks and aborts transcription.

## Desktop, MR and VR

XR means an immersive browser session. IWER is IWSDK's browser-based XR
emulator: https://iwsdk.dev/guides/02-testing-experience.html#iwer-controls

- Desktop: WASD/arrows move, Space jumps, right mouse looks; the configured
  camera pose is preserved.
- **Enter MR** starts `immersive-ar` (passthrough, hands/controllers, grabbing,
  anchors, plane/mesh detection, hit-test). The virtual room hides.
- **Enter VR** starts `immersive-vr` and shows the procedural virtual room.
  State, avatar and conversation persist across mode switches.

## Character and rendering

`public/vrm/user.vrm` is VRoid AvatarSample_D (VRM 1.0), presented as Ava,
loaded with GLTFLoader + VRMLoaderPlugin. Blink, breath, sway and visemes are
procedural; body motion comes from the CC0 VRMA library above. MToon needs real
ambient/hemisphere/directional lights (supplied by the scene), not just an IBL
map.

**Asset rights:** the bundled VRM's metadata declares restricted
redistribution/modification and personal non-profit use. Its presence is not
proof of redistribution permission; verify before further public redistribution
or commercial use. VRMA clips are CC0 (see `public/animations/`); Noto fonts are
SIL OFL 1.1.

## Settings transfer by QR

**Connections / Transfer** encrypts the complete saved configuration
(AES-GCM, PBKDF2-SHA256 with 300k iterations from a separate six-digit PIN,
10-minute TTL, URL fragment). The receiver (same UIKitML panel) asks for the
PIN; the fragment is captured and cleared before world bootstrap. Not a
server-enforced one-time link: copied ciphertext can be replayed within its
lifetime and a six-digit PIN permits offline guessing. Treat QR + PIN as
secrets. The app sends user-configured keys directly to their endpoints; use
restricted keys and CORS-compatible endpoints. No credentials are bundled.

## Deployment and verification

`.github/workflows/deploy-pages.yml` typechecks, builds and deploys `main` to
GitHub Pages. Before runtime verification run the typecheck; inspect desktop
with the managed runtime screenshot and an active MR/VR session before
immersive claims. Emulated runs do not establish headset performance, real
passthrough, physical camera availability or native keyboard behavior. Verified
in this revision on the emulator: real VRMA playback/restoration, Fish free
speech end-to-end, request composition for Gemma free (blocked upstream by
shared-pool 429 at test time), explicit-photo privacy path, native Horizon
controls with Cyrillic.
