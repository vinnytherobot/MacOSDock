import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Shell from "gi://Shell";
import { SignalManager } from "./signalManager.js";

const MPRIS_PLAYER_IFACE = "org.mpris.MediaPlayer2.Player";
const MPRIS_PLAYER_PATH = "/org/mpris/MediaPlayer2";

interface MprisPlayerInfo {
  busName: string;
  uniqueName: string;
  proxy: Gio.DBusProxy;
  title: string;
  artist: string;
  status: string;
  desktopEntry: string;
}

export type MediaStateChanged = (app: Shell.App | null) => void;

export class MediaManager {
  private _signals: SignalManager;
  private _bus: Gio.DBusConnection | null = null;
  private _players: Map<string, MprisPlayerInfo> = new Map();
  private _activePlayer: MprisPlayerInfo | null = null;
  private _activeApp: Shell.App | null = null;
  private _onStateChanged: MediaStateChanged | null = null;
  private _watchIds: number[] = [];
  private _discoveryCancellable: Gio.Cancellable | null = null;

  constructor() {
    this._signals = new SignalManager();
  }

  setOnStateChanged(callback: MediaStateChanged): void {
    this._onStateChanged = callback;
  }

  getActiveApp(): Shell.App | null {
    return this._activeApp;
  }

  isPlaying(): boolean {
    return this._activePlayer?.status === "Playing";
  }

  start(): void {
    this._bus = Gio.DBus.session;
    this._discoveryCancellable = new Gio.Cancellable();
    this._watchNames();
    this._discoverPlayers();
  }

  stop(): void {
    this._discoveryCancellable?.cancel();
    this._discoveryCancellable = null;
    this._signals.disconnectAll();
    if (this._bus) {
      for (const id of this._watchIds) {
        this._bus.signal_unsubscribe(id);
      }
    }
    this._watchIds = [];
    this._players.clear();
    this._activePlayer = null;
    this._activeApp = null;
    this._onStateChanged = null;
    this._bus = null;
  }

  togglePlayPause(): void {
    if (!this._activePlayer) return;
    this._activePlayer.proxy.call("PlayPause", null, Gio.DBusCallFlags.NONE, -1, null, null);
  }

  next(): void {
    if (!this._activePlayer) return;
    this._activePlayer.proxy.call("Next", null, Gio.DBusCallFlags.NONE, -1, null, null);
  }

  previous(): void {
    if (!this._activePlayer) return;
    this._activePlayer.proxy.call("Previous", null, Gio.DBusCallFlags.NONE, -1, null, null);
  }

  private _watchNames(): void {
    if (!this._bus) return;

    const signalId = this._bus.signal_subscribe(
      null,
      "org.freedesktop.DBus",
      "NameOwnerChanged",
      "/org/freedesktop/DBus",
      null,
      Gio.DBusSignalFlags.NONE,
      (_conn, _sender, _path, _iface, _signal, params) => {
        const [name, oldOwner, newOwner] = params.deepUnpack() as [string, string, string];
        if (name.startsWith("org.mpris.MediaPlayer2")) {
          if (oldOwner && !newOwner) {
            this._removePlayer(oldOwner);
          } else if (!oldOwner && newOwner) {
            this._addPlayer(name, newOwner);
          }
        }
      },
    );
    this._watchIds.push(signalId);
  }

  private _discoverPlayers(): void {
    if (!this._bus || !this._discoveryCancellable) return;
    const bus = this._bus;
    const cancellable = this._discoveryCancellable;

    bus.call(
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "ListNames",
      null,
      new GLib.VariantType("(as)"),
      Gio.DBusCallFlags.NONE,
      -1,
      cancellable,
      (_connection, res) => {
        if (cancellable.is_cancelled()) return;

        let names: string[];
        try {
          [names] = bus.call_finish(res).deepUnpack() as [string[]];
        } catch (e) {
          if (!cancellable.is_cancelled()) {
            console.error("[macos-dock][media] discover error:", e);
          }
          return;
        }
        for (const name of names) {
          if (name.startsWith("org.mpris.MediaPlayer2")) {
            this._addPlayer(name, name);
          }
        }
      },
    );
  }

  private _addPlayer(busName: string, uniqueName: string): void {
    if (this._players.has(uniqueName)) return;
    if (!this._bus) return;

    let proxy: Gio.DBusProxy;
    try {
      proxy = Gio.DBusProxy.new_sync(
        this._bus,
        Gio.DBusProxyFlags.NONE,
        null,
        busName,
        MPRIS_PLAYER_PATH,
        MPRIS_PLAYER_IFACE,
        null,
      );
    } catch (e) {
      console.error(`[macos-dock] Failed to add player ${busName}:`, e);
      return;
    }

    const info: MprisPlayerInfo = {
      busName,
      uniqueName,
      proxy,
      title: "",
      artist: "",
      status: "Stopped",
      desktopEntry: "",
    };

    this._players.set(uniqueName, info);

    this._updateDesktopEntry(info);
    this._updateMetadata(info);
    this._updatePlaybackStatus(info);

    this._signals.connect(proxy, "g-properties-changed", () => {
      this._updateMetadata(info);
      this._updatePlaybackStatus(info);
      this._pickActivePlayer();
    });

    this._pickActivePlayer();
  }

  private _removePlayer(uniqueName: string): void {
    const wasActive = this._players.get(uniqueName) === this._activePlayer;
    this._players.delete(uniqueName);
    if (wasActive) {
      this._activePlayer = null;
      this._pickActivePlayer();
    }
  }

  private _pickActivePlayer(): void {
    let best: MprisPlayerInfo | null = null;

    for (const info of this._players.values()) {
      if (info.status === "Playing") {
        best = info;
        break;
      }
    }

    if (!best) {
      for (const info of this._players.values()) {
        if (info.status === "Paused") {
          best = info;
          break;
        }
      }
    }

    if (!best && this._players.size > 0) {
      best = this._players.values().next().value ?? null;
    }

    if (this._activePlayer !== best) {
      this._activePlayer = best;
      this._activeApp = this._resolveApp(best);
      this._notify();
    }
  }

  private _resolveApp(player: MprisPlayerInfo | null): Shell.App | null {
    if (!player?.desktopEntry) return null;
    const appSystem = Shell.AppSystem.get_default();
    return appSystem.lookup_app(`${player.desktopEntry}.desktop`) ?? null;
  }

  private _updateDesktopEntry(info: MprisPlayerInfo): void {
    if (!this._bus) return;

    let entry: GLib.Variant | null = null;
    try {
      const rootProxy = Gio.DBusProxy.new_sync(
        this._bus,
        Gio.DBusProxyFlags.NONE,
        null,
        info.busName,
        MPRIS_PLAYER_PATH,
        "org.mpris.MediaPlayer2",
        null,
      );
      entry = rootProxy.get_cached_property("DesktopEntry");
    } catch {
      // Fall back to parsing the well-known bus name below.
    }

    if (entry) {
      info.desktopEntry = entry.deepUnpack() as string;
      return;
    }

    const prefix = "org.mpris.MediaPlayer2.";
    if (info.busName.startsWith(prefix)) {
      info.desktopEntry = info.busName.slice(prefix.length);
    }
  }

  private _updateMetadata(info: MprisPlayerInfo): void {
    const metadata = info.proxy.get_cached_property("Metadata");
    if (!metadata) return;
    const dict = metadata.recursiveUnpack() as Record<string, unknown>;

    info.title = String(dict["xesam:title"] ?? "");
    const artist = dict["xesam:artist"];
    info.artist = Array.isArray(artist) ? artist.join(", ") : String(artist ?? "");
  }

  private _updatePlaybackStatus(info: MprisPlayerInfo): void {
    const status = info.proxy.get_cached_property("PlaybackStatus");
    if (status) {
      info.status = status.deepUnpack() as string;
    }
  }

  private _notify(): void {
    if (this._onStateChanged) {
      this._onStateChanged(this._activeApp);
    }
  }
}
