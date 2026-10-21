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
panel.

`window.__agentBody` exists only in development builds.

## Brand type: Unbounded, Geologica, JetBrains Mono

| Role | Family | File |
| --- | --- | --- |
| Headings (panel title) | Unbounded 700 | `public/fonts/Unbounded-Bold.ttf` |
| Body text, feedback | Geologica 300 | `public/fonts/Geologica-Light.ttf` |
| Buttons, labels, status, fields | JetBrains Mono 400 | `public/fonts/JetBrainsMono-Regular.ttf` |

All three are SIL OFL 1.1 (`public/fonts/OFL-*.txt`) and carry Cyrillic, so the
Russian and the English interface both render.

UIKit builds a single-channel MSDF atlas per font and, by default, only for a
fixed ASCII charset **without `_`**. Everything else was drawn as a missing
glyph, which is why Cyrillic and underscores used to appear as boxes.
`src/fonts.ts` widens that charset to the intersection of the three brand fonts
(Latin, Latin-1, Cyrillic, typographic punctuation — 309 characters) and
serialises atlas generation, because concurrent MSDF workers produce incomplete
atlases. `tools/font-charset.mjs` regenerates `src/fonts-charset.ts`; run it
after changing the font files.

Two more UIKit quirks are handled in `src/workspace.ts`: a `Container` renders
its text through a child `_Text` with its own style, so `white-space` and
`text-align` are pushed onto that child, and the panel body uses `pre-line` so
multi-line chat records keep their line breaks.

## Three presets: full local, free, paid

**Connections / LLM** has three buttons. They fill the draft only — Save
applies them, and no preset ever copies, clears or bundles a key.

| Preset | Model | Speech in | Speech out | Key |
| --- | --- | --- | --- | --- |
| **Full local** | Gemma 3 1B (WebLLM, WebGPU) | on-device Whisper | on-device MMS-TTS (Russian) | none |
| **Free APIs** | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | browser/OS | browser/OS | OpenRouter key only |
| **Paid APIs** | `google/gemma-4-31b-it`, OpenRouter sorts providers by price | browser/OS | browser/OS | OpenRouter key |

The paid preset asks OpenRouter for `provider: { sort: 'price' }`, so the
cheapest healthy provider wins with the rest kept as fallbacks (CoreWeave was
cheapest during verification: $0.10/M in, $0.34/M out). Free shared-pool models
rate-limit at any time; 429s are reported, never answered by invention.

### Full local: what actually runs

- **LLM** — `@mlc-ai/web-llm` in a module worker: `gemma3-1b-it-q4f16_1-MLC`,
  ~537 MB of weights, ~711 MB VRAM. Two WebLLM quirks are patched in
  `src/agent/local-llm.ts`: the model is cached in IndexedDB (the Cache API
  rejects Hugging Face's Xet CDN responses), and Gemma 3 needs
  `context_window_size: -1` plus `attention_sink_size: 0` because it uses a
  sliding window. Verified end-to-end on the emulator: the weights download, the
  model loads and answers ("Hello! It's a pleasure to meet you.").
  The local path is text-only — a 1B model has no image input, so an explicit
  "look at this" is refused with a message instead of a fake description — and
  it has no reliable tool calling, so the avatar stays neutral there.
- **STT** — `onnx-community/whisper-base` through `@huggingface/transformers`
  (WebGPU, fp32 encoder / q4 decoder). The recording is decoded and resampled
  to 16 kHz mono in the page; audio never leaves the device.
- **TTS** — `Xenova/mms-tts-rus` (VITS, byte-level tokenizer, so no espeak
  phonemizer is needed and Russian works out of the box) through the same
  transformers.js runtime, played with Web Audio. Verified: the voice model
  downloads, the audio plays, and the avatar plays its speaking clip with
  visemes while the audio runs.

### Browser/OS speech: the free tier

The **browser** provider is the cheapest option and needs no key at all.

- **TTS** — `speechSynthesis` exposes the voices installed in the operating
  system. On the test machine that is Microsoft Zira, David and Mark, all with
  `localService === true` (OS voices, not network voices). The default OS voice
  is male, so `src/agent/voices.ts` picks a female-sounding voice for the
  current language first and the panel reports what it chose
  ("Microsoft Zira … OS voice, female"). "Next voice" cycles female voices
  first. Voice names are matched against a curated list; the Web Speech API has
  no gender field.
- **STT** — Chrome 139+ exposes the on-device Web Speech API
  (`SpeechRecognition.available({ langs, processLocally: true })` and
  `install()`), and `ru-RU` is on the supported list. The app checks
  availability, installs the language pack on first use ("Microphone:
  installing the on-device speech pack") and then sets `processLocally = true`,
  so the audio stays on the device. Without the pack the browser falls back to
  the vendor's cloud recognition, and the status says so ("browser, cloud").

### Quest 3 reality check

Not verified on hardware. What the facts say: Meta ships WebGPU in the Horizon
browser as **experimental** (and in WebXR), so the full-local tier may not be
available in the headset browser at all; the app detects that and reports
"Full local mode needs WebGPU…" instead of failing silently. Quest 3 has 8 GB
of shared RAM, and the local tier needs ~0.7 GB of VRAM for the model, ~0.5 GB
of weights in storage plus Whisper and the voice model, on top of the browser
and the VRM scene. That is plausible in the flat browser and risky inside an
immersive session. The API presets are the practical path on the headset.

## Free OpenRouter preset: proof, not branding

The **Free APIs** preset LLM is `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`
on `https://openrouter.ai/api/v1` because that exact model answered a labelled
image fixture end-to-end (the known caption `BLUE KEY 42` was read correctly
from a real JPEG in the real multimodal request, with exactly one request
upload). Gemma 4 31B free is still listed as a selectable model id, but it
returned shared-pool upstream `429`s for every text and image request during
that verification window. Fish `s2.1-pro-free:free` speech is proven through
real `/audio/speech` MP3 bytes; it needs its own explicit key copy after the
preset. No key is bundled.

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
  encouragement (happy), startled (surprised). Wave and shake remain procedural.
  The `nod` and `think` clips are restricted to the head and torso tracks:
  their limb tracks raised both arms above the head.
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
TTS only by an explicit button. The three presets above fill the draft without
touching the keys. Free endpoints are shared-pool rate-limited — 429s happen
and the app reports them instead of falling back to a paid model or a fake
reply. Browser speech recognition/synthesis depend on runtime support. STT
records only while active; stopping releases tracks and aborts transcription.

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
or commercial use. VRMA clips are CC0 (see `public/animations/`); the Sansevieria
plant is MIT from `@iwsdk/example-assets` 0.4.2 and is bundled under
`public/assets/plant-sansevieria/` (attribution alongside); Unbounded, Geologica
and JetBrains Mono are SIL OFL 1.1.

## Settings transfer by QR

**Connections / Transfer** encrypts the complete saved configuration
(AES-GCM, PBKDF2-SHA256 with 300k iterations from a separate six-digit PIN,
10-minute TTL, URL fragment). The receiver (same UIKitML panel) asks for the
PIN; the fragment is captured and cleared before world bootstrap, and again when
a pairing link is opened in an already-running tab. Not a
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
controls with Cyrillic, and the encrypted QR receive flow (link re-entry, PIN
capped at six digits, wrong-PIN error, successful apply). Added in the local
tier: the WebLLM model downloads (537 MB), loads and answers in the emulator;
the on-device Russian voice downloads, synthesises and plays with the speaking
clip; the on-device Whisper model downloads; the browser/OS voice picker selects
the female OS voice; the on-device Web Speech API reports the Russian pack as
downloadable and starts installing it. Not verified: the headset itself, the
Russian on-device recognition quality, and any speech content beyond the
test sentences.
