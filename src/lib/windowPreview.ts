import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import type Meta from "gi://Meta";
import Shell from "gi://Shell";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { SignalManager } from "./signalManager.js";

type IconActor = InstanceType<typeof St.BoxLayout>;

interface ThumbData {
  actor: InstanceType<typeof St.BoxLayout>;
  metaWindow: Meta.Window;
  app: Shell.App;
}

const UPDATE_INTERVAL_MS = 200; // 5fps
const CLOSE_DELAY_MS = 300;
const MAX_COLUMNS = 4;

export class WindowPreviewPopup {
  private _signals: SignalManager;
  private _popup: InstanceType<typeof St.BoxLayout> | null = null;
  private _thumbs: ThumbData[] = [];
  private _updateTimer: number | null = null;
  private _closeTimer: number | null = null;
  private _refreshTimer: number | null = null;
  private _visible = false;
  private _previewWidth: number;
  private _lastIconActor: IconActor | null = null;

  constructor() {
    this._signals = new SignalManager();
    this._previewWidth = 200;
  }

  setPreviewWidth(width: number): void {
    this._previewWidth = width;
  }

  isVisible(): boolean {
    return this._visible;
  }

  /**
   * Returns the bounding rectangle of the popup so DockVisibility
   * can ignore pointer events inside it.
   */
  getBounds(): { x: number; y: number; width: number; height: number } | null {
    if (!this._popup || !this._visible) return null;
    const [x, y] = this._popup.get_transformed_position();
    const [w, h] = this._popup.get_size();
    return { x, y, width: w, height: h };
  }

  show(app: Shell.App, iconActor: IconActor): void {
    const windows = app.get_windows();
    if (windows.length === 0) return;

    // If already showing for the same app, do nothing
    if (this._visible && this._popup) {
      return;
    }

    this._lastIconActor = iconActor;
    // Destroy synchronously to avoid race condition with async hide animation
    this._destroyPopupSync();
    this._createPopup(app, windows, iconActor);
  }

  hide(): void {
    this._cancelCloseTimer();
    this._cancelRefreshTimer();
    this._stopUpdateTimer();

    if (this._popup) {
      this._animateOut(() => {
        this._destroyPopup();
      });
    }
  }

  scheduleHide(): void {
    this._cancelCloseTimer();
    this._closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLOSE_DELAY_MS, () => {
      this.hide();
      this._closeTimer = null;
      return GLib.SOURCE_REMOVE;
    });
  }

  cancelScheduledHide(): void {
    this._cancelCloseTimer();
  }

  stop(): void {
    this._cancelCloseTimer();
    this._cancelRefreshTimer();
    this._stopUpdateTimer();
    this._destroyPopup();
  }

  private _createPopup(app: Shell.App, windows: Meta.Window[], iconActor: IconActor): void {
    const grid = new St.BoxLayout({
      style_class: "macos-dock-preview-grid",
      vertical: false,
      reactive: true,
    });

    const columns = Math.min(windows.length, MAX_COLUMNS);
    const thumbHeight = Math.round(this._previewWidth * 0.625);
    const thumbSpacing = 6;

    let col = 0;
    let row = 0;
    const rows: ThumbData[][] = [];

    // First pass: non-minimized windows
    for (const metaWin of windows) {
      if (metaWin.minimized) continue;

      const thumbData = this._createThumb(app, metaWin, thumbHeight);
      this._thumbs.push(thumbData);

      if (!rows[row]) rows[row] = [];
      rows[row].push(thumbData);

      col++;
      if (col >= columns) {
        col = 0;
        row++;
      }
    }

    // If all windows are minimized, show them with reduced opacity
    if (this._thumbs.length === 0) {
      for (const metaWin of windows) {
        const thumbData = this._createThumb(app, metaWin, thumbHeight);
        thumbData.actor.opacity = 128;
        this._thumbs.push(thumbData);

        if (!rows[row]) rows[row] = [];
        rows[row].push(thumbData);

        col++;
        if (col >= columns) {
          col = 0;
          row++;
        }
      }
    }

    // Build row layout
    for (const rowData of rows) {
      const rowBox = new St.BoxLayout({
        style_class: "macos-dock-preview-row",
        vertical: false,
      });
      rowBox.set_style(`spacing: ${thumbSpacing}px;`);
      for (const thumbData of rowData) {
        rowBox.add_child(thumbData.actor);
      }
      grid.add_child(rowBox);
    }

    // Create outer popup container
    this._popup = new St.BoxLayout({
      style_class: "macos-dock-preview-popup",
      vertical: true,
      reactive: true,
    });
    this._popup.add_child(grid);

    // Keep popup open when mouse is over it
    this._signals.connect(this._popup, "enter-event", () => {
      this.cancelScheduledHide();
      return Clutter.EVENT_PROPAGATE;
    });
    this._signals.connect(this._popup, "leave-event", () => {
      this.scheduleHide();
      return Clutter.EVENT_PROPAGATE;
    });

    Main.layoutManager.addTopChrome(this._popup);

    // Position the popup
    this._positionPopup(iconActor);

    // Animate in
    this._animateIn();

    // Start thumbnail updates
    this._startUpdateTimer();
  }

  private _createThumb(app: Shell.App, metaWin: Meta.Window, thumbHeight: number): ThumbData {
    const thumbBox = new St.BoxLayout({
      style_class: "macos-dock-preview-thumb",
      vertical: true,
      reactive: true,
      x_align: Clutter.ActorAlign.CENTER,
    });

    // Window thumbnail using Clutter.Clone of the window actor
    const windowActors = global.get_window_actors();
    for (const wa of windowActors) {
      const metaWin2 = (wa as unknown as Record<string, unknown>).meta_window;
      if (metaWin2 === metaWin) {
        const clone = new Clutter.Clone({
          source: wa,
          x_align: Clutter.ActorAlign.CENTER,
        });
        // Scale the clone to fit the thumbnail width
        const [actorWidth, actorHeight] = wa.get_size();
        if (actorWidth > 0 && actorHeight > 0) {
          const scale = this._previewWidth / actorWidth;
          clone.set_size(this._previewWidth, Math.round(actorHeight * scale));
        }
        thumbBox.add_child(clone);
        break;
      }
    }

    // Window title
    const title = metaWin.get_title() || "Window";
    const titleLabel = new St.Label({
      style_class: "macos-dock-preview-title",
      text: title,
      x_align: Clutter.ActorAlign.CENTER,
    });
    thumbBox.add_child(titleLabel);

    // Close button
    const closeBtn = new St.Button({
      style_class: "macos-dock-preview-close-btn",
      x_align: Clutter.ActorAlign.END,
      y_align: Clutter.ActorAlign.START,
      label: "×",
      reactive: true,
    });
    closeBtn.set_pivot_point(1.0, 0.0);
    closeBtn.connect("clicked", () => {
      metaWin.delete(global.get_current_time());
      if (this._refreshTimer !== null) {
        GLib.source_remove(this._refreshTimer);
        this._refreshTimer = null;
      }
      this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        this._refreshAfterClose(app);
        this._refreshTimer = null;
        return GLib.SOURCE_REMOVE;
      });
    });
    closeBtn.connect("button-press-event", () => Clutter.EVENT_STOP);
    thumbBox.add_child(closeBtn);

    // Click to focus this window
    this._signals.connect(thumbBox, "button-press-event", (_actor, event) => {
      const button = (event as { get_button: () => number }).get_button();
      if (button === 1) {
        if (metaWin.minimized) {
          metaWin.unminimize();
        }
        metaWin.activate(global.get_current_time());
        this.hide();
      }
      return Clutter.EVENT_STOP;
    });

    // Highlight focused window
    if (metaWin.has_focus()) {
      thumbBox.add_style_class_name("macos-dock-preview-focused");
    }

    // Set size
    const thumbWidth = this._previewWidth;
    thumbBox.set_size(thumbWidth, thumbHeight + 24);

    return { actor: thumbBox, metaWindow: metaWin, app };
  }

  private _positionPopup(iconActor: IconActor): void {
    if (!this._popup) return;

    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;

    const [iconX, iconY] = iconActor.get_transformed_position();
    const [iconW, iconH] = iconActor.get_size();
    const [, popupW] = this._popup.get_preferred_width(-1);
    const [, popupH] = this._popup.get_preferred_height(-1);

    // Try positioning above the icon first
    let x = iconX + (iconW - popupW) / 2;
    let y = iconY - popupH - 10;

    // If it goes above the screen, position below
    if (y < monitor.y) {
      y = iconY + iconH + 10;
    }

    // Clamp horizontal to monitor bounds
    if (x < monitor.x) {
      x = monitor.x + 4;
    } else if (x + popupW > monitor.x + monitor.width) {
      x = monitor.x + monitor.width - popupW - 4;
    }

    this._popup.set_position(Math.round(x), Math.round(y));
  }

  private _animateIn(): void {
    if (!this._popup) return;
    this._popup.opacity = 0;
    const startY = this._popup.y;
    this._popup.y = startY + 10;
    this._popup.ease({
      opacity: 255,
      y: startY,
      duration: 150,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => {
        this._visible = true;
      },
    });
  }

  private _animateOut(onComplete: () => void): void {
    if (!this._popup) {
      onComplete();
      return;
    }
    const popupRef = this._popup;
    const startY = this._popup.y;
    this._popup.ease({
      opacity: 0,
      y: startY + 10,
      duration: 120,
      mode: Clutter.AnimationMode.EASE_IN_QUAD,
      onComplete: () => {
        this._visible = false;
        // Only call onComplete if the popup hasn't been replaced
        if (this._popup === popupRef) {
          onComplete();
        }
      },
    });
  }

  private _startUpdateTimer(): void {
    this._stopUpdateTimer();
    this._updateTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, UPDATE_INTERVAL_MS, () => {
      this._updateFocusHighlights();
      return GLib.SOURCE_CONTINUE;
    });
  }

  private _stopUpdateTimer(): void {
    if (this._updateTimer !== null) {
      GLib.source_remove(this._updateTimer);
      this._updateTimer = null;
    }
  }

  private _updateFocusHighlights(): void {
    const tracker = Shell.WindowTracker.get_default();
    for (const thumb of this._thumbs) {
      const isFocused = tracker.focus_app === thumb.app && thumb.metaWindow.has_focus();
      if (isFocused) {
        if (!thumb.actor.has_style_class_name("macos-dock-preview-focused")) {
          thumb.actor.add_style_class_name("macos-dock-preview-focused");
        }
      } else {
        thumb.actor.remove_style_class_name("macos-dock-preview-focused");
      }
    }
  }

  private _refreshAfterClose(app: Shell.App): void {
    if (!this._visible) return;

    const windows = app.get_windows();
    if (windows.length === 0) {
      this.hide();
      return;
    }

    // Rebuild the popup
    this._destroyPopup();
    if (this._lastIconActor) {
      this._createPopup(app, windows, this._lastIconActor);
    }
  }

  private _destroyPopupSync(): void {
    this._cancelCloseTimer();
    this._cancelRefreshTimer();
    this._stopUpdateTimer();
    this._destroyPopup();
  }

  private _destroyPopup(): void {
    this._stopUpdateTimer();

    for (const thumb of this._thumbs) {
      thumb.actor.destroy();
    }
    this._thumbs = [];

    if (this._popup) {
      this._signals.disconnectAll();
      Main.layoutManager.removeChrome(this._popup);
      this._popup.destroy();
      this._popup = null;
    }

    this._visible = false;
  }

  private _cancelCloseTimer(): void {
    if (this._closeTimer !== null) {
      GLib.source_remove(this._closeTimer);
      this._closeTimer = null;
    }
  }

  private _cancelRefreshTimer(): void {
    if (this._refreshTimer !== null) {
      GLib.source_remove(this._refreshTimer);
      this._refreshTimer = null;
    }
  }
}
