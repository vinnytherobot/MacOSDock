const Gio = imports.gi.Gio;

/** Load a GSettings object from the extension's bundled schemas directory. */
export function getSettingsFor(dir, schemaId) {
  const schemaDir = dir.get_child("schemas");
  const defaultSource = Gio.SettingsSchemaSource.get_default();
  const source = schemaDir.query_exists(null)
    ? Gio.SettingsSchemaSource.new_from_directory(schemaDir.get_path(), defaultSource, false)
    : defaultSource;

  const schema = source.lookup(schemaId, true);
  if (!schema) throw new Error(`Schema ${schemaId} could not be found for ${dir.get_path()}`);
  return new Gio.Settings({ settings_schema: schema });
}
