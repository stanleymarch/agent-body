# IWSDK App

This project uses `iwsdk.config.json` for declarative scene, asset, component,
XR, and emulator configuration. Application systems remain explicit in
`src/index.ts`.

```sh
npm install
npm run dev
```

Use the Runtime and Editor controls in the managed browser to switch between
the running experience and its authored scene.

## Starter content

The robot and welcome panel are small examples of authored scene content plus
runtime systems. The robot turns toward the player's head and plays a sound
when pressed. To remove the robot, delete its scene node, its `RobotSystem`
registration from `src/index.ts` or `src/index.js`, and its `Robot` registration
from `src/components.ts` or `src/components.js`; you can then delete the unused
robot component and system files. To remove the welcome panel, delete its scene
node and its `PanelSystem` registration from the application entry point.

## Three runtimes, one application

The same application runs in a normal desktop browser, in mixed reality, and
in a fully virtual space; there is one world, one scene, and one state — no
logic is forked between modes. XR means the immersive browser session.

- Browser: WASD/arrows to move, Space to jump, right mouse button to look
  around (pointer lock), left click to press objects and panel buttons. The
  browser also previews the virtual space that VR uses.
- XR-capable browser: the welcome panel shows two entries. **Enter MR**
  starts `immersive-ar` (passthrough, anchors, plane/mesh detection,
  hit-test). **Enter VR Space** starts `immersive-vr` with those MR-only
  features disabled and shows the procedural virtual room instead. Both run
  from the same live `World` (`world.launchXR({ sessionMode })`); switching
  modes never reloads the page or resets agent state.
- The virtual room (`src/scene-assets/vr-space.scene-asset.ts`, scene node
  `vr-space`) is visible on desktop and in VR, and hidden in MR so the real
  room stays visible.
- Quest (MR): hands/controllers, grabbing (`DistanceGrabbable`), scene
  understanding, and environment raycast come from the XR feature set in
  `iwsdk.config.json`; WASD-style browser controls are simply inactive.

## User avatar

`public/vrm/user.vrm` (VRM 1.0) is loaded by `AvatarSystem` through a dedicated
`GLTFLoader` with `VRMLoaderPlugin` — `AssetManager`'s internal GLTF loader is
not plugin-extensible. The avatar is one entity in the shared world, visible in
both runtimes; idle life is procedural (blink via expressions, breath/sway via
humanoid bones) because the model ships no embedded clips.

## Agent state & UI

`src/agent/contracts.ts` pins the seams; nothing in the agent layer knows
which runtime it is in:

- `src/agent/state.ts` — Dexie (`agent-body` DB) + zod + MiniSearch: settings
  and memories persist locally in both modes; fuzzy memory search is warmed on
  load; IndexedDB failure degrades to in-memory. Public operations wait for
  database initialization, so an immediate first interaction cannot lose data.
- `public/ui/agent.uikitml` + `src/agent-ui.ts` — the agent panel (HUD in
  browser, world-space in XR): agent name, memory count/list, Add Note, and
  Idle/Gaze toggles that drive the VRM body.
- `src/avatar-body.ts` — `avatarBody` facade for expressions, text-driven
  visemes, gaze, and idle. `AmbientSystem` schedules infrequent
  micro-expressions without per-frame allocations.
- `window.__agentBody` exposes the state, brain, and avatar singletons for
  runtime inspection from the dev tooling.

## Agent brain

`src/agent/brain.ts` uses AI SDK 7 with an OpenAI-compatible chat endpoint. It
streams model text into VRM mouth cues and provides `memory_write` and
`memory_search` tools backed by the same local state used by every interface.
The bottom browser chat bar is intentionally hidden in immersive mode; the
conversation and memories remain in the shared agent state.

With no endpoint configured, the app uses a deterministic offline brain
(`npm run dev` with no extra environment). For a compatible endpoint during
development:

```sh
VITE_AGENT_ENDPOINT=https://example.test/v1 \
VITE_AGENT_MODEL=model-id \
VITE_AGENT_KEY=user-owned-key \
npm run dev
```

This static app sends the configured key from the browser. Use only a
user-owned/local endpoint while developing; production deployments should put
provider credentials behind an application gateway. Web Speech synthesis is a
best-effort output enhancement and no-ops when the browser has no voice.
Microphone speech recognition is not implemented because Quest Browser support
must be proven on a physical headset before selecting an ASR path.

## Model settings & headset pairing

Settings live only in the browser's IndexedDB and are never bundled.

- Desktop: the **Model settings** card (bottom-right) edits endpoint, model
  id, and API key. The key uses replacement semantics — it is never rendered
  back after saving, and it is cleared only through the explicit
  **Clear key** action.
- Immersive (MR/VR): the agent panel's **Model Settings** view selects a
  field; focusing an in-page DOM input summons the Quest system keyboard
  (Browser 26.1+, `session.isSystemKeyboardSupported`). Field values show as
  summaries only; the key is shown as Set/Not set.
- **Share to headset** generates a QR code containing
  `<site-url>#pair=v1.<salt>.<iv>.<ciphertext>`. The payload is AES-GCM
  encrypted under a PBKDF2-SHA256 key derived from a one-time 6-digit PIN
  (300k iterations, 10-minute TTL). Scan it with any headset QR app — or
  copy the link — open it in Quest Browser, type the PIN, and the settings
  are decrypted into that headset's IndexedDB. The fragment never reaches a
  server, and the QR alone is useless without the PIN. WebXR pages cannot
  read passthrough camera pixels, so scanning itself is delegated to native
  QR apps on the headset.

## Hosting

Published as a GitHub Pages project site from `main` via
`.github/workflows/deploy-pages.yml` (typecheck + vite build, `base: './'`
keeps every asset URL subpath-safe):

```sh
npm run build   # outputs dist/ with relative asset paths
```


- Minimal scene walkthrough: https://iwsdk.dev/guides/01b-minimal-scene.html
- XR testing and IWER (IWSDK's browser-based XR emulator) controls:
  https://iwsdk.dev/guides/02-testing-experience.html#iwer-controls
