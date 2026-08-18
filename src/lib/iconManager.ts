import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Shell from "gi://Shell";
import St from "gi://St";
import { SignalManager } from "./signalManager.js";

export type DockIconClicked = (app: Shell.App) => void;
export type IconsChanged = () => void;

type IconActor = InstanceType<typeof St.BoxLayout>;

interface AppData {
  appId: string;
  icon: InstanceType<typeof St.Icon>;
  indicatorBox: InstanceType<typeof St.BoxLayout>;
  dots: InstanceType<typeof St.Widget>[];
}

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
  private _runningIndicatorsEnabled: boolean;
  private _indicatorStyle: number; // 0 = dots per window, 1 = horizontal bar
  private _onClicked: DockIconClicked | null = null;
  private _onIconsChanged: IconsChanged | null = null;

  private _icons: Map<string, IconActor> = new Map();
  private _apps: Map<string, Shell.App> = new Map();
  private _favorites: string[] = [];
  private _windowChangeSourceId: number | null = null;
  private _tooltipText: InstanceType<typeof St.Label> | null = null;
  private _contextMenu: InstanceType<typeof St.BoxLayout> | null = null;
  private _separator: InstanceType<typeof St.Widget> | null = null;

  constructor(
    container: InstanceType<typeof St.BoxLayout>,
    iconSize: number,
    runningIndicatorsEnabled: boolean,
    _quality: number = 2,
    indicatorStyle: number = 0,
  ) {
    this._signals = new SignalManager();
    this._container = container;
    this._iconSize = iconSize;
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

  setQuality(_quality: number): void {
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

    this._signals.connect(appSystem, "installed-changed", () => this._reload());

    const tracker = Shell.WindowTracker.get_default();
    this._signals.connect(tracker, "notify::focus-app", () => this._refreshAllIndicators());

    this._signals.connect(global.display, "window-created", () => this._onWindowChange());

    this._signals.connect(global.display, "window-entered-monitor", () => this._onWindowChange());

    this._signals.connect(global.display, "window-left-monitor", () => this._onWindowChange());

    // Initialize tooltip
    this._tooltipText = new St.Label({
      style_class: "macos-dock-tooltip",
      text: "",
      visible: false,
    });
    global.stage.add_child(this._tooltipText);

    this._reload();
  }

  stop(): void {
    this._signals.disconnectAll();

    if (this._windowChangeSourceId !== null) {
      GLib.source_remove(this._windowChangeSourceId);
      this._windowChangeSourceId = null;
    }

    this._hideTooltip();
    if (this._tooltipText) {
      this._tooltipText.destroy();
      this._tooltipText = null;
    }

    this._closeContextMenu();

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
    this._separator = null;

    this._favorites = this._readFavorites();

    const appSystem = Shell.AppSystem.get_default();

    // Add favorites in their stored order first.
    for (const appId of this._favorites) {
      const app = appSystem.lookup_app(appId);
      if (!app) continue;
      this._addIcon(app);
    }

    // Get running apps that aren't favorites
    const runningApps = this._getRunningApps().filter(
      (app) => !this._favorites.includes(app.get_id()),
    );

    // Add separator if there are both favorites and running apps
    if (this._favorites.length > 0 && runningApps.length > 0) {
      this._addSeparator();
    }

    // Then any running app that isn't already a favorite.
    for (const app of runningApps) {
      this._addIcon(app);
    }
  }

  private _onWindowChange(): void {
    // Remove any existing timeout before creating a new one.
    if (this._windowChangeSourceId !== null) {
      GLib.source_remove(this._windowChangeSourceId);
    }

    // Delay to ensure window is fully initialized before checking.
    this._windowChangeSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      this._doWindowChange();
      this._windowChangeSourceId = null;
      return GLib.SOURCE_REMOVE;
    });
  }

  private _doWindowChange(): void {
    // Track which apps are running right now. We add/remove icons as
    // needed so non-favorite running apps still appear (and disappear
    // when their last window closes).
    const runningIds = new Set<string>();
    for (const app of this._getRunningApps()) {
      runningIds.add(app.get_id());
    }

    let changed = false;
    const toRemove: string[] = [];

    // Remove icons for apps that are no longer running and aren't favorites.
    for (const [id, actor] of this._icons.entries()) {
      const isFavorite = this._favorites.includes(id);
      if (!isFavorite && !runningIds.has(id)) {
        toRemove.push(id);
        // Animate icon disappearing (fade out + scale)
        actor.ease({
          opacity: 0,
          scaleX: 0.8,
          scaleY: 0.8,
          duration: 200,
          mode: Clutter.AnimationMode.EASE_IN_QUAD,
          onComplete: () => {
            this._container.remove_child(actor);
          },
        });
        changed = true;
      }
    }

    // Clean up references after animation
    for (const id of toRemove) {
      this._icons.delete(id);
      this._apps.delete(id);
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

    // Update separator visibility
    this._updateSeparator();

    this._refreshAllIndicators();

    // Notify dock to resize when icons were added/removed.
    if (changed && this._onIconsChanged) this._onIconsChanged();
  }

  private _updateSeparator(): void {
    // Count non-favorite running apps
    const runningNonFavorites = this._getRunningApps().filter(
      (app) => !this._favorites.includes(app.get_id()),
    );

    const hasFavorites = this._favorites.length > 0;
    const hasRunningNonFavorites = runningNonFavorites.length > 0;

    // Add separator if needed
    if (hasFavorites && hasRunningNonFavorites && !this._separator) {
      this._addSeparator();
    }
    // Remove separator if not needed
    else if ((!hasFavorites || !hasRunningNonFavorites) && this._separator) {
      this._separator.destroy();
      this._separator = null;
    }
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
      icon_size: this._iconSize,
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
    const appData: AppData = { appId, icon, indicatorBox, dots: [] };
    (actor as unknown as Record<string, unknown>)._appData = appData;

    this._signals.connect(actor, "button-press-event", (_actor, event) => {
      const button = (event as { get_button: () => number }).get_button();
      if (button === 3) {
        // Right-click: show context menu
        this._showContextMenu(actor, app);
        return Clutter.EVENT_STOP;
      }
      // Left-click: normal behavior
      if (this._onClicked) {
        this._onClicked(app);
      }
      return Clutter.EVENT_PROPAGATE;
    });

    // Tooltip events
    this._signals.connect(actor, "hover-enter", () => {
      this._showTooltip(actor, app.get_name());
      return Clutter.EVENT_PROPAGATE;
    });

    this._signals.connect(actor, "hover-leave", () => {
      this._hideTooltip();
      return Clutter.EVENT_PROPAGATE;
    });

    this._container.add_child(actor);
    this._icons.set(appId, actor);
    this._apps.set(appId, app);

    // Animate icon appearing (fade in + scale)
    actor.opacity = 0;
    actor.scale_x = 0.8;
    actor.scale_y = 0.8;
    actor.ease({
      opacity: 255,
      scaleX: 1.0,
      scaleY: 1.0,
      duration: 200,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });

    this._refreshRunningIndicator(actor, appId);

    // Notify dock to resize.
    if (this._onIconsChanged) this._onIconsChanged();
  }

  private _applyIconSize(actor: IconActor): void {
    const data = this._getStored(actor);
    if (data) {
      data.icon.set_icon_size(this._iconSize);
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
    const data = this._getStored(actor);
    if (!data) return;
    const { indicatorBox } = data;
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

    // Count all windows for this app (including minimized).
    let windowCount = 0;
    const actors = global.get_window_actors();
    for (const wa of actors) {
      const mw = wa.get_meta_window();
      if (!mw) continue;
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

    // Clear all children before adding new style.
    indicatorBox.remove_all_children();

    if (this._indicatorStyle === 0) {
      // Dots per window (macOS style).
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
      // Horizontal bar style.
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
    } catch {
      return [];
    }
  }

  private _getStored(actor: IconActor): AppData | null {
    const data = (actor as unknown as Record<string, unknown>)._appData;
    if (!data) return null;
    return data as AppData;
  }

  private _bounce(actor: IconActor): void {
    const baseY = 0;
    const up = -28;
    const small = -10;

    // Note: translation_y is the correct GJS property name (snake_case), even though
    // the TypeScript types expect camelCase (translationY). This is a type definition mismatch.
    const ease = (params: Record<string, unknown>) =>
      actor.ease(params as Parameters<typeof actor.ease>[0]);

    ease({
      translation_y: up,
      duration: 180,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => {
        ease({
          translation_y: baseY,
          duration: 120,
          mode: Clutter.AnimationMode.EASE_IN_QUAD,
          onComplete: () => {
            ease({
              translation_y: small,
              duration: 100,
              mode: Clutter.AnimationMode.EASE_OUT_QUAD,
              onComplete: () => {
                ease({
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

  private _showTooltip(actor: IconActor, appName: string): void {
    if (!this._tooltipText) return;

    const [x, y] = actor.get_transformed_position();
    const [width] = actor.get_size();

    this._tooltipText.set_text(appName);
    const [, tooltipWidth] = this._tooltipText.get_preferred_width(-1);

    // Position tooltip above the icon, centered
    const tooltipX = x + (width - tooltipWidth) / 2;
    const tooltipY = y - 40; // 40px above the icon

    this._tooltipText.set_position(tooltipX, tooltipY);
    this._tooltipText.show();
  }

  private _hideTooltip(): void {
    if (this._tooltipText) {
      this._tooltipText.hide();
    }
  }

  private _showContextMenu(actor: IconActor, app: Shell.App): void {
    // Close existing context menu if any
    this._closeContextMenu();

    // Create a simple context menu using St.BoxLayout
    this._contextMenu = new St.BoxLayout({
      style_class: "macos-dock-context-menu",
      vertical: true,
      reactive: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.START,
    });

    const menuItems = [
      { label: "Nova Janela", action: () => app.open_new_window(-1) },
      { label: "Fechar", action: () => this._closeApp(app) },
    ];

    for (const item of menuItems) {
      const menuItem = new St.Button({
        style_class: "macos-dock-context-menu-item",
        reactive: true,
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.CENTER,
        label: item.label,
      });
      menuItem.connect("clicked", () => {
        item.action();
        this._closeContextMenu();
      });
      this._contextMenu.add_child(menuItem);
    }

    // Position menu above the icon
    const [x, y] = actor.get_transformed_position();
    const [width] = actor.get_size();
    const [, menuWidth] = this._contextMenu.get_preferred_width(-1);
    const [, menuHeight] = this._contextMenu.get_preferred_height(-1);

    const menuX = x + (width - menuWidth) / 2;
    const menuY = y - menuHeight - 10;

    this._contextMenu.set_position(menuX, menuY);
    global.stage.add_child(this._contextMenu);

    // Close menu when clicking outside
    const clickOutsideId = global.stage.connect("button-press-event", () => {
      this._closeContextMenu();
      global.stage.disconnect(clickOutsideId);
      return Clutter.EVENT_PROPAGATE;
    });
  }

  private _closeContextMenu(): void {
    if (this._contextMenu) {
      this._contextMenu.destroy();
      this._contextMenu = null;
    }
  }

  private _closeApp(app: Shell.App): void {
    const windows = app.get_windows();
    for (const window of windows) {
      window.delete(global.get_current_time());
    }
  }

  private _addSeparator(): void {
    if (this._separator) return; // Already exists

    this._separator = new St.Widget({
      style_class: "macos-dock-separator",
      width: 1,
      height: 32,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._container.add_child(this._separator);
  }
}
