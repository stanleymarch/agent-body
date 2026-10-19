/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { consumePairingUrl, parsePairingFragment } from './pairing.js';
import { agentState } from './agent/state.js';

/**
 * Finish-screen for a scanned/copy-carried `#pair=` link. Runs in the plain
 * 2D browser window (Quest Browser included) before any XR session starts, so
 * PIN entry uses the platform's normal keyboard. Returns an unmount function,
 * or null when the current URL carries no pairing fragment.
 */
export function mountPairingReceiver(): (() => void) | null {
  if (parsePairingFragment(location.hash) == null) {
    return null;
  }

  const style = document.createElement('style');
  style.textContent = `
    #agent-pairing-backdrop {
      position: fixed; inset: 0; z-index: 40; display: flex;
      align-items: center; justify-content: center;
      background: rgba(6, 10, 20, 0.86);
      color: #f5f7ff; font: 15px/1.4 system-ui, sans-serif;
    }
    #agent-pairing-card {
      width: min(430px, calc(100vw - 48px)); box-sizing: border-box;
      padding: 24px; border: 1px solid #41506f; border-radius: 18px;
      background: #101828; box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
      text-align: center;
    }
    #agent-pairing-card h1 { margin: 0; font-size: 21px; }
    #agent-pairing-card p { margin: 8px 0 18px; color: #b8c1d9; }
    #agent-pairing-pin {
      width: 100%; box-sizing: border-box; padding: 14px; text-align: center;
      border: 1px solid #536483; border-radius: 12px; color: #f8faff;
      background: #0e1528; font: 600 26px/1 ui-monospace, monospace;
      letter-spacing: 10px;
    }
    #agent-pairing-apply {
      width: 100%; margin-top: 14px; min-height: 50px; border: 0;
      border-radius: 12px; color: #fff; background: #294b93;
      font: 700 16px/1 system-ui, sans-serif; cursor: pointer;
    }
    #agent-pairing-apply:disabled { opacity: 0.55; }
    #agent-pairing-skip {
      width: 100%; margin-top: 10px; min-height: 44px; border: 0;
      border-radius: 12px; color: #c7d0e6; background: #2a3245;
      font: 600 14px/1 system-ui, sans-serif; cursor: pointer;
    }
    #agent-pairing-status { margin-top: 14px; min-height: 20px; color: #aebada; }
    #agent-pairing-status.error { color: #ff8f8f; }
    #agent-pairing-status.success { color: #7ee2a8; }
  `;

  const backdrop = document.createElement('div');
  backdrop.id = 'agent-pairing-backdrop';
  backdrop.innerHTML = `
    <section id="agent-pairing-card">
      <h1>Settings pairing</h1>
      <p>Enter the 6-digit PIN shown next to the QR code to load the model
         settings into this headset.</p>
      <input id="agent-pairing-pin" type="text" inputmode="numeric"
             autocomplete="one-time-code" maxlength="7" placeholder="••• •••"
             aria-label="Pairing PIN">
      <button id="agent-pairing-apply" type="button">Apply settings</button>
      <button id="agent-pairing-skip" type="button">Skip and use current settings</button>
      <div id="agent-pairing-status" role="status" aria-live="polite"></div>
    </section>
  `;

  document.head.append(style);
  document.body.append(backdrop);

  const pin = backdrop.querySelector<HTMLInputElement>('#agent-pairing-pin')!;
  const apply = backdrop.querySelector<HTMLButtonElement>('#agent-pairing-apply')!;
  const skip = backdrop.querySelector<HTMLButtonElement>('#agent-pairing-skip')!;
  const status = backdrop.querySelector<HTMLDivElement>('#agent-pairing-status')!;

  const stopLocomotionKeys = (event: KeyboardEvent): void => {
    event.stopPropagation();
  };
  pin.addEventListener('keydown', stopLocomotionKeys);

  const clearPairingHash = (): void => {
    if (parsePairingFragment(location.hash) != null) {
      // Fragment never reached the server; drop it from history and the URL.
      history.replaceState(null, '', location.pathname + location.search);
    }
  };
  const unmount = (): void => {
    clearPairingHash();
    pin.removeEventListener('keydown', stopLocomotionKeys);
    backdrop.remove();
    style.remove();
  };

  const submit = (): void => {
    const value = pin.value.replace(/\D/gu, '');
    if (value.length !== 6) {
      status.className = 'error';
      status.textContent = 'Enter all 6 digits of the PIN.';
      return;
    }
    apply.disabled = true;
    status.className = '';
    status.textContent = 'Decrypting…';
    void consumePairingUrl(location.href, value)
      .then((patch) => agentState.updateSettings(patch))
      .then(() => {
        // Remove the encrypted secret from the URL immediately; keep the
        // confirmation visible briefly before the modal closes.
        clearPairingHash();
        status.className = 'success';
        status.textContent =
          'Settings applied to this headset. You can close this screen.';
        window.setTimeout(unmount, 1200);
      })
      .catch((error: unknown) => {
        apply.disabled = false;
        status.className = 'error';
        status.textContent =
          error instanceof Error ? error.message : 'Pairing failed.';
      });
  };

  apply.addEventListener('click', submit);
  pin.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      submit();
    }
  });
  skip.addEventListener('click', unmount);
  pin.focus();
  apply.dataset.bound = 'true';

  return () => {
    apply.removeEventListener('click', submit);
    skip.removeEventListener('click', unmount);
    unmount();
  };
}
