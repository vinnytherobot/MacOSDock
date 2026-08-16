import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import type St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import type { Intellihide, OverlapStatus } from "./intellihide.js";
import { SignalManager } from "./signalManager.js";

const HIDE_THRESHOLD = 100; // hide only when pointer is 100px+ above bottom

type Container = InstanceType<typeof St.BoxLayout>;

export class DockVisibility {
  private _signals: SignalManager;
  private _container: Container;
  private _intellihide: Intellihide;
  private _isShown = false;
  private _isAnimating = false;
  private _monitor: { x: number; y: number; width: number; height: number } | null = null;
  private _animationDuration: number;
  private _showThreshold: number;
  private _pollId: number | null = null;

  constructor(
    container: Container,
    intellihide: Intellihide,
    _dockHeight: number,
    _marginBottom: number,
    animationDuration: number = 200,
    showThreshold: number = 25,
  ) {
    this._signals = new SignalManager();
    this._container = container;
    this._intellihide = intellihide;
    this._animationDuration = animationDuration;
    this._showThreshold = showThreshold;
  }

  start(): void {
    this._monitor = Main.layoutManager.primaryMonitor;
    if (!this._monitor) {
      console.error("[macos-dock] No primary monitor available");
      return;
    }

    // Hide the dock by making it invisible.
    this._container.visible = false;
    this._isShown = false;

    this._intellihide.start((overlap: OverlapStatus) => {
      if (overlap && this._isShown) {
        this._hide();
      }
    });

    // Use the global stage motion-event to detect pointer near bottom.
    // This is more reliable than GLib.timeout_add in some GJS versions.
    this._signals.connect(global.stage, "motion-event", (_actor: unknown, event: unknown) => {
      try {
        const evt = event as { get_coords?: () => [boolean, number, number] };
        let y = 0;
        if (evt && typeof evt.get_coords === "function") {
          const [ok, , py] = evt.get_coords();
          if (ok) {
            y = py;
          }
        }
        this._check(y);
      } catch (e) {
        console.error("[macos-dock] motion-event error:", e);
      }
      return Clutter.EVENT_PROPAGATE;
    });
    this._pollId = GLib.timeout_add(150, 100, () => {
      try {
        const pointer = global.get_pointer();
        // get_pointer returns [x, y] in GNOME 50
        const y = pointer[1];
        this._check(y);
      } catch (e) {
        console.error("[macos-dock] poll error:", e);
      }
      return true; // SOURCE_CONTINUE
    });
  }

  updateAnimationDuration(duration: number): void {
    this._animationDuration = Math.max(0, Math.min(1000, duration));
  }

  stop(): void {
    this._signals.disconnectAll();
    if (this._pollId !== null) {
      GLib.source_remove(this._pollId);
      this._pollId = null;
    }
    this._intellihide.stop();
    this._container.visible = true;
  }

  isHidden(): boolean {
    return !this._isShown;
  }

  updateShownY(_y: number): void {}

  private _check(pointerY: number): void {
    if (!this._monitor) return;
    const bottom = this._monitor.y + this._monitor.height;

    // Hysteresis: different thresholds for show vs hide to prevent flickering.
    if (!this._isShown && pointerY >= bottom - this._showThreshold) {
      this._show();
    } else if (this._isShown && pointerY < bottom - HIDE_THRESHOLD) {
      this._hide();
    }
  }

  private _show(): void {
    if (this._isShown || this._isAnimating) return;
    this._isShown = true;
    this._isAnimating = true;

    if (this._animationDuration === 0) {
      this._container.visible = true;
      this._container.opacity = 255;
      this._isAnimating = false;
      return;
    }

    this._container.visible = true;
    this._container.opacity = 0;

    // Slide up animation + fade in
    const startY = this._container.y;
    this._container.y = startY + 20;

    this._container.ease({
      y: startY,
      opacity: 255,
      duration: this._animationDuration,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => {
        this._isAnimating = false;
      },
    });
  }

  private _hide(): void {
    if (!this._isShown || this._isAnimating) return;
    this._isShown = false;
    this._isAnimating = true;

    if (this._animationDuration === 0) {
      this._container.visible = false;
      this._isAnimating = false;
      return;
    }

    const startY = this._container.y;

    this._container.ease({
      y: startY + 20,
      opacity: 0,
      duration: this._animationDuration,
      mode: Clutter.AnimationMode.EASE_IN_QUAD,
      onComplete: () => {
        this._container.visible = false;
        this._container.y = startY;
        this._isAnimating = false;
      },
    });
  }
}
