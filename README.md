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

## Workspace

Desktop has one sidebar; an immersive session hides it and shows one spatial
panel. Both presentations use `src/workspace.ts`, the same settings draft, chat,
memories, speech adapters and avatar. The old welcome panel, robot, HUD copies,
standalone settings card and bottom chat overlay have been removed.

- **Dialogue**: persisted conversation, message input, microphone and Send.
  Enter sends; Shift+Enter adds a line. With no LLM endpoint, the header explicitly
  says Offline demo. This is not a live AI service.
- **Character**: bundled VRM source, name, system prompt, model URL, scale, idle
  motion and gaze. **Use bundled VRM** resets the model source and scale, not the
  personality. A custom URL must allow browser cross-origin loading. A failed
  replacement leaves the previous valid avatar visible and can be retried.
- **Connections / LLM**: OpenAI-compatible base URL, model ID and dedicated key.
- **Connections / STT**: Off, Browser speech recognition, or an OpenAI-compatible
  transcription endpoint. The API path records microphone audio with
  MediaRecorder and posts multipart `file`, `model`, `language` to
  `<base>/audio/transcriptions`.
- **Connections / TTS**: Off, Browser voices, or an OpenAI-compatible speech
  endpoint. The API path posts `model`, `voice`, `input` to `<base>/audio/speech`
  and plays the returned audio. **Test voice** saves a valid draft first.
- **Memory**: add, search and clear local notes; conversation also persists here.

STT and TTS have separate endpoints, models and keys; neither silently borrows
the LLM key. Browser speech depends on installed voices and recognition support.
Unavailable features and provider errors are reported, not silently ignored.
Microphone input requires HTTPS, user permission and browser recording support.
Stopping a recording releases its tracks; cancelling also aborts transcription
and ignores late results. Switching a speech provider stops its active session.

Settings and memories are local to this browser's IndexedDB. Save applies only
edited fields, preserving unrelated settings updates. Secret inputs never display
stored keys: leave blank to retain, enter a replacement, or explicitly Clear.
Immersive Connections also offers **Clear key** followed by **Save**.
`window.__agentBody` exists only in development builds.

## Desktop, MR and VR

XR means an immersive browser session. IWER is IWSDK's browser-based XR emulator:
https://iwsdk.dev/guides/02-testing-experience.html#iwer-controls

- Desktop renders the avatar and virtual room without an XR session. WASD/arrows
  move, Space jumps, right mouse button looks around, and pointer input is enabled.
  Mouse look preserves the configured desktop camera pose instead of resetting it.
- **Enter MR** requests `immersive-ar` from the current world. The virtual room
  hides; hands/controllers, grabbing, anchors, plane/mesh detection and environment
  hit testing use the configured IWSDK features.
- **Enter VR** requests `immersive-vr` from the same world and shows the virtual
  room, without MR-only session features. **Return to browser** exits the session.
  Settings, avatar and conversation do not reset.
- Entry buttons appear only for supported modes. In the spatial panel, select a
  field to edit it through an in-page input; provider/toggle fields cycle directly.
  On supporting Quest Browser versions this requests the system keyboard. IWER
  does not prove the physical headset's keyboard or microphone behavior.

## Character and rendering

`public/vrm/user.vrm` is VRoid AvatarSample_D (VRM 1.0), presented as Ava. It has
no embedded animation clips; blink, breathing, sway, mouth cues and the gesture
vocabulary below are procedural, not a motion-capture animation library.
`AvatarSystem` uses GLTFLoader with VRMLoaderPlugin because IWSDK's manifest
loader does not expose VRM plugin setup. The avatar remains one entity in the
shared world.

MToon needs actual ambient/hemisphere/directional lights; an IBL environment map
alone does not light this shader. The scene now supplies those lights without
replacing the VRM's materials. The desktop camera and headset pose remain separate.

**Asset rights:** the bundled VRM's metadata credits VRoid and declares restricted
redistribution/modification and personal non-profit use. Its presence is not proof
of redistribution permission. Verify the original rights before further public
redistribution or commercial use; application source licensing does not license
this avatar. A self-owned or appropriately licensed VRM can be selected in Character.

## Performance cues (emotion + gesture with every reply)

Every reply carries one performance tag at the start, e.g. `[[happy|wave]] Hi!`.
This is the whole transmission system: the tag travels inside the reply text,
`CueStreamFilter` (src/agent/cues.ts) strips it — even when it is split across
stream chunks — and the clean text goes to the chat, speech synthesis, visemes
and memory, while the parsed cue immediately drives the body:

- Emotions `neutral happy angry sad relaxed surprised` — VRM expression presets
  with a smooth attack/hold/decay envelope (peak weight 0.65, ~4.4 s window).
- Gestures `none wave nod shake think bow` — procedural normalized-bone poses
  layered on top of breathing/sway, then restored exactly to the rest pose.
- The live system prompt instructs the model to emit exactly one tag; if it
  omits or misspells it, values fall back to `neutral|none` and nothing leaks
  into displayed text. An endpoint failure performs `sad|shake`.
- Offline brain picks the cue from keywords (greetings → `happy|wave`,
  questions → `surprised|nod`, goodbyes → `relaxed|bow`, …), so the demo
  performs without any endpoint. The workspace header and spatial status show
  the current cue (e.g. `· happy · wave`) until the next message.
- Ambient idle micro-expressions pause while a cue performs, so the two never
  fight over expression weights.

Note: the spatial UIKitML panel's bundled font lacks Cyrillic glyphs; Cyrillic
chat text renders in the desktop DOM panel but may show placeholder boxes in
the immersive panel. Speech and cue parsing handle Cyrillic normally.

## Settings transfer by QR

**Connections / Transfer** creates a link/QR for the complete saved character,
LLM, STT and TTS configuration. Save changes first. Open the link on the receiving
browser, enter its separate six-digit PIN, then save the decoded settings locally.
A headset's native QR scanner may open the link; the WebXR app does not itself
read passthrough camera pixels. Copy/open the link if scanning is unavailable.

The v2 payload is AES-GCM encrypted with a PBKDF2-SHA256 PIN-derived key
(300,000 iterations), expires after ten minutes and travels in the URL fragment.
The receiver clears that fragment immediately. This is **not** a server-enforced
one-time link or revocable invitation: copied ciphertext can be replayed during
its lifetime, and a six-digit PIN permits offline guessing. Treat QR and PIN as
secrets, do not publish them together, and rotate keys if exposed.

This static application sends user-configured keys directly to their endpoints.
Use user-owned/restricted keys and CORS-compatible endpoints. A public product
that owns provider credentials needs a gateway; GitHub Pages cannot hide a key
embedded in frontend code. No provider credentials are bundled.

## Deployment and verification

`.github/workflows/deploy-pages.yml` runs typecheck/build and deploys `main` to
GitHub Pages. Relative build asset URLs support the `/agent-body/` project path.

Before runtime verification run `npm run --if-present typecheck`. Inspect desktop
with the managed runtime screenshot, not an editor-only render. Inspect an active
MR/VR session before making immersive interaction claims. Emulated results do not
establish headset performance, passthrough fidelity, native keyboard support or
external-provider audio quality.
