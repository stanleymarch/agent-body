/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  createSystem,
  SessionMode,
  UIKitMLAsset,
  VisibilityState,
} from '@iwsdk/core';

/**
 * Entry panel for one desktop/MR/VR application. Session mode changes only
 * presentation: the World, scene entities, agent state, and avatar stay alive.
 */
export class PanelSystem extends createSystem({}) {
  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    const mrButton = panel?.getElementById('mr-button');
    const vrButton = panel?.getElementById('vr-button');
    const exitButton = panel?.getElementById('exit-button');
    if (mrButton == null || vrButton == null || exitButton == null) {
      return;
    }

    mrButton.setProperties({ display: 'none' });
    vrButton.setProperties({ display: 'none' });
    exitButton.setProperties({ display: 'none' });

    const vrSpace = this.world.getSceneObject('vr-space');
    let immersiveARSupported = false;
    let immersiveVRSupported = false;
    let requestedMode = SessionMode.ImmersiveAR;

    const updatePresentation = (is2D: boolean): void => {
      mrButton.setProperties({
        display: is2D && immersiveARSupported ? 'flex' : 'none',
      });
      vrButton.setProperties({
        display: is2D && immersiveVRSupported ? 'flex' : 'none',
      });
      exitButton.setProperties({ display: is2D ? 'none' : 'flex' });
      if (vrSpace != null) {
        // Desktop previews the virtual space. MR hides it for passthrough;
        // immersive VR keeps it as the surrounding room.
        vrSpace.visible = is2D || requestedMode === SessionMode.ImmersiveVR;
      }
    };

    if (!this.world.xrEnabled || navigator.xr == null) {
      updatePresentation(true);
      return;
    }

    void Promise.all([
      navigator.xr.isSessionSupported(SessionMode.ImmersiveAR),
      navigator.xr.isSessionSupported(SessionMode.ImmersiveVR),
    ])
      .then(([arSupported, vrSupported]) => {
        immersiveARSupported = arSupported;
        immersiveVRSupported = vrSupported;
        updatePresentation(
          this.world.visibilityState.value === VisibilityState.NonImmersive,
        );
      })
      .catch((error: unknown) => {
        console.warn('[entry] XR capability check failed', error);
      });

    const launchMR = (): void => {
      if (!immersiveARSupported) {
        return;
      }
      requestedMode = SessionMode.ImmersiveAR;
      this.world.launchXR({ sessionMode: SessionMode.ImmersiveAR });
    };
    const launchVR = (): void => {
      if (!immersiveVRSupported) {
        return;
      }
      requestedMode = SessionMode.ImmersiveVR;
      this.world.launchXR({
        sessionMode: SessionMode.ImmersiveVR,
        features: {
          anchors: false,
          hitTest: false,
          planeDetection: false,
          meshDetection: false,
        },
      });
    };
    const exitXR = (): void => {
      this.world.exitXR();
    };

    mrButton.addEventListener('click', launchMR);
    vrButton.addEventListener('click', launchVR);
    exitButton.addEventListener('click', exitXR);
    this.cleanupFuncs.push(
      () => mrButton.removeEventListener('click', launchMR),
      () => vrButton.removeEventListener('click', launchVR),
      () => exitButton.removeEventListener('click', exitXR),
      this.world.visibilityState.subscribe((visibilityState) => {
        updatePresentation(visibilityState === VisibilityState.NonImmersive);
      }),
    );
  }
}
