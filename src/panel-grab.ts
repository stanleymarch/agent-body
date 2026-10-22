/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root of this source tree.
 */

/**
 * The panel's grab bar.
 *
 * The panel itself is a plain UI surface: it carries `RayInteractable` and
 * `PokeInteractable`, so the trigger clicks its buttons and a finger pokes
 * them. Moving the panel is the job of this handle - a small bar under the
 * panel, the way a Horizon panel has one.
 *
 * The bar is a separate object in the scene. Pointing at it and holding the
 * trigger or the grip takes the panel: the panel follows the pointer along
 * the ray, keeping the distance where it was caught, and the bar travels with
 * it. On release the panel turns towards the user again.
 *
 * The drag is handled here rather than by a `DistanceGrabbable` handle
 * because that handle would swallow the panel's button clicks, and the
 * direct-grip handle needs the controller to be within 7 cm of the bar.
 */

import { createSystem, RayInteractable, type Entity, type Object3D } from '@iwsdk/core';
import { BoxGeometry, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { HAPTIC_GRAB, HAPTIC_RELEASE, pulseHaptics } from './haptics.js';

/** Where the bar sits under the panel, in the panel's own units. */
const BAR_OFFSET = new Vector3(0, -0.82, 0.04);
/** Bar size in metres (the bar is not scaled with the panel). */
const BAR_WIDTH = 0.26;
const BAR_HEIGHT = 0.014;
const BAR_DEPTH = 0.018;
/** Button index of the trigger (0) and the grip (1) on the gamepad layout. */
const TRIGGER_BUTTON = 0;
const GRIP_BUTTON = 1;

interface DragState {
  readonly hand: 'left' | 'right';
  /** Distance from the ray origin to the panel when the drag started. */
  readonly distance: number;
  /** The point on the panel that was grabbed, in world space. */
  readonly anchor: Vector3;
}

export class PanelGrabSystem extends createSystem({}) {
  private panel: Object3D | undefined;
  private bar: Entity | undefined;
  private barMesh: Object3D | undefined;
  private drag: DragState | undefined;
  /** The pointer that is currently holding the bar. */
  private hand: 'left' | 'right' = 'right';

  /** Show the bar only while a session is running; on the desktop the panel
   * is a screen space overlay and the bar would float in the scene. */
  setVisible(visible: boolean): void {
    const bar = this.bar?.object3D;
    if (bar) bar.visible = visible;
  }

  init(): void {
    const world = this.world;
    this.panel = world.getSceneObject('agent-panel');
    if (!this.panel) return;
    const mesh = new Mesh(
      new BoxGeometry(BAR_WIDTH, BAR_HEIGHT, BAR_DEPTH),
      new MeshStandardMaterial({ color: 0x8f959b, roughness: 0.45, metalness: 0.15 }),
    );
    mesh.name = 'panel-grab-bar';
    // The bar belongs to the world space panel in an immersive session. On the
    // desktop the panel is a screen space overlay, so the bar must not be
    // created visible: it used to sit in the room as a grey strip until the
    // first mode change hid it.
    mesh.visible = false;
    const entity = world.createTransformEntity(mesh);
    entity.addComponent(RayInteractable);
    this.bar = entity;
    this.barMesh = mesh;
    this.park();
  }

  update(): void {
    const panel = this.panel;
    const bar = this.barMesh;
    if (!panel || !bar) return;
    const gamepads = this.world.input.xr?.gamepads;

    if (!this.drag) {
      for (const hand of ['left', 'right'] as const) {
        const pad = gamepads?.[hand];
        if (!pad) continue;
        const held = pad.getButtonPressedByIdx(TRIGGER_BUTTON) || pad.getButtonPressedByIdx(GRIP_BUTTON);
        if (!held) continue;
        const pointer = this.world.input.xr?.multiPointers?.[hand]?.getPointer('ray');
        const hit = pointer?.getIntersection();
        const ray = this.rayOf(pointer);
        if (!hit || !ray || !this.isBar(hit.object)) continue;
        const anchor = hit.point.clone();
        this.drag = { hand, distance: anchor.distanceTo(ray.origin), anchor };
        this.hand = hand;
        pulseHaptics(this.world, hand, HAPTIC_GRAB);
        break;
      }
    } else {
      const pad = gamepads?.[this.drag.hand];
      const held = pad
        ? pad.getButtonPressedByIdx(TRIGGER_BUTTON) || pad.getButtonPressedByIdx(GRIP_BUTTON)
        : false;
      if (!held) {
        this.drag = undefined;
        pulseHaptics(this.world, this.hand, HAPTIC_RELEASE);
        this.faceTheUser();
      } else {
        this.move();
      }
    }

    this.park();
  }

  /** Move the panel so the grabbed point stays under the pointer. */
  private move(): void {
    const drag = this.drag;
    const panel = this.panel;
    if (!drag || !panel) return;
    const pointer = this.world.input.xr?.multiPointers?.[drag.hand]?.getPointer('ray');
    const ray = this.rayOf(pointer);
    if (!ray) return;
    const target = ray.origin.clone().add(ray.direction.clone().multiplyScalar(drag.distance));
    const delta = target.sub(drag.anchor);
    if (delta.lengthSq() > 0) {
      panel.position.add(delta);
      panel.updateMatrixWorld(true);
      drag.anchor.add(delta);
    }
  }

  /** Put the bar back under the panel. */
  private park(): void {
    const panel = this.panel;
    const bar = this.bar;
    if (!panel || !bar?.object3D) return;
    const target = panel.localToWorld(BAR_OFFSET.clone());
    bar.object3D.position.copy(target);
    bar.object3D.quaternion.copy(panel.getWorldQuaternion(new Quaternion()));
    bar.object3D.updateMatrixWorld(true);
  }

  /** Turn the panel back towards the user after it was dragged around. */
  private faceTheUser(): void {
    const panel = this.panel;
    const head = this.world.player?.head;
    if (!panel || !head) return;
    const headPosition = head.getWorldPosition(new Vector3());
    panel.lookAt(headPosition);
    panel.updateMatrixWorld(true);
  }

  /** Is the object under the pointer the grab bar? */
  private isBar(object: Object3D): boolean {
    let node: Object3D | null = object;
    while (node) {
      if (node === this.barMesh) return true;
      node = node.parent;
    }
    return false;
  }

  /** The ray behind a pointer. */
  private rayOf(pointer: unknown): { origin: Vector3; direction: Vector3 } | undefined {
    const intersector = (pointer as { intersector?: { raycaster?: { ray?: { origin: Vector3; direction: Vector3 } } } })
      ?.intersector;
    return intersector?.raycaster?.ray;
  }
}
