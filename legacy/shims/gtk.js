// GTK 4.6 (GNOME 42) has no Gtk.StringList:strings construct property
// (added in 4.10), so build string lists through Gtk.StringList.new().
const Gtk = imports.gi.Gtk;

function StringList(params = {}) {
  const { strings, ...rest } = params;
  const list = Gtk.StringList.new(strings ?? []);
  if (Object.keys(rest).length > 0) list.set(rest);
  return list;
}

const overrides = { StringList };

// Proxy an empty object: GI namespace properties may be non-configurable,
// which forbids a proxy of the namespace itself from returning substitutes.
export default new Proxy(
  {},
  { get: (_target, key) => (key in overrides ? overrides[key] : Gtk[key]) },
);
