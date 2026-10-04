import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Shell from "gi://Shell";
import St from "gi://St";
import * as BoxPointer from "resource:///org/gnome/shell/ui/boxpointer.js";
import * as DND from "resource:///org/gnome/shell/ui/dnd.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { SignalManager } from "./signalManager.js";
import type { WindowPreviewPopup } from "./windowPreview.js";

export type DockIconClicked = (app: Shell.App) => void;
export type IconsChanged = () => void;
export type MediaAction = "play-pause" | "next" | "previous";
export type DragStateChanged = (dragging: boolean) => void;

type IconActor = InstanceType<typeof St.BoxLayout>;
type Draggable = ReturnType<typeof DND.makeDraggable>;

interface AppData {
  appId: string;
  icon: InstanceType<typeof St.Icon>;
  iconWrapper: InstanceType<typeof St.Widget>;
  indicatorBox: InstanceType<typeof St.BoxLayout>;
  dots: InstanceType<typeof St.Widget>[];
  mediaIndicator: InstanceType<typeof St.Widget> | null;
  draggable: Draggable | null;
  dragSignalIds: number[];
}

type ContextMenu = InstanceType<typeof PopupMenu.PopupMenu>;
type MenuManager = InstanceType<typeof PopupMenu.PopupMenuManager>;

/** Delegate exposed on a dragged icon so the drop target knows the source. */
interface DragSource {
  appId: string;
  isFavorite: boolean;
}

/** Container-local rectangle of the slot an icon was lifted out of. */
interface DragSlot {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Drop-target methods invoked by the DND framework on the dock container. */
interface DropTarget {
  handleDragOver(
    source: DragSource | null,
    dragActor: Clutter.Actor,
    x: number,
    y: number,
    time: number,
  ): number;
  acceptDrop(
    source: DragSource | null,
    dragActor: Clutter.Actor,
    x: number,
    y: number,
    time: number,
  ): boolean;
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
  private _onDragStateChanged: DragStateChanged | null = null;
  private _dragReorderEnabled: boolean = true;
  private _dragging: boolean = false;
  private _dragSlot: DragSlot | null = null;
  private _pressedAppId: string | null = null;
  private _dropIndicator: InstanceType<typeof St.Widget> | null = null;
  private _dropTarget: DropTarget | null = null;
  private _favoriteSettings: Gio.Settings | null = null;
  private _pendingReload: boolean = false;
  private _pendingReloadSourceId: number | null = null;

  /** Gap between icons, mirrors the `spacing` declared in _applyDockStyle. */
  private static readonly ICON_SPACING = 6;
  private static readonly DROP_INDICATOR_THICKNESS = 3;
  private static readonly DROP_INDICATOR_LENGTH = 32;
  private static readonly DROP_ZONE_PADDING = 8;

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

  setOnDragStateChanged(callback: DragStateChanged): void {
    this._onDragStateChanged = callback;
  }

  setDragReorderEnabled(enabled: boolean): void {
    if (this._dragReorderEnabled === enabled) return;
    this._dragReorderEnabled = enabled;
    // If a drag is in flight the drop target now refuses it (NO_DROP), so the
    // reload is simply deferred until the drag settles.
    this._reload();
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

    // Favorites are the single source of truth for pinned-icon order.
    this._favoriteSettings = new Gio.Settings({ schema: "org.gnome.shell" });
    this._signals.connect(this._favoriteSettings, "changed::favorite-apps", () =>
      this._onFavoritesChangedExternally(),
    );

    // The dock container is the drop target; the picked actor's ancestors are
    // walked by the DND framework until one exposes these methods.
    this._dropTarget = {
      handleDragOver: (source, dragActor, x, y, time) =>
        this._handleDragOver(source, dragActor, x, y, time),
      acceptDrop: (source, dragActor, x, y, time) =>
        this._acceptDrop(source, dragActor, x, y, time),
    };
    (this._container as unknown as Record<string, unknown>)._delegate = this._dropTarget;

    this._reload();
  }

  stop(): void {
    if (this._windowChangeSourceId !== null) {
      GLib.source_remove(this._windowChangeSourceId);
      this._windowChangeSourceId = null;
    }

    this._signals.disconnectAll();

    this._hideTooltip();
    if (this._tooltipText) {
      Main.layoutManager.removeChrome(this._tooltipText);
      this._tooltipText.destroy();
      this._tooltipText = null;
    }

    this._closeContextMenu();
    this._menuManager = null;

    this._teardownDraggables();
    this._removeDropIndicator();
    this._dropTarget = null;
    (this._container as unknown as Record<string, unknown>)._delegate = null;
    this._favoriteSettings = null;
    this._dragging = false;
    this._dragSlot = null;
    this._pressedAppId = null;
    this._pendingReload = false;
    this._removePendingReloadSource();

    // Destroy instead of merely detaching. The icon being dragged lives in
    // the UI group, not in the container, so it has to be destroyed here too:
    // that is what makes the DND framework release its modal grab, which it
    // otherwise holds until the actor is garbage collected.
    for (const actor of this._icons.values()) {
      if (actor.get_parent()) actor.destroy();
    }
    for (const child of this._container.get_children()) child.destroy();
    this._icons.clear();
    this._apps.clear();
    this._favorites = [];
    this._separator = null;
    this._appButton = null;
    this._appButtonIcon = null;
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
    if (this._dragging) {
      // Rebuilding the container mid-drag would destroy the drag actor; the
      // dock is stable enough to survive until the drag settles.
      this._pendingReload = true;
      return;
    }
    this._pendingReload = false;
    this._removePendingReloadSource();
    this._teardownDraggables();
    this._removeDropIndicator();
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
      draggable: null,
      dragSignalIds: [],
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
      // Arm the click only. Activation happens on release so a press that
      // turns into a drag-reorder never launches the app. Propagate so the
      // DND framework's own press handler still runs.
      this._pressedAppId = appId;
      return Clutter.EVENT_PROPAGATE;
    });

    this._signals.connect(actor, "button-release-event", (_actor, event) => {
      const button = (event as { get_button: () => number }).get_button();
      if (button !== 1) {
        return Clutter.EVENT_PROPAGATE;
      }
      const pressed = this._pressedAppId;
      this._pressedAppId = null;
      if (this._dragging) return Clutter.EVENT_PROPAGATE;
      if (!pressed || pressed !== appId) return Clutter.EVENT_PROPAGATE;
      if (!this._isPointerOver(actor)) return Clutter.EVENT_PROPAGATE;
      if (this._onClicked) {
        this._onClicked(app);
      }
      return Clutter.EVENT_PROPAGATE;
    });

    // Tooltip events - use notify::hover since track_hover is enabled
    this._signals.connect(actor, "notify::hover", () => {
      if (this._dragging) {
        // Keep tooltips and previews out of the way while reordering.
        this._hideTooltip();
        if (this._previewPopup?.isVisible()) this._previewPopup.hide();
        return Clutter.EVENT_PROPAGATE;
      }
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

    if (this._dragReorderEnabled && this._favorites.includes(appId)) {
      this._makeDraggable(actor, appId);
    }

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
    const settings = this._favoriteSettings ?? new Gio.Settings({ schema: "org.gnome.shell" });
    return settings.get_strv("favorite-apps");
  }

  /**
   * Pinned icon actors currently in the container, in display order. The icon
   * being dragged is excluded automatically because the DND framework
   * reparents it to the UI group while a drag is in flight.
   */
  private _favoriteActors(): IconActor[] {
    const result: IconActor[] = [];
    for (const child of this._container.get_children()) {
      const data = this._getStored(child as IconActor);
      if (data && this._favorites.includes(data.appId)) {
        result.push(child as IconActor);
      }
    }
    return result;
  }

  private _makeDraggable(actor: IconActor, appId: string): void {
    const data = this._getStored(actor);
    if (!data) return;

    (actor as unknown as Record<string, unknown>)._delegate = {
      appId,
      isFavorite: true,
    } satisfies DragSource;

    const draggable = DND.makeDraggable(actor, { dragActorOpacity: 200 });
    const signalIds = [
      draggable.connect("drag-begin", () => this._onDragBegin(appId)),
      draggable.connect("drag-cancelled", () => this._removeDropIndicator()),
      draggable.connect("drag-end", (_self, _time: number, success: boolean) =>
        this._onDragEnd(appId, success),
      ),
    ];

    data.draggable = draggable;
    data.dragSignalIds = signalIds;
  }

  private _teardownDraggables(): void {
    for (const actor of this._icons.values()) {
      const data = this._getStored(actor);
      if (data?.draggable) {
        for (const id of data.dragSignalIds) data.draggable.disconnect(id);
        data.draggable = null;
        data.dragSignalIds = [];
      }
      const record = actor as unknown as Record<string, unknown>;
      if (record._delegate) record._delegate = null;
    }
  }

  private _onDragBegin(appId: string): void {
    this._dragging = true;
    this._dragSlot = this._captureSlot(appId);
    this._pressedAppId = null;
    this._hideTooltip();
    this._previewPopup?.cancelScheduledHide();
    this._previewPopup?.hide();
    this._onDragStateChanged?.(true);
  }

  /**
   * Read the container-local rectangle of a pinned icon. Called from
   * `drag-begin`, which the DND framework emits before it lifts the actor
   * out of the container, so the slot is still measurable.
   */
  private _captureSlot(appId: string): DragSlot | null {
    const actor = this._icons.get(appId);
    if (!actor || actor.get_parent() !== this._container) return null;
    const [x, y] = actor.get_position();
    const [w, h] = actor.get_size();
    return { x, y, w, h };
  }

  private _onDragEnd(appId: string, success: boolean): void {
    this._dragging = false;
    this._dragSlot = null;
    this._pressedAppId = null;
    this._removeDropIndicator();

    const actor = this._icons.get(appId);
    if (actor) {
      // The DND framework leaves drag-time styling to the drop target on
      // success, and its snap-back restores scale but not the fixed position
      // it took over while dragging under the pointer.
      actor.opacity = 255;
      actor.scale_x = 1;
      actor.scale_y = 1;
      actor.fixed_position_set = false;
      this._applyIconSize(actor);
    }
    if (!success) {
      // A cancelled drop re-adds the icon at the end of the container; put it
      // back where the stored favorites order says it belongs.
      this._restoreFavoriteSlot(appId);
    }

    this._onDragStateChanged?.(false);

    if (this._pendingReload) {
      this._pendingReload = false;
      // Deferred: the DND framework still owns the drag actor until it
      // finishes emitting drag-end, so rebuild on the next idle slice.
      this._removePendingReloadSource();
      this._pendingReloadSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        this._pendingReloadSourceId = null;
        this._reload();
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  private _removePendingReloadSource(): void {
    if (this._pendingReloadSourceId !== null) {
      GLib.source_remove(this._pendingReloadSourceId);
      this._pendingReloadSourceId = null;
    }
  }

  private _restoreFavoriteSlot(appId: string): void {
    const actor = this._icons.get(appId);
    if (!actor || actor.get_parent() !== this._container) return;

    // A cancelled drop re-appends the icon at the end of the container.
    // Recompute its slot from the stored order rather than from the current
    // child order, which the append has just disturbed.
    const positionInFavorites = this._favorites.indexOf(appId);
    if (positionInFavorites < 0) return;
    let desired = 0;
    for (let i = 0; i < positionInFavorites; i++) {
      if (this._icons.has(this._favorites[i])) desired++;
    }

    const current = this._container.get_children().indexOf(actor);
    if (current === desired) return;

    this._container.remove_child(actor);
    this._container.insert_child_at_index(actor, desired);
  }

  private _handleDragOver(
    source: DragSource | null,
    _dragActor: Clutter.Actor,
    x: number,
    y: number,
    _time: number,
  ): number {
    if (!source?.isFavorite) {
      // Not a source we created. CONTINUE lets the DND framework keep walking
      // up the target chain instead of pinning a foreign drag to this dock.
      this._removeDropIndicator();
      return DND.DragMotionResult.CONTINUE;
    }
    if (!this._dragReorderEnabled || !this._favorites.includes(source.appId)) {
      this._removeDropIndicator();
      return DND.DragMotionResult.NO_DROP;
    }

    const index = this._calcDropIndex(x, y);
    if (index < 0) {
      this._removeDropIndicator();
      return DND.DragMotionResult.NO_DROP;
    }

    this._showDropIndicator(index);
    return DND.DragMotionResult.MOVE_DROP;
  }

  private _acceptDrop(
    source: DragSource | null,
    dragActor: Clutter.Actor,
    x: number,
    y: number,
    _time: number,
  ): boolean {
    if (!this._dragReorderEnabled || !source?.isFavorite) return false;
    if (!this._favorites.includes(source.appId)) return false;

    const actor = this._icons.get(source.appId);
    if (!actor || actor !== dragActor) return false;

    const index = this._calcDropIndex(x, y);
    if (index < 0) return false;

    // Map the drop slot (computed over the visible pinned icons) back onto the
    // stored favorites list so entries without a rendered actor survive.
    const present = this._favoriteActors()
      .map((a) => this._getStored(a)?.appId)
      .filter((id): id is string => !!id && id !== source.appId);
    const beforeId = index < present.length ? present[index] : null;

    const order = this._favorites.filter((id) => id !== source.appId);
    const at = beforeId ? order.indexOf(beforeId) : order.length;
    if (at < 0) {
      order.push(source.appId);
    } else {
      order.splice(at, 0, source.appId);
    }

    const previous = this._favorites;
    this._favorites = order;
    if (!this._writeFavorites(order)) {
      this._favorites = previous;
      return false;
    }

    this._reorderFavoriteActors(order);
    this._removeDropIndicator();

    // Undo the drag-time styling applied by the DND framework: it lifts the
    // icon into the UI group, pins an explicit position under the pointer and
    // drops the opacity. Reparenting alone does not restore any of that.
    actor.fixed_position_set = false;
    actor.opacity = 255;
    actor.scale_x = 1;
    actor.scale_y = 1;
    this._applyIconSize(actor);
    return true;
  }

  private _isVerticalLayout(): boolean {
    const box = this._container as unknown as { orientation?: number; vertical?: boolean };
    if (box.orientation !== undefined) return box.orientation === Clutter.Orientation.VERTICAL;
    return box.vertical === true;
  }

  /**
   * Insertion slot for a pointer position given in container-local
   * coordinates, or -1 when the pointer is outside the pinned area.
   */
  private _calcDropIndex(x: number, y: number): number {
    const vertical = this._isVerticalLayout();
    const coord = vertical ? y : x;
    const pad = IconManager.DROP_ZONE_PADDING;

    const favs = this._favoriteActors();
    if (favs.length === 0) {
      // The dragged icon is the only pinned one, so the container has no
      // sibling left to measure against. Fall back to the slot it was lifted
      // from so the drop is accepted as a no-op rather than snapping back.
      const slot = this._dragSlot;
      if (!slot) return -1;
      const start = (vertical ? slot.y : slot.x) - pad;
      const size = vertical ? slot.h : slot.w;
      if (coord < start || coord > start + size + pad) return -1;
      return 0;
    }

    const first = favs[0];
    const [fx, fy] = first.get_position();
    const last = favs[favs.length - 1];
    const [lx, ly] = last.get_position();
    const [lw, lh] = last.get_size();

    const zoneStart = (vertical ? fy : fx) - pad;
    const zoneEnd = (vertical ? ly + lh : lx + lw) + pad;
    if (coord < zoneStart || coord > zoneEnd) return -1;

    for (let i = 0; i < favs.length; i++) {
      const [px, py] = favs[i].get_position();
      const [pw, ph] = favs[i].get_size();
      const center = vertical ? py + ph / 2 : px + pw / 2;
      if (coord < center) return i;
    }
    return favs.length;
  }

  private _showDropIndicator(index: number): void {
    const vertical = this._isVerticalLayout();
    const halfGap = IconManager.ICON_SPACING / 2;

    const favs = this._favoriteActors();
    let cross: number;
    let crossSize: number;
    let boundary: number;

    if (favs.length > 0) {
      const n = favs.length;
      const ref = index < n ? favs[index] : favs[n - 1];
      const [rx, ry] = ref.get_position();
      const [rw, rh] = ref.get_size();

      // Slot edge in container-local coordinates (midway through the gap).
      const slotAtEnd = index === n;
      boundary = vertical
        ? slotAtEnd
          ? ry + rh + halfGap
          : ry - halfGap
        : slotAtEnd
          ? rx + rw + halfGap
          : rx - halfGap;
      cross = vertical ? rx : ry;
      crossSize = vertical ? rw : rh;
    } else if (this._dragSlot) {
      // Sole pinned icon: mark the leading edge of the slot it came from.
      const slot = this._dragSlot;
      cross = vertical ? slot.x : slot.y;
      crossSize = vertical ? slot.w : slot.h;
      boundary = vertical ? slot.y - halfGap : slot.x - halfGap;
    } else {
      return;
    }

    if (!this._dropIndicator) {
      this._dropIndicator = new St.Widget({ style_class: "macos-dock-drop-indicator" });
      // Keep the indicator out of stage picking so it can never become the
      // drop target itself.
      Shell.util_set_hidden_from_pick(this._dropIndicator, true);
      Main.layoutManager.addTopChrome(this._dropIndicator);
    }

    const thickness = IconManager.DROP_INDICATOR_THICKNESS;
    const length = Math.max(8, Math.min(IconManager.DROP_INDICATOR_LENGTH, crossSize - 8));
    const [cx, cy] = this._container.get_transformed_position();

    if (vertical) {
      this._dropIndicator.set_size(length, thickness);
      this._dropIndicator.set_position(
        cx + cross + (crossSize - length) / 2,
        cy + boundary - thickness / 2,
      );
    } else {
      this._dropIndicator.set_size(thickness, length);
      this._dropIndicator.set_position(
        cx + boundary - thickness / 2,
        cy + cross + (crossSize - length) / 2,
      );
    }
  }

  private _removeDropIndicator(): void {
    if (!this._dropIndicator) return;
    Main.layoutManager.removeChrome(this._dropIndicator);
    this._dropIndicator.destroy();
    this._dropIndicator = null;
  }

  /** Reparent and reorder pinned icons so the container matches `order`. */
  private _reorderFavoriteActors(order: string[]): void {
    const actors: IconActor[] = [];
    for (const id of order) {
      const actor = this._icons.get(id);
      if (actor) actors.push(actor);
    }

    for (const actor of actors) {
      const parent = actor.get_parent();
      if (parent) parent.remove_child(actor);
    }
    actors.forEach((actor, i) => {
      this._container.insert_child_at_index(actor, i);
    });
  }

  private _writeFavorites(order: string[]): boolean {
    if (!this._favoriteSettings) return false;
    return this._favoriteSettings.set_strv("favorite-apps", order);
  }

  private _onFavoritesChangedExternally(): void {
    const order = this._readFavorites();
    const same =
      order.length === this._favorites.length && order.every((id, i) => id === this._favorites[i]);
    if (same) return;
    this._reload();
  }

  private _isPointerOver(actor: IconActor): boolean {
    const [px, py] = global.get_pointer();
    const [ax, ay] = actor.get_transformed_position();
    const [aw, ah] = actor.get_transformed_size();
    return px >= ax && px <= ax + aw && py >= ay && py <= ay + ah;
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
