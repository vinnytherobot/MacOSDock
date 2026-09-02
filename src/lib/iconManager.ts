import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Shell from "gi://Shell";
import St from "gi://St";
import * as BoxPointer from "resource:///org/gnome/shell/ui/boxpointer.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { SignalManager } from "./signalManager.js";
import type { WindowPreviewPopup } from "./windowPreview.js";

export type DockIconClicked = (app: Shell.App) => void;
export type IconsChanged = () => void;
export type MediaAction = "play-pause" | "next" | "previous";

type IconActor = InstanceType<typeof St.BoxLayout>;

interface AppData {
  appId: string;
  icon: InstanceType<typeof St.Icon>;
  iconWrapper: InstanceType<typeof St.Widget>;
  indicatorBox: InstanceType<typeof St.BoxLayout>;
  dots: InstanceType<typeof St.Widget>[];
  mediaIndicator: InstanceType<typeof St.Widget> | null;
}

type ContextMenu = InstanceType<typeof PopupMenu.PopupMenu>;
type MenuManager = InstanceType<typeof PopupMenu.PopupMenuManager>;

/**
 * Manages app icons inside the dock container.
 *
 * Each icon is a small St.BoxLayout wrapping an St.Icon and a running
 * indicator dot. Icons are ordered: favorite apps first, then any
 * additional running-but-not-favorited apps (like macOS shows persistent
 * apps in the dock even when not in the favorites list).
 */
export class IconManager {
  private static readonly MEDIA_BADGE_SIZE = 12;
  private static readonly MEDIA_BADGE_INSET = 3;

  private _signals: SignalManager;
  private _container: InstanceType<typeof St.BoxLayout>;
  private _iconSize: number;
  private _runningIndicatorsEnabled: boolean;
  private _indicatorStyle: number; // 0 = dots per window, 1 = horizontal bar
  private _onClicked: DockIconClicked | null = null;
  private _onIconsChanged: IconsChanged | null = null;
  private _onMediaAction: ((action: MediaAction) => void) | null = null;
  private _mediaControlsEnabled: boolean = false;
  private _onContextMenuActorChanged:
    | ((actor: InstanceType<typeof St.Widget> | null) => void)
    | null = null;

  private _icons: Map<string, IconActor> = new Map();
  private _apps: Map<string, Shell.App> = new Map();
  private _favorites: string[] = [];
  private _windowChangeSourceId: number | null = null;
  private _tooltipText: InstanceType<typeof St.Label> | null = null;
  private _contextMenu: ContextMenu | null = null;
  private _menuSignals: SignalManager | null = null;
  private _menuManager: MenuManager | null = null;
  private _separator: InstanceType<typeof St.Widget> | null = null;
  private _appButton: InstanceType<typeof St.BoxLayout> | null = null;
  private _appButtonIcon: InstanceType<typeof St.Icon> | null = null;
  private _showAppButton: boolean = true;
  private _showRunningApps: boolean = true;
  private _workspaceMode: number = 0; // 0=all, 1=current-only
  private _mediaIndicatorEnabled: boolean = true;
  private _playingAppId: string | null = null;
  private _windowPreviewsEnabled: boolean = false;
  private _previewPopup: WindowPreviewPopup | null = null;

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

  setOnMediaAction(callback: (action: MediaAction) => void): void {
    this._onMediaAction = callback;
  }

  setMediaControlsEnabled(enabled: boolean): void {
    this._mediaControlsEnabled = enabled;
  }

  setOnContextMenuActorChanged(
    callback: (actor: InstanceType<typeof St.Widget> | null) => void,
  ): void {
    this._onContextMenuActorChanged = callback;
  }

  setIconSize(size: number): void {
    this._iconSize = size;
    for (const actor of this._icons.values()) {
      this._applyIconSize(actor);
    }
    if (this._appButton && this._appButtonIcon) {
      this._appButtonIcon.set_icon_size(this._iconSize);
      const padded = this._iconSize + 12;
      this._appButton.set_size(padded, padded + 4);
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

  setShowAppButton(show: boolean): void {
    this._showAppButton = show;
    this._updateAppButton();
  }

  setShowRunningApps(enabled: boolean): void {
    this._showRunningApps = enabled;
    this._reload();
  }

  setWorkspaceMode(mode: number): void {
    this._workspaceMode = mode;
    this._reload();
  }

  reload(): void {
    this._reload();
  }

  setMediaIndicatorEnabled(enabled: boolean): void {
    this._mediaIndicatorEnabled = enabled;
    this._refreshAllMediaIndicators();
  }

  setPlayingApp(appId: string | null): void {
    this._playingAppId = appId;
    this._refreshAllMediaIndicators();
  }

  setPreviewPopup(popup: WindowPreviewPopup): void {
    this._previewPopup = popup;
  }

  setWindowPreviewsEnabled(enabled: boolean): void {
    this._windowPreviewsEnabled = enabled;
  }

  start(): void {
    const appSystem = Shell.AppSystem.get_default();

    this._signals.connect(appSystem, "installed-changed", () => this._reload());

    const tracker = Shell.WindowTracker.get_default();
    this._signals.connect(tracker, "notify::focus-app", () => this._refreshAllIndicators());

    this._signals.connect(global.display, "window-created", () => this._onWindowChange());

    this._signals.connect(global.display, "window-entered-monitor", () => this._onWindowChange());

    this._signals.connect(global.display, "window-left-monitor", () => this._onWindowChange());

    // Initialize tooltip - add to top chrome layer like the dock
    this._tooltipText = new St.Label({
      style_class: "macos-dock-tooltip",
      text: "",
      visible: false,
    });
    Main.layoutManager.addTopChrome(this._tooltipText);

    this._menuManager = new PopupMenu.PopupMenuManager(this._container);

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
      Main.layoutManager.removeChrome(this._tooltipText);
      this._tooltipText.destroy();
      this._tooltipText = null;
    }

    this._closeContextMenu();
    this._menuManager = null;

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

  getIconCount(): number {
    return this._icons.size;
  }

  hasSeparator(): boolean {
    return this._separator !== null;
  }

  hasAppButton(): boolean {
    return this._appButton !== null;
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
    this._appButton = null;

    this._favorites = this._readFavorites();

    const appSystem = Shell.AppSystem.get_default();

    // Add favorites in their stored order first.
    for (const appId of this._favorites) {
      const app = appSystem.lookup_app(appId);
      if (!app) continue;
      this._addIcon(app);
    }

    // Get running apps that aren't favorites
    const runningApps = this._showRunningApps
      ? this._getRunningApps().filter((app) => !this._favorites.includes(app.get_id()))
      : [];

    // Add separator if there are both favorites and running apps
    if (this._favorites.length > 0 && runningApps.length > 0) {
      this._addSeparator();
    }

    // Then any running app that isn't already a favorite.
    for (const app of runningApps) {
      this._addIcon(app);
    }

    // Add applications button at the end
    this._updateAppButton();
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

    // Remove icons for apps that are no longer running and aren't favorites,
    // or all non-favorite running apps if show-running-apps is disabled.
    for (const [id, actor] of this._icons.entries()) {
      const isFavorite = this._favorites.includes(id);
      if (isFavorite) continue;
      if (!this._showRunningApps || !runningIds.has(id)) {
        toRemove.push(id);
        const easeOut = (params: Record<string, unknown>) =>
          actor.ease(params as Parameters<typeof actor.ease>[0]);
        easeOut({
          opacity: 0,
          scale_x: 0.8,
          scale_y: 0.8,
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

    // Add icons for newly running, non-favorited apps (only if enabled).
    if (this._showRunningApps) {
      for (const id of runningIds) {
        if (this._icons.has(id)) continue;
        if (this._favorites.includes(id)) continue;
        const appSystem = Shell.AppSystem.get_default();
        const app = appSystem.lookup_app(id);
        if (!app) continue;
        this._addIcon(app);
        changed = true;
      }
    }

    // Update separator visibility
    this._updateSeparator();

    this._refreshAllIndicators();

    // Notify dock to resize when icons were added/removed.
    if (changed && this._onIconsChanged) this._onIconsChanged();
  }

  private _updateSeparator(): void {
    if (!this._showRunningApps) {
      if (this._separator) {
        this._separator.destroy();
        this._separator = null;
      }
      return;
    }

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
      y_align: Clutter.ActorAlign.FILL,
    }) as IconActor;

    this._applyIconSize(actor);

    const icon = new St.Icon({
      gicon: app.get_icon(),
      icon_size: this._iconSize,
      style_class: "macos-dock-icon-gicon",
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });

    const iconWrapper = new St.Widget({
      style_class: "macos-dock-icon-wrapper",
      layout_manager: new Clutter.FixedLayout(),
      x_align: Clutter.ActorAlign.CENTER,
      width: this._iconSize,
      height: this._iconSize,
    });
    icon.set_position(0, 0);
    iconWrapper.add_child(icon);

    actor.add_child(iconWrapper);

    // Container for running indicator dots (or a single bar).
    const indicatorBox = new St.BoxLayout({
      style_class: "macos-dock-indicator-box",
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    actor.add_child(indicatorBox);

    // Store references on the actor for retrieval later.
    const appData: AppData = {
      appId,
      icon,
      iconWrapper,
      indicatorBox,
      dots: [],
      mediaIndicator: null,
    };
    (actor as unknown as Record<string, unknown>)._appData = appData;

    this._signals.connect(actor, "button-press-event", (_actor, event) => {
      const button = (event as { get_button: () => number }).get_button();
      if (button === 3) {
        this._showContextMenu(actor, app);
        return Clutter.EVENT_STOP;
      }
      if (button !== 1) {
        return Clutter.EVENT_PROPAGATE;
      }
      if (this._onClicked) {
        this._onClicked(app);
      }
      return Clutter.EVENT_STOP;
    });

    // Tooltip events - use notify::hover since track_hover is enabled
    this._signals.connect(actor, "notify::hover", () => {
      if (actor.hover) {
        this._showTooltip(actor, app.get_name());
        // Show window preview popup
        if (this._windowPreviewsEnabled && this._previewPopup) {
          this._previewPopup.cancelScheduledHide();
          this._previewPopup.show(app, actor);
        }
      } else {
        this._hideTooltip();
        // Schedule hide of preview popup (delay allows mouse to move to popup)
        if (this._previewPopup?.isVisible()) {
          this._previewPopup.scheduleHide();
        }
      }
      return Clutter.EVENT_PROPAGATE;
    });

    this._container.add_child(actor);
    this._icons.set(appId, actor);
    this._apps.set(appId, app);

    // Animate icon appearing (fade in + scale)
    // Note: scale_x/scale_y are the correct GJS property names (snake_case),
    // even though TypeScript types expect camelCase (scaleX/scaleY).
    actor.opacity = 0;
    actor.scale_x = 0.8;
    actor.scale_y = 0.8;
    const easeIn = (params: Record<string, unknown>) =>
      actor.ease(params as Parameters<typeof actor.ease>[0]);
    easeIn({
      opacity: 255,
      scale_x: 1.0,
      scale_y: 1.0,
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
      data.iconWrapper.set_size(this._iconSize, this._iconSize);
      if (data.mediaIndicator) {
        this._positionMediaIndicator(data.mediaIndicator);
      }
    }
    const padded = this._iconSize + 12;
    actor.set_size(padded, padded + 4);
  }

  private _positionMediaIndicator(indicator: InstanceType<typeof St.Widget>): void {
    const badgeSize = IconManager.MEDIA_BADGE_SIZE;
    const inset = IconManager.MEDIA_BADGE_INSET;
    indicator.set_size(badgeSize, badgeSize);
    indicator.set_position(this._iconSize - badgeSize + inset, -inset);
  }

  private _refreshAllIndicators(): void {
    for (const [appId, actor] of this._icons.entries()) {
      this._refreshRunningIndicator(actor, appId);
    }
  }

  private _refreshAllMediaIndicators(): void {
    for (const [appId, actor] of this._icons.entries()) {
      this._refreshMediaIndicator(actor, appId);
    }
  }

  private _refreshMediaIndicator(actor: IconActor, appId: string): void {
    const data = this._getStored(actor);
    if (!data) return;

    const isPlaying = this._mediaIndicatorEnabled && this._playingAppId === appId;

    if (isPlaying && !data.mediaIndicator) {
      const badge = new St.Widget({
        style_class: "macos-dock-media-indicator",
        layout_manager: new Clutter.BinLayout(),
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      const noteIcon = new St.Icon({
        icon_name: "folder-music-symbolic",
        icon_size: 8,
        style_class: "macos-dock-media-indicator-icon",
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      badge.add_child(noteIcon);
      this._positionMediaIndicator(badge);
      data.iconWrapper.add_child(badge);
      data.mediaIndicator = badge;
    } else if (!isPlaying && data.mediaIndicator) {
      data.iconWrapper.remove_child(data.mediaIndicator);
      data.mediaIndicator.destroy();
      data.mediaIndicator = null;
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
    const activeWorkspace = global.workspace_manager.get_active_workspace();
    for (const wa of windows) {
      const metaWin = wa.get_meta_window();
      if (!metaWin) continue;
      if (!metaWin.showing_on_its_workspace()) continue;
      if (this._workspaceMode === 1 && metaWin.get_workspace() !== activeWorkspace) continue;
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
    this._closeContextMenu();
    if (!this._menuManager) return;

    const menu = new PopupMenu.PopupMenu(actor, 0.5, St.Side.TOP);
    (menu as unknown as { blockSourceEvents: boolean }).blockSourceEvents = true;
    menu.box.add_style_class_name("macos-dock-popup-menu");
    Main.uiGroup.add_child(menu.actor);
    this._contextMenu = menu;
    this._menuSignals = new SignalManager();

    const menuItems: { label: string; action: () => void }[] = [
      { label: "New Window", action: () => app.open_new_window(-1) },
    ];

    if (this._mediaControlsEnabled && this._playingAppId === app.get_id()) {
      menuItems.push({
        label: "Play/Pause",
        action: () => this._onMediaAction?.("play-pause"),
      });
      menuItems.push({
        label: "Next",
        action: () => this._onMediaAction?.("next"),
      });
      menuItems.push({
        label: "Previous",
        action: () => this._onMediaAction?.("previous"),
      });
    }

    menuItems.push({ label: "Close", action: () => this._closeApp(app) });

    for (const item of menuItems) {
      const menuItem = new PopupMenu.PopupMenuItem(item.label);
      this._menuSignals.connect(menuItem, "activate", () => {
        item.action();
        this._closeContextMenu();
      });
      menu.addMenuItem(menuItem);
    }

    this._menuSignals.connect(menu, "open-state-changed", (_source, isOpen) => {
      if (!isOpen) {
        this._finalizeContextMenu();
      }
    });

    this._menuManager.addMenu(menu);
    this._onContextMenuActorChanged?.(menu.actor);

    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      if (this._contextMenu !== menu) {
        return GLib.SOURCE_REMOVE;
      }
      menu.open(BoxPointer.PopupAnimation.FULL);
      this._menuManager?.ignoreRelease?.();
      return GLib.SOURCE_REMOVE;
    });
  }

  private _closeContextMenu(): void {
    if (!this._contextMenu) return;
    if (this._contextMenu.isOpen) {
      this._contextMenu.close();
    } else {
      this._finalizeContextMenu();
    }
  }

  private _finalizeContextMenu(): void {
    this._onContextMenuActorChanged?.(null);
    if (this._menuSignals) {
      this._menuSignals.disconnectAll();
      this._menuSignals = null;
    }
    if (this._contextMenu) {
      const menu = this._contextMenu;
      this._contextMenu = null;
      this._menuManager?.removeMenu(menu);
      menu.destroy();
    }
  }

  private _closeApp(app: Shell.App): void {
    const windows = app.get_windows();
    for (const window of windows) {
      window.delete(global.get_current_time());
    }
  }

  private _addSeparator(): void {
    if (this._separator) return;

    this._separator = new St.Widget({
      style_class: "macos-dock-separator",
      width: 1,
      height: 32,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });

    // Insert after the last favorite icon, before non-favorite running apps
    let insertIndex = 0;
    for (const [id] of this._icons) {
      if (this._favorites.includes(id)) {
        insertIndex++;
      } else {
        break;
      }
    }
    this._container.insert_child_at_index(this._separator, insertIndex);
  }

  private _updateAppButton(): void {
    if (this._showAppButton && !this._appButton) {
      this._addAppButton();
    } else if (!this._showAppButton && this._appButton) {
      this._removeAppButton();
    }
  }

  private _addAppButton(): void {
    if (this._appButton) return;

    const padded = this._iconSize + 12;

    this._appButton = new St.BoxLayout({
      style_class: "macos-dock-app-button",
      reactive: true,
      track_hover: true,
      vertical: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.FILL,
      width: padded,
      height: padded + 4,
    });

    this._appButtonIcon = new St.Icon({
      icon_name: "view-app-grid-symbolic",
      icon_size: this._iconSize,
      style_class: "macos-dock-app-button-icon",
    });
    this._appButton.add_child(this._appButtonIcon);

    this._signals.connect(this._appButton, "button-press-event", () => {
      if (Main.overview.visible) {
        Main.overview.hide();
      } else {
        Main.overview.showApps();
      }
      return Clutter.EVENT_STOP;
    });

    // Tooltip on hover
    this._signals.connect(this._appButton, "notify::hover", () => {
      if (this._appButton?.hover) {
        this._showTooltip(this._appButton, "Applications");
      } else {
        this._hideTooltip();
      }
    });

    this._container.add_child(this._appButton);

    // Notify dock to resize
    if (this._onIconsChanged) this._onIconsChanged();
  }

  private _removeAppButton(): void {
    if (!this._appButton) return;
    this._container.remove_child(this._appButton);
    this._appButton.destroy();
    this._appButton = null;
    this._appButtonIcon = null;

    // Notify dock to resize
    if (this._onIconsChanged) this._onIconsChanged();
  }
}
