import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import type { Intellihide, OverlapStatus } from "./intellihide.js";
import { SignalManager } from "./signalManager.js";
import type { WindowPreviewPopup } from "./windowPreview.js";

type Container = InstanceType<typeof St.BoxLayout>;

/**
 * Reveals the dock through a reactive screen-edge actor and hides it after a
 * debounced pointer check. While shown, the dock stays visible under the
 * pointer and while its preview or context menu is active.
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
  private _magnificationScale: number;
  private _edge: number;
  private _dockBounds: { x: number; y: number; width: number; height: number } | null = null;
  private _previewPopup: WindowPreviewPopup | null = null;
  private _contextMenuActor: InstanceType<typeof St.Widget> | null = null;
  private _edgeActivator: InstanceType<typeof St.Widget> | null = null;

  private _pointerX = 0;
  private _pointerY = 0;
  private _dragActive = false;

  private _shown = false;
  private _restingTranslationX = 0;
  private _restingTranslationY = 0;

  private _hideSourceId: number | null = null;
  private _animationSourceId: number | null = null;
  private _animationStartTime = 0;
  private _animationFromX = 0;
  private _animationFromY = 0;
  private _animationFromOpacity = 0;
  private _animationToX = 0;
  private _animationToY = 0;
  private _animationToOpacity = 0;

  constructor(
    container: Container,
    intellihide: Intellihide,
    dockHeight: number,
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
   * the delayed auto-hide check cannot slide the dock away underneath the pointer.
   */
  setDragActive(active: boolean): void {
    if (active === this._dragActive) return;
    this._dragActive = active;
    if (active) {
      this._show();
    } else {
      this._updatePointerState();
    }
  }

  setEdge(edge: number): void {
    this._edge = edge;
    this._updateEdgeActivatorBounds();
  }

  updateDockBounds(x: number, y: number, width: number, height: number): void {
    this._monitor = Main.layoutManager.primaryMonitor;
    this._dockBounds = { x, y, width, height };
    this._updateEdgeActivatorBounds();
  }

  isShown(): boolean {
    return this._shown;
  }

  isAnimating(): boolean {
    return this._animationSourceId !== null;
  }

  isHidden(): boolean {
    return !this._shown;
  }

  updateShownY(_y: number): void {}

  updateAnimationDuration(duration: number): void {
    this._animationDuration = Math.max(0, Math.min(1000, duration));
  }

  start(): void {
    this._cancelHide();
    this._cancelAnimation();

    this._monitor = Main.layoutManager.primaryMonitor;
    if (!this._monitor) {
      console.error("[macos-dock] No primary monitor available");
      return;
    }

    this._container.visible = false;
    this._container.opacity = 0;
    this._shown = false;
    this._dragActive = false;

    this._restingTranslationX = 0;
    this._restingTranslationY = 0;
    const [offsetX, offsetY] = this._getSlideOffset();
    this._container.translation_x = offsetX;
    this._container.translation_y = offsetY;

    this._edgeActivator = new St.Widget({
      name: "macos-dock-edge-activator",
      reactive: true,
      track_hover: true,
      opacity: 0,
    });
    Main.layoutManager.addChrome(this._edgeActivator, {
      affectsStruts: false,
      trackFullscreen: false,
    });
    this._updateEdgeActivatorBounds();
    this._signals.connect(this._edgeActivator, "enter-event", () => {
      const [x, y] = global.get_pointer();
      this._pointerX = x;
      this._pointerY = y;
      this._show();
      return Clutter.EVENT_PROPAGATE;
    });
    this._signals.connect(
      this._edgeActivator,
      "motion-event",
      (_actor: unknown, event: unknown) => {
        const [x, y] = (event as Clutter.Event).get_coords();
        this._pointerX = x;
        this._pointerY = y;
        this._show();
        return Clutter.EVENT_PROPAGATE;
      },
    );
    this._signals.connect(this._container, "enter-event", () => {
      const [x, y] = global.get_pointer();
      this._pointerX = x;
      this._pointerY = y;
      this._updatePointerState();
      return Clutter.EVENT_PROPAGATE;
    });
    this._signals.connect(this._container, "motion-event", (_actor: unknown, event: unknown) => {
      const [x, y] = (event as Clutter.Event).get_coords();
      this._pointerX = x;
      this._pointerY = y;
      this._updatePointerState();
      return Clutter.EVENT_PROPAGATE;
    });
    this._signals.connect(this._container, "leave-event", () => {
      const [x, y] = global.get_pointer();
      this._pointerX = x;
      this._pointerY = y;
      this._updatePointerState();
      return Clutter.EVENT_PROPAGATE;
    });

    this._intellihide.start((overlap: OverlapStatus) => {
      this._onIntellihideChanged(overlap);
    });

    this._signals.connect(global.stage, "motion-event", (_actor: unknown, event: unknown) => {
      const [px, py] = (event as Clutter.Event).get_coords();
      this._pointerX = px;
      this._pointerY = py;
      this._updatePointerState();
      return Clutter.EVENT_PROPAGATE;
    });

    const [x, y] = global.get_pointer();
    this._pointerX = x;
    this._pointerY = y;
    this._updatePointerState();
  }

  stop(): void {
    this._cancelHide();
    this._signals.disconnectAll();

    if (this._edgeActivator) {
      Main.layoutManager.removeChrome(this._edgeActivator);
      this._edgeActivator.destroy();
      this._edgeActivator = null;
    }

    this._cancelAnimation();
    this._dragActive = false;

    this._container.translation_x = 0;
    this._container.translation_y = 0;
    this._container.visible = true;
    this._container.opacity = 255;
  }

  private _updatePointerState(): void {
    if (!this._monitor) return;

    // The dock stays up for the whole duration of a drag-reorder; hiding it
    // mid-drag would pull the drop target out from under the pointer.
    if (this._dragActive) {
      this._cancelHide();
      return;
    }

    if (this._isPointerInPopupOrMenu()) {
      this._cancelHide();
      return;
    }

    if (this._isPointerInEdgeZone()) {
      this._show();
      return;
    }

    if (this._shown && this._isPointerInDockRegion()) {
      this._cancelHide();
      return;
    }

    if (this._shown) this._scheduleHide();
  }

  private _isPointerInPopupOrMenu(): boolean {
    if (this._previewPopup?.isVisible()) {
      const bounds = this._previewPopup.getBounds();
      if (
        bounds &&
        this._pointerX >= bounds.x &&
        this._pointerX <= bounds.x + bounds.width &&
        this._pointerY >= bounds.y &&
        this._pointerY <= bounds.y + bounds.height
      ) {
        return true;
      }
    }

    if (this._contextMenuActor?.mapped) {
      const [x, y] = this._contextMenuActor.get_transformed_position();
      const [width, height] = this._contextMenuActor.get_size();
      return (
        this._pointerX >= x &&
        this._pointerX <= x + width &&
        this._pointerY >= y &&
        this._pointerY <= y + height
      );
    }

    return false;
  }

  private _isPointerInDockRegion(): boolean {
    return this._isPointerInDockBounds() || this._isPointerOverDockActor();
  }

  private _scheduleHide(): void {
    if (this._hideSourceId !== null) return;

    this._hideSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
      this._hideSourceId = null;
      const [x, y] = global.get_pointer();
      this._pointerX = x;
      this._pointerY = y;

      if (
        this._shown &&
        !this._dragActive &&
        !this._isPointerInPopupOrMenu() &&
        !this._isPointerInEdgeZone() &&
        !this._isPointerInDockRegion()
      ) {
        this._hide();
      }

      return GLib.SOURCE_REMOVE;
    });
  }

  private _cancelHide(): void {
    if (this._hideSourceId === null) return;

    GLib.Source.remove(this._hideSourceId);
    this._hideSourceId = null;
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
    const bounds = this._dockBounds;
    if (!bounds) return false;

    const magnificationExtra = Math.max(0, this._dockHeight * (this._magnificationScale - 1));
    const alongDockExtra = magnificationExtra / 2;

    switch (this._edge) {
      case 0: {
        return (
          this._pointerX >= bounds.x - alongDockExtra &&
          this._pointerX <= bounds.x + bounds.width + alongDockExtra &&
          this._pointerY >= bounds.y - magnificationExtra &&
          this._pointerY <= bounds.y + bounds.height
        );
      }
      case 1: {
        return (
          this._pointerX >= bounds.x &&
          this._pointerX <= bounds.x + bounds.width + magnificationExtra &&
          this._pointerY >= bounds.y - alongDockExtra &&
          this._pointerY <= bounds.y + bounds.height + alongDockExtra
        );
      }
      case 2: {
        return (
          this._pointerX >= bounds.x - magnificationExtra &&
          this._pointerX <= bounds.x + bounds.width &&
          this._pointerY >= bounds.y - alongDockExtra &&
          this._pointerY <= bounds.y + bounds.height + alongDockExtra
        );
      }
      case 3: {
        return (
          this._pointerX >= bounds.x - alongDockExtra &&
          this._pointerX <= bounds.x + bounds.width + alongDockExtra &&
          this._pointerY >= bounds.y &&
          this._pointerY <= bounds.y + bounds.height + magnificationExtra
        );
      }
    }

    return false;
  }

  private _isPointerOverDockActor(): boolean {
    const actor = global.stage.get_actor_at_pos(
      Clutter.PickMode.REACTIVE,
      this._pointerX,
      this._pointerY,
    );
    return actor === this._container || (actor !== null && this._container.contains(actor));
  }

  private _updateEdgeActivatorBounds(): void {
    const monitor = this._monitor;
    const bounds = this._dockBounds;
    const activator = this._edgeActivator;
    if (!monitor || !bounds || !activator) return;

    const thickness = Math.max(2, this._showThreshold);
    switch (this._edge) {
      case 0:
        activator.set_position(bounds.x, monitor.y + monitor.height - thickness);
        activator.set_size(bounds.width, thickness);
        break;
      case 1:
        activator.set_position(monitor.x, bounds.y);
        activator.set_size(thickness, bounds.height);
        break;
      case 2:
        activator.set_position(monitor.x + monitor.width - thickness, bounds.y);
        activator.set_size(thickness, bounds.height);
        break;
      case 3:
        activator.set_position(bounds.x, monitor.y);
        activator.set_size(bounds.width, thickness);
        break;
    }
  }

  /**
   * Whether the pointer is anywhere in the interaction region (edge zone or
   * dock bounds). Used by the intellihide callback to keep the dock visible
   * while the pointer is near it.
   */
  private _isPointerInInteractionRegion(): boolean {
    return (
      this._isPointerInPopupOrMenu() || this._isPointerInEdgeZone() || this._isPointerInDockRegion()
    );
  }

  private _show(): void {
    this._cancelHide();
    if (this._shown) return;

    this._shown = true;
    this._animateVisibility(true);
  }

  private _hide(): void {
    if (!this._shown) return;

    this._shown = false;
    this._animateVisibility(false);
  }

  private _animateVisibility(show: boolean): void {
    this._cancelAnimation();
    this._container.visible = true;

    const [offsetX, offsetY] = this._getSlideOffset();
    this._animationFromX = this._container.translation_x;
    this._animationFromY = this._container.translation_y;
    this._animationFromOpacity = this._container.opacity;
    this._animationToX = show ? this._restingTranslationX : this._restingTranslationX + offsetX;
    this._animationToY = show ? this._restingTranslationY : this._restingTranslationY + offsetY;
    this._animationToOpacity = show ? 255 : 0;

    if (this._animationDuration === 0) {
      this._finishVisibilityAnimation(show);
      return;
    }

    this._animationStartTime = GLib.get_monotonic_time();
    this._animationSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      const elapsedMs = (GLib.get_monotonic_time() - this._animationStartTime) / 1000;
      const progress = Math.min(1, elapsedMs / this._animationDuration);
      const easedProgress = show ? 1 - (1 - progress) ** 2 : progress ** 2;

      this._container.translation_x =
        this._animationFromX + (this._animationToX - this._animationFromX) * easedProgress;
      this._container.translation_y =
        this._animationFromY + (this._animationToY - this._animationFromY) * easedProgress;
      this._container.opacity = Math.round(
        this._animationFromOpacity +
          (this._animationToOpacity - this._animationFromOpacity) * easedProgress,
      );

      if (progress < 1) return GLib.SOURCE_CONTINUE;

      this._animationSourceId = null;
      this._finishVisibilityAnimation(show);
      return GLib.SOURCE_REMOVE;
    });
  }

  private _finishVisibilityAnimation(show: boolean): void {
    this._container.translation_x = this._animationToX;
    this._container.translation_y = this._animationToY;
    this._container.opacity = this._animationToOpacity;
    this._container.visible = show;
  }

  private _cancelAnimation(): void {
    if (this._animationSourceId === null) return;

    GLib.Source.remove(this._animationSourceId);
    this._animationSourceId = null;
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
    if (this._dragActive) return;

    if (!overlap) {
      this._show();
      return;
    }

    if (this._shown && !this._isPointerInInteractionRegion()) {
      this._scheduleHide();
    }
  }
}
