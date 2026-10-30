// GNOME 42 stand-in for resource:///org/gnome/shell/extensions/extension.js.
// The legacy loader passes the extension object (uuid, dir, path, metadata)
// to init(); this exposes the subset of the GNOME 45+ Extension API used here.
import { getSettingsFor } from "./settings.js";

export class Extension {
  constructor(extension) {
    this.metadata = extension.metadata;
    this.uuid = extension.uuid;
    this.dir = extension.dir;
    this.path = extension.path;
  }

  getSettings(schema) {
    return getSettingsFor(this.dir, schema ?? this.metadata["settings-schema"]);
  }
}
