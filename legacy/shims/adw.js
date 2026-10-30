// libadwaita 1.1 (GNOME 42) lacks Adw.SwitchRow and Adw.SpinRow (added in
// 1.4). These ActionRow-based replacements expose the same `active` / `value`
// properties so GSettings bindings in prefs.ts work unchanged.
const Adw = imports.gi.Adw;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const SwitchRow =
  Adw.SwitchRow ??
  GObject.registerClass(
    {
      GTypeName: "MacosDockLegacySwitchRow",
      Properties: {
        active: GObject.ParamSpec.boolean(
          "active",
          "Active",
          "Whether the switch is on",
          GObject.ParamFlags.READWRITE,
          false,
        ),
      },
    },
    class SwitchRow extends Adw.ActionRow {
      _init(params = {}) {
        const { active, ...rest } = params;
        super._init(rest);
        this._switch = new Gtk.Switch({ valign: Gtk.Align.CENTER, active: active ?? false });
        this.add_suffix(this._switch);
        this.activatable_widget = this._switch;
        this._switch.connect("notify::active", () => this.notify("active"));
      }

      get active() {
        return this._switch?.active ?? false;
      }

      set active(value) {
        if (this._switch && this._switch.active !== value) this._switch.active = value;
      }
    },
  );

const SpinRow =
  Adw.SpinRow ??
  GObject.registerClass(
    {
      GTypeName: "MacosDockLegacySpinRow",
      Properties: {
        value: GObject.ParamSpec.double(
          "value",
          "Value",
          "Current value",
          GObject.ParamFlags.READWRITE,
          -Number.MAX_VALUE,
          Number.MAX_VALUE,
          0,
        ),
      },
    },
    class SpinRow extends Adw.ActionRow {
      _init(params = {}) {
        const { adjustment, digits, value, ...rest } = params;
        super._init(rest);
        this._spin = new Gtk.SpinButton({
          valign: Gtk.Align.CENTER,
          adjustment: adjustment ?? new Gtk.Adjustment(),
          digits: digits ?? 0,
          numeric: true,
        });
        if (value !== undefined) this._spin.value = value;
        this.add_suffix(this._spin);
        this.activatable_widget = this._spin;
        this._spin.connect("notify::value", () => this.notify("value"));
      }

      get adjustment() {
        return this._spin.adjustment;
      }

      get value() {
        return this._spin?.value ?? 0;
      }

      set value(value) {
        if (this._spin && this._spin.value !== value) this._spin.value = value;
      }
    },
  );

const overrides = { SwitchRow, SpinRow };

// Proxy an empty object: GI namespace properties may be non-configurable,
// which forbids a proxy of the namespace itself from returning substitutes.
export default new Proxy(
  {},
  { get: (_target, key) => (key in overrides ? overrides[key] : Adw[key]) },
);
