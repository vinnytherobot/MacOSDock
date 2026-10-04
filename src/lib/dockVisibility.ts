import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import type St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import type { Intellihide, OverlapStatus } from "./intellihide.js";
import { SignalManager } from "./signalManager.js";
import type { WindowPreviewPopup } from "./windowPreview.js";

type Container = InstanceType<typeof St.BoxLayout>;

/**
 * Manages auto-hide visibility using a stable interaction region instead of
 * fixed screen-edge thresholds. The region covers the screen edge zone, the
 * dock's resting bounds, and the magnification envelope. Once the pointer
 * enters this region the dock stays visible until the pointer fully leaves.
 *
 * Intellihide overlap changes are routed through the pointer-position check
 * so that a maximized window behind the dock does not cause a show/hide
 * feedback loop.
 *
 * Animations use translation_x/translation_y instead of modifying the
 * container's layout-owned position, avoiding conflicts with
 * DockManager._updatePosition().
 */
export class DockVisibility {
  private _signals: SignalManager;
  private _container: Container;
  private _intellihide: Intellihide;
  private _monitor: { x: number; y: number; width: number; height: number } | null = null;
  private _animationDuration: number;
  private _showThreshold: number;
  private _dockHeight: number;
  private _marginBottom: number;
  private _magnificationScale: number;
  private _edge: number;
  private _previewPopup: WindowPreviewPopup | null = null;
  private _contextMenuActor: InstanceType<typeof St.Widget> | null = null;

  private _pointerX = 0;
  private _pointerY = 0;
  private _dragActive = false;

  // Latches true when the pointer first enters the edge zone to show the dock.
  // While true the dock stays visible as long as the pointer is anywhere in the
  // interaction region (edge zone OR dock bounds). Resets when the dock hides.
  private _interactionActive = false;

  private _shown = false;
  private _animating = false;
  private _animation: unknown = null;
  private _restingTranslationX = 0;
  private _restingTranslationY = 0;

  private _pollId: number | null = null;

  constructor(
    container: Container,
    intellihide: Intellihide,
    dockHeight: number,
    marginBottom: number,
    animationDuration: number = 200,
    showThreshold: number = 25,
    edge: number = 0,
    magnificationScale: number = 1.0,
  ) {
    this._signals = new SignalManager();
    this._container = container;
    this._intellihide = intellihide;
    this._animationDuration = animationDuration;
    this._showThreshold = showThreshold;
    this._dockHeight = dockHeight;
    this._marginBottom = marginBottom;
    this._magnificationScale = magnificationScale;
    this._edge = edge;
  }

  setPreviewPopup(popup: WindowPreviewPopup): void {
    this._previewPopup = popup;
  }

  setContextMenuActor(actor: InstanceType<typeof St.Widget> | null): void {
    this._contextMenuActor = actor;
  }

  /**
   * Hold the dock in its shown state while a drag-reorder is in progress so
   * the auto-hide poll cannot slide the dock away underneath the pointer.
   */
  setDragActive(active: boolean): void {
    if (active === this._dragActive) return;
    this._dragActive = active;
    if (active) {
      this._interactionActive = true;
      this._show();
    } else {
      this._check();
    }
  }

  setEdge(edge: number): void {
    this._edge = edge;
  }

  isShown(): boolean {
    return this._shown;
  }

  isAnimating(): boolean {
    return this._animating;
  }

  isHidden(): boolean {
    return !this._shown;
  }

  updateShownY(_y: number): void {}

  updateAnimationDuration(duration: number): void {
    this._animationDuration = Math.max(0, Math.min(1000, duration));
  }

  start(): void {
    this._monitor = Main.layoutManager.primaryMonitor;
    if (!this._monitor) {
      console.error("[macos-dock] No primary monitor available");
      return;
    }

    this._container.visible = false;
    this._container.opacity = 0;
    this._shown = false;
    this._interactionActive = false;
    this._dragActive = false;

    this._container.translation_x = 0;
    this._container.translation_y = 0;
    this._restingTranslationX = 0;
    this._restingTranslationY = 0;

    this._intellihide.start((overlap: OverlapStatus) => {
      this._onIntellihideChanged(overlap);
    });

    if (this._pollId !== null) {
      GLib.source_remove(this._pollId);
      this._pollId = null;
    }

    this._signals.connect(global.stage, "motion-event", (_actor: unknown, event: unknown) => {
      const [px, py] = (event as Clutter.Event).get_coords();
      this._pointerX = px;
      this._pointerY = py;
      this._check();
      return Clutter.EVENT_PROPAGATE;
    });

    this._pollId = GLib.timeout_add(GLib.PRIORITY_LOW, 100, () => {
      const [x, y] = global.get_pointer();
      this._pointerX = x;
      this._pointerY = y;
      this._check();
      return true;
    });
  }

  stop(): void {
    if (this._pollId !== null) {
      GLib.source_remove(this._pollId);
      this._pollId = null;
    }

    this._signals.disconnectAll();

    this._intellihide.stop();

    if (this._animation) {
      (this._animation as { cancel: () => void }).cancel();
    }
    this._animation = null;
    this._animating = false;
    this._dragActive = false;

    this._container.translation_x = 0;
    this._container.translation_y = 0;
    this._container.visible = true;
    this._container.opacity = 255;
  }

  private _check(): void {
    if (!this._monitor) return;

    // The dock stays up for the whole duration of a drag-reorder; hiding it
    // mid-drag would pull the drop target out from under the pointer.
    if (this._dragActive) return;

    if (this._previewPopup?.isVisible()) {
      const bounds = this._previewPopup.getBounds();
      if (bounds) {
        const insidePopup =
          this._pointerX >= bounds.x &&
          this._pointerX <= bounds.x + bounds.width &&
          this._pointerY >= bounds.y &&
          this._pointerY <= bounds.y + bounds.height;
        if (insidePopup) return;
      }
    }

    if (this._contextMenuActor?.mapped) {
      const [mx, my] = this._contextMenuActor.get_transformed_position();
      const [mw, mh] = this._contextMenuActor.get_size();
      if (
        this._pointerX >= mx &&
        this._pointerX <= mx + mw &&
        this._pointerY >= my &&
        this._pointerY <= my + mh
      ) {
        return;
      }
    }

    const pointerInEdgeZone = this._isPointerInEdgeZone();
    const pointerInDock = this._isPointerInDockBounds();
    const pointerInRegion = pointerInEdgeZone || pointerInDock;

    if (pointerInEdgeZone) {
      this._interactionActive = true;
    }

    if (this._interactionActive && !this._shown) {
      this._show();
    } else if (!pointerInRegion && (this._shown || this._animating)) {
      this._interactionActive = false;
      this._hide();
    }
  }

  /**
   * Whether the pointer is inside the screen-edge activation zone.
   * The dock only shows when the pointer enters this narrow zone.
   */
  private _isPointerInEdgeZone(): boolean {
    if (!this._monitor) return false;

    switch (this._edge) {
      case 0:
        return this._pointerY >= this._monitor.y + this._monitor.height - this._showThreshold;
      case 1:
        return this._pointerX <= this._monitor.x + this._showThreshold;
      case 2:
        return this._pointerX >= this._monitor.x + this._monitor.width - this._showThreshold;
      case 3:
        return this._pointerY <= this._monitor.y + this._showThreshold;
    }

    return false;
  }

  /**
   * Whether the pointer is over the dock's resting bounds extended by the
   * magnification envelope. Used to keep the dock visible while the pointer
   * is on the dock itself.
   */
  private _isPointerInDockBounds(): boolean {
    if (!this._monitor) return false;

    const magnificationExtra = this._dockHeight * (this._magnificationScale - 1);

    switch (this._edge) {
      case 0: {
        const dockTop =
          this._monitor.y + this._monitor.height - this._dockHeight - this._marginBottom;
        return this._pointerY >= dockTop - magnificationExtra;
      }
      case 1: {
        const dockLeft = this._monitor.x + this._marginBottom;
        return this._pointerX <= dockLeft + magnificationExtra;
      }
      case 2: {
        const dockRight =
          this._monitor.x + this._monitor.width - this._dockHeight - this._marginBottom;
        return this._pointerX >= dockRight - magnificationExtra;
      }
      case 3: {
        const dockTop = this._monitor.y + this._marginBottom;
        return this._pointerY <= dockTop + magnificationExtra;
      }
    }

    return false;
  }

  /**
   * Whether the pointer is anywhere in the interaction region (edge zone or
   * dock bounds). Used by the intellihide callback to keep the dock visible
   * while the pointer is near it.
   */
  private _isPointerInInteractionRegion(): boolean {
    return this._isPointerInEdgeZone() || this._isPointerInDockBounds();
  }

  private _show(): void {
    if (this._animating) {
      (this._animation as { cancel: () => void })?.cancel();
      this._animation = null;
      this._animating = false;
    }
    if (this._shown) return;

    this._shown = true;

    if (this._animationDuration === 0) {
      this._container.visible = true;
      this._container.opacity = 255;
      this._container.translation_x = this._restingTranslationX;
      this._container.translation_y = this._restingTranslationY;
      return;
    }

    this._animating = true;
    this._container.visible = true;
    this._container.opacity = 0;

    const [offsetX, offsetY] = this._getSlideOffset();
    this._container.translation_x = this._restingTranslationX + offsetX;
    this._container.translation_y = this._restingTranslationY + offsetY;

    this._animation = this._container.ease({
      translationX: this._restingTranslationX,
      translationY: this._restingTranslationY,
      opacity: 255,
      duration: this._animationDuration,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => {
        this._animating = false;
        this._animation = null;
      },
    });
  }

  private _hide(): void {
    if (!this._shown && !this._animating) return;

    this._shown = false;

    if (this._animationDuration === 0) {
      this._container.visible = false;
      this._container.opacity = 0;
      this._container.translation_x = this._restingTranslationX;
      this._container.translation_y = this._restingTranslationY;
      this._animating = false;
      return;
    }

    if (this._animating) return;

    this._animating = true;

    const [offsetX, offsetY] = this._getSlideOffset();
    this._animation = this._container.ease({
      translationX: this._restingTranslationX + offsetX,
      translationY: this._restingTranslationY + offsetY,
      opacity: 0,
      duration: this._animationDuration,
      mode: Clutter.AnimationMode.EASE_IN_QUAD,
      onComplete: () => {
        this._container.visible = false;
        this._container.translation_x = this._restingTranslationX;
        this._container.translation_y = this._restingTranslationY;
        this._container.opacity = 0;
        this._animating = false;
        this._animation = null;
      },
    });
  }

  private _getSlideOffset(): [number, number] {
    const slideDistance = 20;
    switch (this._edge) {
      case 0:
        return [0, slideDistance];
      case 1:
        return [-slideDistance, 0];
      case 2:
        return [slideDistance, 0];
      case 3:
        return [0, -slideDistance];
    }
    return [0, slideDistance];
  }

  private _onIntellihideChanged(overlap: OverlapStatus): void {
    if (!overlap) return;
    if (this._dragActive) return;

    if (this._shown && !this._isPointerInInteractionRegion()) {
      this._hide();
    }
  }
}
