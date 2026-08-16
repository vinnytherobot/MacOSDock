import St from "gi://St";
import Clutter from "gi://Clutter";
import Shell from "gi://Shell";
import Gio from "gi://Gio";
import { SignalManager } from "./signalManager.js";

export type DockIconClicked = (app: Shell.App) => void;
export type IconsChanged = () => void;

type IconActor = InstanceType<typeof St.BoxLayout>;

/**
 * Manages app icons inside the dock container.
 *
 * Each icon is a small St.BoxLayout wrapping an St.Icon and a running
 * indicator dot. Icons are ordered: favorite apps first, then any
 * additional running-but-not-favorited apps (like macOS shows persistent
 * apps in the dock even when not in the favorites list).
 */
export class IconManager {
  private _signals: SignalManager;
  private _container: InstanceType<typeof St.BoxLayout>;
  private _iconSize: number;
  private _quality: number;
  private _runningIndicatorsEnabled: boolean;
  private _indicatorStyle: number; // 0 = dots per window, 1 = horizontal bar
  private _onClicked: DockIconClicked | null = null;
  private _onIconsChanged: IconsChanged | null = null;

  private _icons: Map<string, IconActor> = new Map();
  private _apps: Map<string, Shell.App> = new Map();
  private _favorites: string[] = [];

  constructor(
    container: InstanceType<typeof St.BoxLayout>,
    iconSize: number,
    runningIndicatorsEnabled: boolean,
    quality: number = 2,
    indicatorStyle: number = 0,
  ) {
    this._signals = new SignalManager();
    this._container = container;
    this._iconSize = iconSize;
    this._quality = quality;
    this._runningIndicatorsEnabled = runningIndicatorsEnabled;
    this._indicatorStyle = indicatorStyle;
  }

  setOnClicked(callback: DockIconClicked): void {
    this._onClicked = callback;
  }

  setOnIconsChanged(callback: IconsChanged): void {
    this._onIconsChanged = callback;
  }

  setIconSize(size: number): void {
    this._iconSize = size;
    for (const actor of this._icons.values()) {
      this._applyIconSize(actor);
    }
  }

  setQuality(quality: number): void {
    this._quality = quality;
    for (const actor of this._icons.values()) {
      this._applyIconSize(actor);
    }
  }

  setIndicatorStyle(style: number): void {
    this._indicatorStyle = style;
    this._refreshAllIndicators();
  }

  setRunningIndicatorsEnabled(enabled: boolean): void {
    this._runningIndicatorsEnabled = enabled;
    for (const [appId, actor] of this._icons.entries()) {
      this._refreshRunningIndicator(actor, appId);
    }
  }

  start(): void {
    const appSystem = Shell.AppSystem.get_default();

    this._signals.connect(appSystem, "installed-changed", () =>
      this._reload(),
    );

    const tracker = Shell.WindowTracker.get_default();
    this._signals.connect(tracker, "notify::focus-app", () =>
      this._refreshAllIndicators(),
    );

    this._signals.connect(
      global.display,
      "window-created",
      () => this._onWindowChange(),
    );

    this._signals.connect(
      global.display,
      "window-entered-monitor",
      () => this._onWindowChange(),
    );

    this._signals.connect(
      global.display,
      "window-left-monitor",
      () => this._onWindowChange(),
    );

    this._reload();
  }

  stop(): void {
    this._signals.disconnectAll();
    this._container.remove_all_children();
    this._icons.clear();
    this._apps.clear();
    this._favorites = [];
  }

  /**
   * Get the visible icon actors in the dock, in display order. Used by
   * the magnification animator to map pointer X to a focal index.
   */
  getIconActors(): IconActor[] {
    const result: IconActor[] = [];
    const children = this._container.get_children() as IconActor[];
    for (const child of children) {
      result.push(child);
    }
    return result;
  }

  /**
   * Trigger a macOS-style "bounce" animation on the icon for a given app,
   * used to draw the user's attention when an app is launched.
   */
  bounceForApp(app: Shell.App): void {
    const appId = app.get_id();
    const actor = this._icons.get(appId);
    if (!actor) return;
    this._bounce(actor);
  }

  private _reload(): void {
    this._container.remove_all_children();
    this._icons.clear();
    this._apps.clear();

    this._favorites = this._readFavorites();
    console.log(`[macos-dock] Loaded ${this._favorites.length} favorites`);

    const appSystem = Shell.AppSystem.get_default();

    // Add favorites in their stored order first.
    for (const appId of this._favorites) {
      const app = appSystem.lookup_app(appId);
      if (!app) {
        console.log(`[macos-dock] Favorite not found: ${appId}`);
        continue;
      }
      this._addIcon(app);
    }

    // Then any running app that isn't already a favorite.
    const runningApps = this._getRunningApps();
    console.log(`[macos-dock] Found ${runningApps.length} running apps`);
    for (const app of runningApps) {
      const id = app.get_id();
      if (this._icons.has(id)) continue;
      this._addIcon(app);
    }

    console.log(`[macos-dock] Dock has ${this._icons.size} icons`);
  }

  private _onWindowChange(): void {
    // Track which apps are running right now. We add/remove icons as
    // needed so non-favorite running apps still appear (and disappear
    // when their last window closes).
    const runningIds = new Set<string>();
    for (const app of this._getRunningApps()) {
      runningIds.add(app.get_id());
    }

    let changed = false;

    // Remove icons for apps that are no longer running and aren't favorites.
    for (const [id, actor] of this._icons.entries()) {
      const isFavorite = this._favorites.includes(id);
      if (!isFavorite && !runningIds.has(id)) {
        this._container.remove_child(actor);
        this._icons.delete(id);
        this._apps.delete(id);
        changed = true;
      }
    }

    // Add icons for newly running, non-favorited apps.
    for (const id of runningIds) {
      if (this._icons.has(id)) continue;
      if (this._favorites.includes(id)) continue;
      const appSystem = Shell.AppSystem.get_default();
      const app = appSystem.lookup_app(id);
      if (!app) continue;
      this._addIcon(app);
      changed = true;
    }

    this._refreshAllIndicators();

    // Notify dock to resize when icons were added/removed.
    if (changed && this._onIconsChanged) this._onIconsChanged();
  }

  private _addIcon(app: Shell.App): void {
    const appId = app.get_id();
    if (this._icons.has(appId)) return;

    const actor = new St.BoxLayout({
      style_class: "macos-dock-icon",
      reactive: true,
      track_hover: true,
      vertical: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.END,
    }) as IconActor;

    this._applyIconSize(actor);

    const icon = new St.Icon({
      gicon: app.get_icon(),
      icon_size: this._iconSize * this._quality,
      style_class: "macos-dock-icon-gicon",
    });
    actor.add_child(icon);

    // Container for running indicator dots (or a single bar).
    const indicatorBox = new St.BoxLayout({
      style_class: "macos-dock-indicator-box",
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.END,
    });
    actor.add_child(indicatorBox);

    // Store references on the actor for retrieval later.
    (actor as any)._appData = { appId, icon, indicatorBox, dots: [] };

    this._signals.connect(actor, "button-press-event", () => {
      if (this._onClicked) {
        this._onClicked(app);
      }
      return Clutter.EVENT_PROPAGATE;
    });

    this._container.add_child(actor);
    this._icons.set(appId, actor);
    this._apps.set(appId, app);

    this._refreshRunningIndicator(actor, appId);

    // Notify dock to resize.
    if (this._onIconsChanged) this._onIconsChanged();
  }

  private _applyIconSize(actor: IconActor): void {
    const icon = this._getStored<InstanceType<typeof St.Icon>>(actor, "icon");
    if (icon) {
      // Render at high resolution for sharpness when magnified.
      icon.set_icon_size(this._iconSize * this._quality);
      // Constrain layout to visual size so it doesn't overflow.
      icon.set_size(this._iconSize, this._iconSize);
    }
    const padded = this._iconSize + 12;
    actor.set_size(padded, padded + 4);
  }

  private _refreshAllIndicators(): void {
    for (const [appId, actor] of this._icons.entries()) {
      this._refreshRunningIndicator(actor, appId);
    }
  }

  private _refreshRunningIndicator(actor: IconActor, appId: string): void {
    const data = (actor as any)._appData;
    if (!data) return;
    const indicatorBox = data.indicatorBox as InstanceType<typeof St.BoxLayout>;
    if (!indicatorBox) return;

    if (!this._runningIndicatorsEnabled) {
      indicatorBox.visible = false;
      return;
    }

    const tracker = Shell.WindowTracker.get_default();
    const app = this._apps.get(appId);
    if (!app) {
      indicatorBox.visible = false;
      return;
    }

    // Count visible windows for this app.
    let windowCount = 0;
    const actors = global.get_window_actors();
    for (const wa of actors) {
      const mw = wa.get_meta_window();
      if (!mw) continue;
      if (!mw.showing_on_its_workspace()) continue;
      if (tracker.get_window_app(mw) === app) {
        windowCount++;
      }
    }
    const focused = tracker.focus_app === app;
    const isRunning = windowCount > 0 || focused;

    if (!isRunning) {
      indicatorBox.visible = false;
      return;
    }

    indicatorBox.visible = true;

    if (this._indicatorStyle === 0) {
      // Dots per window (macOS style).
      const currentDots = indicatorBox.get_n_children();
      const needed = focused ? Math.max(windowCount, 1) : windowCount;

      // Add or remove dots to match window count.
      while (indicatorBox.get_n_children() < needed) {
        const dot = new St.Widget({
          style_class: "macos-dock-indicator-dot",
        });
        indicatorBox.add_child(dot);
      }
      while (indicatorBox.get_n_children() > needed) {
        const last = indicatorBox.get_n_children() - 1;
        indicatorBox.get_child_at_index(last)?.destroy();
      }
    } else {
      // Horizontal bar style — clear any dots, show single bar.
      indicatorBox.remove_all_children();
      const bar = new St.Widget({
        style_class: "macos-dock-indicator-bar",
      });
      indicatorBox.add_child(bar);
    }
  }

  private _getRunningApps(): Shell.App[] {
    const tracker = Shell.WindowTracker.get_default();
    const seen = new Set<string>();
    const result: Shell.App[] = [];
    const windows = global.get_window_actors();
    for (const wa of windows) {
      const metaWin = wa.get_meta_window();
      if (!metaWin) continue;
      if (!metaWin.showing_on_its_workspace()) continue;
      const app = tracker.get_window_app(metaWin);
      if (!app) continue;
      const id = app.get_id();
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(app);
    }
    return result;
  }

  private _readFavorites(): string[] {
    try {
      const settings = new Gio.Settings({ schema: "org.gnome.shell" });
      return settings.get_strv("favorite-apps");
    } catch (_e) {
      console.log("[macos-dock] Could not read favorites:", _e);
      return [];
    }
  }

  private _getStored<T>(actor: IconActor, key: string): T | null {
    const data = (actor as any)._appData;
    if (!data) return null;
    return data[key] ?? null;
  }

  private _bounce(actor: IconActor): void {
    const a = actor as any;
    const baseY = 0;
    const up = -28;
    const small = -10;

    a.ease({
      translation_y: up,
      duration: 180,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => {
        a.ease({
          translation_y: baseY,
          duration: 120,
          mode: Clutter.AnimationMode.EASE_IN_QUAD,
          onComplete: () => {
            a.ease({
              translation_y: small,
              duration: 100,
              mode: Clutter.AnimationMode.EASE_OUT_QUAD,
              onComplete: () => {
                a.ease({
                  translation_y: baseY,
                  duration: 80,
                  mode: Clutter.AnimationMode.EASE_IN_QUAD,
                });
              },
            });
          },
        });
      },
    });
  }
}
