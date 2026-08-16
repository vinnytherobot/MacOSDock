import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import { DockManager } from "./lib/dockManager.js";

export default class MacosDockExtension extends Extension {
  private _dockManager: DockManager | null = null;

  enable(): void {
    this._dockManager = new DockManager();
    this._dockManager.enable(this.getSettings());
    console.log(`[macos-dock] Enabled (v${this.metadata.version})`);
  }

  disable(): void {
    if (this._dockManager) {
      this._dockManager.disable();
      this._dockManager = null;
    }
    console.log("[macos-dock] Disabled");
  }
}
