import Clutter from "gi://Clutter";
import type Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { DockVisibility } from "./dockVisibility.js";
import { IconManager } from "./iconManager.js";
import { Intellihide } from "./intellihide.js";
import { Magnification } from "./magnification.js";
import { SignalManager } from "./signalManager.js";

const POSITIONS = { BOTTOM: 0, LEFT: 1, RIGHT: 2, TOP: 3 } as const;

export class DockManager {
  private _signals: SignalManager;
  private _container: InstanceType<typeof St.BoxLayout> | null = null;
  private _intellihide: Intellihide | null = null;
  private _visibility: DockVisibility | null = null;
  private _iconManager: IconManager | null = null;
  private _magnification: Magnification | null = null;
  private _settings: Gio.Settings | null = null;
  private _lastFocusedApp: Shell.App | null = null;
  private _recentlyLaunched: Set<string> = new Set();
  private _debounceSourceId: number | null = null;
  private _originalDashVisible?: boolean;
  private _dockPosition: number = POSITIONS.BOTTOM;
  private _blurEffect: Shell.BlurEffect | null = null;

  private static readonly MARGIN_BOTTOM = 12;
  private static readonly MIN_DOCK_WIDTH = 300;
  private static readonly LAUNCH_DEBOUNCE_MS = 400;

  constructor() {
    this._signals = new SignalManager();
  }

  private get _dockHeight(): number {
    const iconSize = this._settings?.get_int("icon-size") ?? 48;
    return iconSize + 16; // icon height (padded + indicator)
  }

  enable(settings: Gio.Settings): void {
    this._settings = settings;

    // Hide the default GNOME dash to avoid conflict.
    this._hideDefaultDash();

    this._container = new St.BoxLayout({
      style_class: "macos-dock-container",
      vertical: false,
      reactive: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.END,
    });

    Main.layoutManager.addTopChrome(this._container);

    // Icon manager: populates the container with app buttons.
    this._iconManager = new IconManager(
      this._container,
      settings.get_int("icon-size"),
      settings.get_boolean("running-indicators"),
      settings.get_int("icon-quality"),
      settings.get_int("running-indicator-style"),
    );
    this._iconManager.setOnClicked((app) => this._onAppClicked(app));
    this._iconManager.setOnIconsChanged(() => this._updatePosition());
    this._iconManager.start();

    // Magnification: scale icons on hover.
    this._magnification = new Magnification(
      this._container,
      settings.get_boolean("magnification-enabled"),
      settings.get_double("magnification-scale"),
      settings.get_int("magnification-falloff"),
      settings.get_int("magnification-framerate"),
    );
    this._magnification.start();

    this._applyDockStyle();
    this._applyDockPosition();
    this._registerKeybindings();
    this._updatePosition();
    this._signals.connect(global.display, "workareas-changed", () => this._updatePosition());

    // Watch for newly launched apps so we can bounce their dock icon.
    const tracker = Shell.WindowTracker.get_default();
    this._signals.connect(tracker, "notify::focus-app", () => this._onFocusAppChanged());

    // Live settings.
    this._signals.connect(settings, "changed::icon-size", () => {
      if (this._iconManager) {
        this._iconManager.setIconSize(settings.get_int("icon-size"));
      }
      this._updatePosition();
    });
    this._signals.connect(settings, "changed::auto-hide", () => {
      if (settings.get_boolean("auto-hide")) {
        this._startAutoHide();
      } else {
        this._stopAutoHide();
      }
    });
    this._signals.connect(settings, "changed::magnification-enabled", () => {
      if (this._magnification) {
        this._magnification.setEnabled(settings.get_boolean("magnification-enabled"));
      }
    });
    this._signals.connect(settings, "changed::magnification-scale", () => {
      if (this._magnification) {
        this._magnification.setMaxScale(settings.get_double("magnification-scale"));
      }
    });
    this._signals.connect(settings, "changed::magnification-falloff", () => {
      if (this._magnification) {
        this._magnification.setFalloffDistance(settings.get_int("magnification-falloff"));
      }
    });
    this._signals.connect(settings, "changed::running-indicators", () => {
      if (this._iconManager) {
        this._iconManager.setRunningIndicatorsEnabled(settings.get_boolean("running-indicators"));
      }
    });
    this._signals.connect(settings, "changed::animation-duration", () => {
      if (this._visibility) {
        this._visibility.updateAnimationDuration(settings.get_int("animation-duration"));
      }
    });
    this._signals.connect(settings, "changed::magnification-framerate", () => {
      if (this._magnification) {
        this._magnification.setFramerate(settings.get_int("magnification-framerate"));
      }
    });
    this._signals.connect(settings, "changed::icon-quality", () => {
      if (this._iconManager) {
        this._iconManager.setQuality(settings.get_int("icon-quality"));
      }
    });
    this._signals.connect(settings, "changed::running-indicator-style", () => {
      if (this._iconManager) {
        this._iconManager.setIndicatorStyle(settings.get_int("running-indicator-style"));
      }
    });
    this._signals.connect(settings, "changed::show-threshold", () => {
      if (this._visibility && settings.get_boolean("auto-hide")) {
        this._startAutoHide();
      }
    });
    this._signals.connect(settings, "changed::dock-opacity", () => this._applyDockStyle());
    this._signals.connect(settings, "changed::dock-background-color", () => this._applyDockStyle());
    this._signals.connect(settings, "changed::dock-border-radius", () => this._applyDockStyle());
    this._signals.connect(settings, "changed::dock-blur-enabled", () => this._applyDockStyle());
    this._signals.connect(settings, "changed::dock-position", () => this._applyDockPosition());
    this._signals.connect(settings, "changed::show-applications-button", () => {
      if (this._iconManager) {
        this._iconManager.setShowAppButton(settings.get_boolean("show-applications-button"));
      }
      this._updatePosition();
    });
    this._signals.connect(settings, "changed::enable-keyboard-nav", () => {
      this._removeKeybindings();
      this._registerKeybindings();
    });

    if (settings.get_boolean("auto-hide")) {
      this._startAutoHide();
    }
  }

  disable(): void {
    if (this._visibility) {
      this._visibility.stop();
      this._visibility = null;
    }

    if (this._intellihide) {
      this._intellihide.stop();
      this._intellihide = null;
    }

    if (this._iconManager) {
      this._iconManager.stop();
      this._iconManager = null;
    }

    if (this._magnification) {
      this._magnification.stop();
      this._magnification = null;
    }

    this._removeKeybindings();
    this._signals.disconnectAll();

    if (this._debounceSourceId !== null) {
      GLib.source_remove(this._debounceSourceId);
      this._debounceSourceId = null;
    }

    if (this._container) {
      Main.layoutManager.removeChrome(this._container);
      this._container.destroy();
      this._container = null;
    }

    // Restore the default GNOME dash.
    this._showDefaultDash();

    this._settings = null;
  }

  private _startAutoHide(): void {
    if (!this._container || !this._settings) return;

    // Clean up any existing auto-hide before creating new.
    this._stopAutoHide();

    this._intellihide = new Intellihide();
    this._visibility = new DockVisibility(
      this._container,
      this._intellihide,
      this._dockHeight,
      DockManager.MARGIN_BOTTOM,
      this._settings.get_int("animation-duration"),
      this._settings.get_int("show-threshold"),
      this._dockPosition,
    );
    // Must set dock rect AFTER creating intellihide so it can detect overlap.
    this._updatePosition();
    this._visibility.start();
  }

  private _stopAutoHide(): void {
    if (this._visibility) {
      this._visibility.stop();
      this._visibility = null;
    }
    if (this._intellihide) {
      this._intellihide.stop();
      this._intellihide = null;
    }
    if (this._container) {
      this._container.visible = true;
      this._container.opacity = 255;
      this._updatePosition();
    }
  }

  private _onAppClicked(app: Shell.App): void {
    const firstWindow = this._findFirstWindow(app);

    if (firstWindow) {
      if (firstWindow.has_focus() && !firstWindow.minimized) {
        // Window is focused and visible — minimize it.
        firstWindow.minimize();
      } else if (firstWindow.minimized) {
        // Window is minimized — restore and activate.
        firstWindow.unminimize();
        firstWindow.activate(global.get_current_time());
      } else {
        // Window exists but not focused — activate it.
        firstWindow.activate(global.get_current_time());
      }
    } else {
      app.open_new_window(-1);
    }
  }

  private _findFirstWindow(app: Shell.App) {
    const tracker = Shell.WindowTracker.get_default();
    const windows = global.get_window_actors();
    for (const wa of windows) {
      const metaWin = wa.get_meta_window();
      if (!metaWin) continue;
      if (tracker.get_window_app(metaWin) === app) {
        return metaWin;
      }
    }
    return null;
  }

  private _onFocusAppChanged(): void {
    if (!this._settings) return;
    if (!this._settings.get_boolean("bounce-on-launch")) return;
    if (!this._iconManager) return;

    const tracker = Shell.WindowTracker.get_default();
    const app = tracker.focus_app;
    if (!app) {
      this._lastFocusedApp = null;
      return;
    }
    const appId = app.get_id();
    if (this._lastFocusedApp === app) return;
    this._lastFocusedApp = app;

    if (this._recentlyLaunched.has(appId)) return;
    this._recentlyLaunched.add(appId);

    if (this._debounceSourceId !== null) {
      GLib.source_remove(this._debounceSourceId);
    }

    this._debounceSourceId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      DockManager.LAUNCH_DEBOUNCE_MS,
      () => {
        this._recentlyLaunched.delete(appId);
        this._debounceSourceId = null;
        return GLib.SOURCE_REMOVE;
      },
    );

    this._iconManager.bounceForApp(app);
  }

  private _updatePosition(): void {
    if (!this._container) return;

    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;

    const iconCount = this._iconManager?.getIconCount() ?? 0;
    const hasSeparator = this._iconManager?.hasSeparator() ?? false;
    const hasAppButton = this._iconManager?.hasAppButton() ?? false;
    const iconPadded = (this._settings?.get_int("icon-size") ?? 48) + 12;
    const spacing = 6;
    const padding = 20;
    const separatorWidth = 9; // 1px width + 4px margin each side
    const contentSize =
      iconCount > 0
        ? iconCount * iconPadded +
          (iconCount - 1) * spacing +
          (hasSeparator ? separatorWidth + spacing : 0) +
          (hasAppButton ? iconPadded + spacing : 0)
        : hasAppButton
          ? iconPadded
          : 0;
    const dockAxisSize = Math.max(contentSize + padding, DockManager.MIN_DOCK_WIDTH);

    let x = 0;
    let y = 0;
    let w = 0;
    let h = 0;

    switch (this._dockPosition) {
      case POSITIONS.BOTTOM:
        w = dockAxisSize;
        h = this._dockHeight;
        x = monitor.x + Math.floor((monitor.width - w) / 2);
        y = monitor.y + monitor.height - h - DockManager.MARGIN_BOTTOM;
        break;
      case POSITIONS.TOP:
        w = dockAxisSize;
        h = this._dockHeight;
        x = monitor.x + Math.floor((monitor.width - w) / 2);
        y = monitor.y + DockManager.MARGIN_BOTTOM;
        break;
      case POSITIONS.LEFT:
        w = this._dockHeight;
        h = dockAxisSize;
        x = monitor.x + DockManager.MARGIN_BOTTOM;
        y = monitor.y + Math.floor((monitor.height - h) / 2);
        break;
      case POSITIONS.RIGHT:
        w = this._dockHeight;
        h = dockAxisSize;
        x = monitor.x + monitor.width - w - DockManager.MARGIN_BOTTOM;
        y = monitor.y + Math.floor((monitor.height - h) / 2);
        break;
    }

    this._container.set_size(w, h);
    this._container.set_position(x, y);

    if (this._visibility) {
      this._visibility.updateShownY(y);
    }

    if (this._intellihide) {
      this._intellihide.setDockRect(x, y, w, h);
    }
  }

  private _hideDefaultDash(): void {
    const dash = Main.overview.dash;
    this._originalDashVisible = dash.visible;
    dash.hide();
    const dashSpacer = (dash as unknown as { _dashSpacer?: St.Widget })._dashSpacer;
    if (dashSpacer) {
      dashSpacer.visible = false;
    }
  }

  private _showDefaultDash(): void {
    const dash = Main.overview.dash;
    dash.visible = this._originalDashVisible ?? true;
    const dashSpacer = (dash as unknown as { _dashSpacer?: St.Widget })._dashSpacer;
    if (dashSpacer) {
      dashSpacer.visible = true;
    }
  }

  private _applyDockStyle(): void {
    if (!this._container || !this._settings) return;

    const opacity = this._settings.get_int("dock-opacity");
    const color = this._settings.get_string("dock-background-color");
    const radius = this._settings.get_int("dock-border-radius");
    const blurEnabled = this._settings.get_boolean("dock-blur-enabled");

    // Parse hex color
    const r = parseInt(color.slice(1, 3), 16) || 30;
    const g = parseInt(color.slice(3, 5), 16) || 30;
    const b = parseInt(color.slice(5, 7), 16) || 30;
    const alpha = opacity / 100;

    this._container.style = `
      background-color: rgba(${r}, ${g}, ${b}, ${alpha});
      border-radius: ${radius}px;
      padding: 4px 10px;
      spacing: 6px;
    `;

    // Handle blur effect
    if (blurEnabled && !this._blurEffect) {
      this._blurEffect = new Shell.BlurEffect();
      this._blurEffect.set({ sigma: 30, mode: Shell.BlurMode.BACKGROUND });
      this._container.add_effect(this._blurEffect);
    } else if (!blurEnabled && this._blurEffect) {
      this._container.remove_effect(this._blurEffect);
      this._blurEffect = null;
    }
  }

  private _applyDockPosition(): void {
    if (!this._container) return;

    this._dockPosition = this._settings?.get_int("dock-position") ?? POSITIONS.BOTTOM;

    const isVertical =
      this._dockPosition === POSITIONS.LEFT || this._dockPosition === POSITIONS.RIGHT;
    this._container.vertical = isVertical;

    // Update magnification pivot point based on position
    if (this._magnification) {
      switch (this._dockPosition) {
        case POSITIONS.TOP:
          this._magnification.setPivotPoint(0.5, 0.0);
          break;
        case POSITIONS.LEFT:
          this._magnification.setPivotPoint(0.0, 0.5);
          break;
        case POSITIONS.RIGHT:
          this._magnification.setPivotPoint(1.0, 0.5);
          break;
        default: // BOTTOM
          this._magnification.setPivotPoint(0.5, 1.0);
      }
    }

    // Update visibility edge
    if (this._visibility) {
      this._visibility.setEdge(this._dockPosition);
    }

    this._updatePosition();
  }

  private _registerKeybindings(): void {
    if (!this._settings) return;
    if (!this._settings.get_boolean("enable-keyboard-nav")) return;

    const settings = this._settings;

    Main.wm.addKeybinding(
      "toggle-dock",
      settings,
      Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
      Shell.ActionMode.NORMAL,
      () => this._toggleDockVisibility(),
    );

    // Super+1 through Super+9, Super+0 for position 10
    for (let i = 1; i <= 9; i++) {
      Main.wm.addKeybinding(
        `focus-app-${i}`,
        settings,
        Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        Shell.ActionMode.NORMAL,
        () => this._focusAppByIndex(i - 1),
      );
    }
    Main.wm.addKeybinding(
      "focus-app-10",
      settings,
      Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
      Shell.ActionMode.NORMAL,
      () => this._focusAppByIndex(9),
    );
  }

  private _removeKeybindings(): void {
    Main.wm.removeKeybinding("toggle-dock");
    for (let i = 1; i <= 9; i++) {
      Main.wm.removeKeybinding(`focus-app-${i}`);
    }
    Main.wm.removeKeybinding("focus-app-10");
  }

  private _toggleDockVisibility(): void {
    if (!this._container) return;
    this._container.visible = !this._container.visible;
    if (this._container.visible && this._visibility) {
      // Force show even if auto-hide would hide it
      this._container.opacity = 255;
    }
  }

  private _focusAppByIndex(index: number): void {
    if (!this._iconManager) return;
    const actors = this._iconManager.getIconActors();
    if (index >= actors.length) return;

    const data = (actors[index] as unknown as Record<string, unknown>)._appData as
      | {
          appId: string;
        }
      | undefined;
    if (!data) return;

    const appSystem = Shell.AppSystem.get_default();
    const app = appSystem.lookup_app(data.appId);
    if (app) {
      this._onAppClicked(app);
    }
  }
}
