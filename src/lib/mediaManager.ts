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

  async start(): Promise<void> {
    try {
      this._bus = await new Promise<Gio.DBusConnection>((resolve, reject) => {
        Gio.bus_get(Gio.BusType.SESSION, null, (_source, result) => {
          try {
            resolve(Gio.bus_get_finish(result));
          } catch (e) {
            reject(e);
          }
        });
      });
      this._watchNames();
      await this._discoverPlayers();
    } catch (e) {
      console.error("[macos-dock][media] start error:", e);
    }
  }

  stop(): void {
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

  private async _discoverPlayers(): Promise<void> {
    if (!this._bus) return;
    const bus = this._bus;

    try {
      const result = await new Promise<GLib.Variant>((resolve, reject) => {
        bus.call(
          "org.freedesktop.DBus",
          "/org/freedesktop/DBus",
          "org.freedesktop.DBus",
          "ListNames",
          null,
          new GLib.VariantType("(as)"),
          Gio.DBusCallFlags.NONE,
          -1,
          null,
          (_conn, res) => {
            try {
              resolve(bus.call_finish(res));
            } catch (e) {
              reject(e);
            }
          },
        );
      });
      const [names] = result.deepUnpack() as [string[]];
      const mprisNames = names.filter((n) => n.startsWith("org.mpris.MediaPlayer2"));
      for (const name of mprisNames) {
        await this._addPlayer(name, name);
      }
    } catch (e) {
      console.error("[macos-dock][media] discover error:", e);
    }
  }

  private async _addPlayer(busName: string, uniqueName: string): Promise<void> {
    if (this._players.has(uniqueName)) return;
    if (!this._bus) return;

    try {
      const proxy = Gio.DBusProxy.new_sync(
        this._bus,
        Gio.DBusProxyFlags.NONE,
        null,
        busName,
        MPRIS_PLAYER_PATH,
        MPRIS_PLAYER_IFACE,
        null,
      );

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
    } catch (e) {
      console.error(`[macos-dock] Failed to add player ${busName}:`, e);
    }
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
      const entry = rootProxy.get_cached_property("DesktopEntry");
      if (entry) {
        info.desktopEntry = entry.deepUnpack() as string;
        return;
      }
    } catch {
      // Fall back to parsing the well-known bus name below.
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
