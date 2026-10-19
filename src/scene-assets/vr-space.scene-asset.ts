/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  BackSide,
  CircleGeometry,
  GridHelper,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  type Object3D,
} from '@iwsdk/core';

const SPACE_RADIUS_M = 10;
const FLOOR_RADIUS_M = 8;

/**
 * Low-cost virtual room used by desktop and immersive-vr presentation.
 * The runtime entry system hides this asset for immersive-ar passthrough.
 *
 * Contract: parentless, deterministic, Y-up, floor contact at y=0,
 * approximately 20 m across. Two meshes plus one shared grid helper.
 */
export function createVRSpace(): Object3D {
  const root = new Group();
  root.name = 'vr-space';

  const sky = new Mesh(
    new SphereGeometry(SPACE_RADIUS_M, 32, 16),
    new MeshBasicMaterial({ color: 0x10182d, side: BackSide }),
  );
  sky.name = 'vr-space-sky';
  sky.position.y = 2.5;
  sky.userData.iwsdkPreviewBounds = 'exclude';
  root.add(sky);

  const floor = new Mesh(
    new CircleGeometry(FLOOR_RADIUS_M, 64),
    new MeshStandardMaterial({
      color: 0x18213a,
      metalness: 0.05,
      roughness: 0.92,
    }),
  );
  floor.name = 'vr-space-floor';
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.01;
  floor.receiveShadow = true;
  root.add(floor);

  const grid = new GridHelper(16, 32, 0x7188bb, 0x33405f);
  grid.name = 'vr-space-grid';
  grid.position.y = 0.005;
  const gridMaterials = Array.isArray(grid.material)
    ? grid.material
    : [grid.material];
  for (const material of gridMaterials) {
    material.transparent = true;
    material.opacity = 0.32;
  }
  root.add(grid);

  return root;
}
