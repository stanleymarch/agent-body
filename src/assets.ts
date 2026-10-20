/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetType, defineAssets } from '@iwsdk/core';
import { createLocomotionFloor } from './scene-assets/locomotion-floor.scene-asset.js';
import { createVRSpace } from './scene-assets/vr-space.scene-asset.js';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

export default defineAssets({
  'plant-sansevieria': {
    // Bundled: a failed third-party CDN fetch aborts the whole level in IWSDK
    // and leaves a blank page. MIT, see public/assets/plant-sansevieria/.
    url: publicAssetUrl('assets/plant-sansevieria/plantSansevieria.gltf'),
    type: AssetType.GLTF,
    name: 'Plant Sansevieria',
    priority: 'lazy',
  },
  'agent-panel': {
    url: publicAssetUrl('ui/agent.uikitml'),
    type: AssetType.UIKitML,
    name: 'Agent Panel',
  },
  'locomotion-floor': createLocomotionFloor(),
  'vr-space': createVRSpace(),
});
