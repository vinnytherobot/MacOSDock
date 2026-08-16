import St from "gi://St";
import Clutter from "gi://Clutter";
import Shell from "gi://Shell";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { SignalManager } from "./signalManager.js";
import { Intellihide } from "./intellihide.js";
import { DockVisibility } from "./dockVisibility.js";
import { IconManager } from "./iconManager.js";
import { Magnification } from "./magnification.js";

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

  private static readonly MARGIN_BOTTOM = 12;
  private static readonly DOCK_HEIGHT = 60;
  private static readonly MIN_DOCK_WIDTH = 300;
  private static readonly LAUNCH_DEBOUNCE_MS = 400;

  constructor() {
    this._signals = new SignalManager();
  }

  enable(settings: Gio.Settings): void {
    this._settings = settings;

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

    this._updatePosition();
    this._signals.connect(
      global.display,
      "workareas-changed",
      () => this._updatePosition(),
    );

    // Watch for newly launched apps so we can bounce their dock icon.
    const tracker = Shell.WindowTracker.get_default();
    this._signals.connect(tracker, "notify::focus-app", () =>
      this._onFocusAppChanged(),
    );

    // Live settings.
    this._signals.connect(
      settings,
      "changed::icon-size",
      () => {
        if (this._iconManager) {
          this._iconManager.setIconSize(settings.get_int("icon-size"));
        }
        this._updatePosition();
      },
    );
    this._signals.connect(settings, "changed::auto-hide", () => {
      if (settings.get_boolean("auto-hide")) {
        this._startAutoHide();
      } else {
        this._stopAutoHide();
      }
    });
    this._signals.connect(settings, "changed::magnification-enabled", () => {
      if (this._magnification) {
        this._magnification.setEnabled(
          settings.get_boolean("magnification-enabled"),
        );
      }
    });
    this._signals.connect(settings, "changed::magnification-scale", () => {
      if (this._magnification) {
        this._magnification.setMaxScale(
          settings.get_double("magnification-scale"),
        );
      }
    });
    this._signals.connect(settings, "changed::magnification-falloff", () => {
      if (this._magnification) {
        this._magnification.setFalloffDistance(
          settings.get_int("magnification-falloff"),
        );
      }
    });
    this._signals.connect(settings, "changed::running-indicators", () => {
      if (this._iconManager) {
        this._iconManager.setRunningIndicatorsEnabled(
          settings.get_boolean("running-indicators"),
        );
      }
    });
    this._signals.connect(settings, "changed::animation-duration", () => {
      if (this._visibility) {
        this._visibility.updateAnimationDuration(
          settings.get_int("animation-duration"),
        );
      }
    });
    this._signals.connect(settings, "changed::magnification-framerate", () => {
      if (this._magnification) {
        this._magnification.setFramerate(
          settings.get_int("magnification-framerate"),
        );
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

    if (settings.get_boolean("auto-hide")) {
      this._startAutoHide();
    }

    console.log("[macos-dock] DockManager enabled");
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

    this._signals.disconnectAll();

    if (this._container) {
      Main.layoutManager.removeChrome(this._container);
      this._container.destroy();
      this._container = null;
    }

    this._settings = null;
    console.log("[macos-dock] DockManager disabled");
  }

  private _startAutoHide(): void {
    if (!this._container || !this._settings) return;

    // Clean up any existing auto-hide before creating new.
    this._stopAutoHide();

    this._intellihide = new Intellihide();
    this._visibility = new DockVisibility(
      this._container,
      this._intellihide,
      DockManager.DOCK_HEIGHT,
      DockManager.MARGIN_BOTTOM,
      this._settings.get_int("animation-duration"),
      this._settings.get_int("show-threshold"),
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
      this._updatePosition();
    }
  }

  private _onAppClicked(app: Shell.App): void {
    const firstWindow = this._findFirstWindow(app);

    if (firstWindow) {
      if (firstWindow.has_focus() || firstWindow.minimized) {
        firstWindow.unminimize();
        firstWindow.activate(global.get_current_time());
      } else {
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
    GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      DockManager.LAUNCH_DEBOUNCE_MS,
      () => {
        this._recentlyLaunched.delete(appId);
        return GLib.SOURCE_REMOVE;
      },
    );

    this._iconManager.bounceForApp(app);
  }

  private _updatePosition(): void {
    if (!this._container) return;

    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;

    // Calculate width from children instead of relying on get_preferred_width.
    const children = this._container.get_n_children();
    const iconPadded = (this._settings?.get_int("icon-size") ?? 48) + 12;
    const spacing = 6; // matches CSS spacing
    const padding = 20; // matches CSS padding (10px each side)
    const contentWidth = children > 0
      ? children * iconPadded + (children - 1) * spacing
      : 0;
    const dockWidth = Math.max(contentWidth + padding, DockManager.MIN_DOCK_WIDTH);
    const x = monitor.x + Math.floor((monitor.width - dockWidth) / 2);
    const y =
      monitor.y + monitor.height - DockManager.DOCK_HEIGHT - DockManager.MARGIN_BOTTOM;

    this._container.set_size(dockWidth, DockManager.DOCK_HEIGHT);
    this._container.set_position(x, y);

    if (this._visibility) {
      this._visibility.updateShownY(y);
    }

    if (this._intellihide) {
      this._intellihide.setDockRect(
        x,
        y,
        dockWidth,
        DockManager.DOCK_HEIGHT,
      );
    }
  }
}
