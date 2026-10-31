import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { DockVisibility } from "./dockVisibility.js";
import { IconManager, type MediaAction } from "./iconManager.js";
import { Intellihide } from "./intellihide.js";
import { Magnification } from "./magnification.js";
import { MediaManager } from "./mediaManager.js";
import { SignalManager } from "./signalManager.js";
import { WindowPreviewPopup } from "./windowPreview.js";

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
  private _previewPopup: WindowPreviewPopup | null = null;
  private _mediaManager: MediaManager | null = null;
  private _theme: St.Theme | null = null;
  private _customCssFile: Gio.File | null = null;
  private _customCssDirectory: Gio.File | null = null;
  private _customCss = "";

  private static readonly MARGIN_BOTTOM = 12;
  private static readonly MIN_DOCK_WIDTH = 300;
  private static readonly LAUNCH_DEBOUNCE_MS = 400;

  constructor() {
    this._signals = new SignalManager();
  }

  private get _dockHeight(): number {
    const iconSize = this._settings?.get_int("icon-size") ?? 48;
    const iconActorHeight = iconSize + 16;
    const verticalPadding = 8; // 4px top + 4px bottom from _applyDockStyle
    return iconActorHeight + verticalPadding;
  }

  enable(settings: Gio.Settings): void {
    this._settings = settings;
    this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    this._applyCustomCss(settings.get_string("custom-css"));

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
    const iconManager = new IconManager(
      this._container,
      settings.get_int("icon-size"),
      settings.get_boolean("running-indicators"),
      settings.get_int("icon-quality"),
      settings.get_double("magnification-scale"),
      settings.get_int("running-indicator-style"),
    );
    this._iconManager = iconManager;
    iconManager.setOnClicked((app) => this._onAppClicked(app));
    iconManager.setOnIconsChanged(() => this._updatePosition());
    iconManager.setOnMediaAction((action) => this._onMediaAction(action));
    iconManager.setOnContextMenuActorChanged((actor) => {
      if (this._visibility) {
        this._visibility.setContextMenuActor(actor);
      }
    });
    iconManager.setShowRunningApps(settings.get_boolean("show-running-apps"));
    iconManager.setAppButtonPosition(settings.get_int("show-applications-button-position"));
    iconManager.setWorkspaceMode(settings.get_int("dock-workspace-mode"));
    iconManager.setMediaIndicatorEnabled(settings.get_boolean("media-indicator"));
    iconManager.setMediaControlsEnabled(settings.get_boolean("media-controls"));
    iconManager.setDragReorderEnabled(settings.get_boolean("drag-reorder"));
    // Window preview popup
    this._previewPopup = new WindowPreviewPopup();
    const previewPopup = this._previewPopup;
    previewPopup.setPreviewWidth(settings.get_int("preview-scale"));
    iconManager.setPreviewPopup(previewPopup);
    iconManager.setWindowPreviewsEnabled(settings.get_boolean("window-previews"));

    iconManager.start();

    // Magnification: scale icons on hover.
    const magnification = new Magnification(
      this._container,
      settings.get_boolean("magnification-enabled"),
      settings.get_double("magnification-scale"),
      settings.get_int("magnification-falloff"),
      settings.get_int("magnification-framerate"),
    );
    this._magnification = magnification;
    magnification.start();
    iconManager.setOnDragStateChanged((dragging) => {
      previewPopup.cancelScheduledHide();
      previewPopup.hide();
      if (dragging) {
        magnification.pause();
      } else {
        magnification.resume();
      }
      this._visibility?.setDragActive(dragging);
    });

    // Media manager: MPRIS integration for music controls.
    this._mediaManager = new MediaManager();
    this._mediaManager.setOnStateChanged((app) => {
      iconManager.setPlayingApp(app?.get_id() ?? null);
    });
    this._mediaManager.start();

    this._applyDockStyle();
    this._applyDockPosition();
    this._registerKeybindings();
    this._updatePosition();
    this._signals.connect(global.display, "workareas-changed", () => this._updatePosition());
    this._signals.connect(global.backend.get_monitor_manager(), "monitors-changed", () => {
      iconManager.refreshResourceScale();
      this._updatePosition();
    });

    // Watch for newly launched apps so we can bounce their dock icon.
    const tracker = Shell.WindowTracker.get_default();
    this._signals.connect(tracker, "notify::focus-app", () => this._onFocusAppChanged());

    // Live settings.
    this._signals.connect(settings, "changed::icon-size", () => {
      iconManager.setIconSize(settings.get_int("icon-size"));
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
      magnification.setEnabled(settings.get_boolean("magnification-enabled"));
    });
    this._signals.connect(settings, "changed::magnification-scale", () => {
      magnification.setMaxScale(settings.get_double("magnification-scale"));
      iconManager.setMagnificationScale(settings.get_double("magnification-scale"));
    });
    this._signals.connect(settings, "changed::magnification-falloff", () => {
      magnification.setFalloffDistance(settings.get_int("magnification-falloff"));
    });
    this._signals.connect(settings, "changed::running-indicators", () => {
      iconManager.setRunningIndicatorsEnabled(settings.get_boolean("running-indicators"));
    });
    this._signals.connect(settings, "changed::animation-duration", () => {
      if (this._visibility) {
        this._visibility.updateAnimationDuration(settings.get_int("animation-duration"));
      }
    });
    this._signals.connect(settings, "changed::magnification-framerate", () => {
      magnification.setFramerate(settings.get_int("magnification-framerate"));
    });
    this._signals.connect(settings, "changed::icon-quality", () => {
      iconManager.setQuality(settings.get_int("icon-quality"));
    });
    this._signals.connect(settings, "changed::running-indicator-style", () => {
      iconManager.setIndicatorStyle(settings.get_int("running-indicator-style"));
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
      iconManager.setShowAppButton(settings.get_boolean("show-applications-button"));
      this._updatePosition();
    });
    this._signals.connect(settings, "changed::show-applications-button-position", () => {
      iconManager.setAppButtonPosition(settings.get_int("show-applications-button-position"));
      this._updatePosition();
    });
    this._signals.connect(settings, "changed::custom-css", () => {
      this._applyCustomCss(settings.get_string("custom-css"));
    });
    this._signals.connect(settings, "changed::enable-keyboard-nav", () => {
      this._removeKeybindings();
      this._registerKeybindings();
    });
    this._signals.connect(settings, "changed::window-previews", () => {
      const enabled = settings.get_boolean("window-previews");
      iconManager.setWindowPreviewsEnabled(enabled);
      if (!enabled) previewPopup.hide();
    });
    this._signals.connect(settings, "changed::preview-scale", () => {
      previewPopup.setPreviewWidth(settings.get_int("preview-scale"));
    });
    this._signals.connect(settings, "changed::show-running-apps", () => {
      iconManager.setShowRunningApps(settings.get_boolean("show-running-apps"));
    });
    this._signals.connect(settings, "changed::dock-workspace-mode", () => {
      iconManager.setWorkspaceMode(settings.get_int("dock-workspace-mode"));
    });
    this._signals.connect(global.workspace_manager, "workspace-switched", () => {
      if (settings.get_int("dock-workspace-mode") === 1) {
        iconManager.reload();
      }
    });
    this._signals.connect(settings, "changed::media-indicator", () => {
      iconManager.setMediaIndicatorEnabled(settings.get_boolean("media-indicator"));
    });
    this._signals.connect(settings, "changed::drag-reorder", () => {
      iconManager.setDragReorderEnabled(settings.get_boolean("drag-reorder"));
    });
    this._signals.connect(settings, "changed::media-controls", () => {
      iconManager.setMediaControlsEnabled(settings.get_boolean("media-controls"));
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

    if (this._previewPopup) {
      this._previewPopup.stop();
      this._previewPopup = null;
    }

    if (this._mediaManager) {
      this._mediaManager.stop();
      this._mediaManager = null;
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

    this._removeCustomCss();

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
      this._settings.get_int("animation-duration"),
      this._settings.get_int("show-threshold"),
      this._dockPosition,
      this._settings.get_double("magnification-scale"),
    );
    if (this._previewPopup) {
      this._visibility.setPreviewPopup(this._previewPopup);
    }
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

  private _onMediaAction(action: MediaAction): void {
    if (!this._mediaManager) return;
    switch (action) {
      case "play-pause":
        this._mediaManager.togglePlayPause();
        break;
      case "next":
        this._mediaManager.next();
        break;
      case "previous":
        this._mediaManager.previous();
        break;
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

    // Skip position recalculation while the dock is shown or a visibility
    // animation is running. The show/hide animation owns the container's
    // translation and a layout update here would conflict with it.
    if (this._visibility && (this._visibility.isShown() || this._visibility.isAnimating())) {
      return;
    }

    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;

    const iconManager = this._iconManager;
    if (!iconManager) return;

    const iconCount = iconManager.getIconCount();
    const hasSeparator = iconManager.hasSeparator();
    const hasAppButton = iconManager.hasAppButton();
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
      this._visibility.updateDockBounds(x, y, w, h);
    }

    if (this._intellihide) {
      this._intellihide.setDockRect(x, y, w, h);
    }
  }

  private _hideDefaultDash(): void {
    const dash = Main.overview.dash;
    this._originalDashVisible = dash.visible;
    dash.hide();
  }

  private _showDefaultDash(): void {
    const dash = Main.overview.dash;
    dash.visible = this._originalDashVisible ?? true;
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

  private _applyCustomCss(css: string): void {
    if (!this._theme || css === this._customCss) return;

    if (!css.trim()) {
      this._clearCustomCss();
      return;
    }

    const checksum = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, css, -1);
    if (!checksum) return;

    const directoryPath = GLib.build_filenamev([GLib.get_user_cache_dir(), "macos-dock"]);
    const directory = Gio.File.new_for_path(directoryPath);
    const file = Gio.File.new_for_path(GLib.build_filenamev([directoryPath, `${checksum}.css`]));
    let stylesheetLoaded = false;

    try {
      if (GLib.mkdir_with_parents(directoryPath, 0o700) !== 0) {
        throw new Error(`Could not create custom CSS cache directory: ${directoryPath}`);
      }
      this._customCssDirectory = directory;
      file.replace_contents(css, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

      if (!this._theme.load_stylesheet(file)) {
        this._deleteCustomCssFile(file);
        if (!this._customCssFile) this._removeCustomCssDirectory();
        console.error("MacOS Dock: GNOME Shell could not load the custom CSS stylesheet.");
        return;
      }
      stylesheetLoaded = true;

      const previousFile = this._customCssFile;
      this._customCssFile = file;
      this._customCss = css;
      if (previousFile) {
        this._theme.unload_stylesheet(previousFile);
        this._deleteCustomCssFile(previousFile);
      }
    } catch (error) {
      if (!stylesheetLoaded) this._deleteCustomCssFile(file);
      if (!this._customCssFile) this._removeCustomCssDirectory();
      console.error(`MacOS Dock: Failed to apply custom CSS: ${error}`);
    }
  }

  private _removeCustomCss(): void {
    this._clearCustomCss();
    this._theme = null;
  }

  private _clearCustomCss(): void {
    if (this._theme && this._customCssFile) {
      this._theme.unload_stylesheet(this._customCssFile);
      this._deleteCustomCssFile(this._customCssFile);
    }

    this._customCssFile = null;
    this._customCss = "";
    this._removeCustomCssDirectory();
  }

  private _deleteCustomCssFile(file: Gio.File): void {
    try {
      if (file.query_exists(null)) file.delete(null);
    } catch (error) {
      console.error(`MacOS Dock: Failed to remove cached custom CSS: ${error}`);
    }
  }

  private _removeCustomCssDirectory(): void {
    if (!this._customCssDirectory) return;

    try {
      if (this._customCssDirectory.query_exists(null)) this._customCssDirectory.delete(null);
      this._customCssDirectory = null;
    } catch (error) {
      console.error(`MacOS Dock: Failed to remove custom CSS cache directory: ${error}`);
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
