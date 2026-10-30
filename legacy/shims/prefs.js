// GNOME 42 stand-in for resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js.
// The prefs dialog points ExtensionUtils.getCurrentExtension() at this
// extension before calling init(), so it is the source of dir and metadata.
import { getSettingsFor } from "./settings.js";

export class ExtensionPreferences {
  constructor(metadata) {
    const extension = imports.misc.extensionUtils.getCurrentExtension();
    this.metadata = metadata ?? extension.metadata;
    this.uuid = this.metadata.uuid;
    this.dir = extension.dir;
    this.path = extension.path;
  }

  getSettings(schema) {
    return getSettingsFor(this.dir, schema ?? this.metadata["settings-schema"]);
  }
}
