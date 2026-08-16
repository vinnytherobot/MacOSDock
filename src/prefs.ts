import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

const BIND_FLAGS = 0 | 1 | 2 | 4; // DEFAULT | GET | SET | NO_SENSITIVITY

export default class MacosDockPreferences extends ExtensionPreferences {
  private _signalIds: number[] = [];

  async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    const settings = this.getSettings();

    const page = new Adw.PreferencesPage({
      title: "General",
      icon_name: "preferences-system-symbolic",
    });
    window.add(page);

    // Appearance group
    const appearanceGroup = new Adw.PreferencesGroup({
      title: "Appearance",
      description: "Visual look of the dock",
    });
    page.add(appearanceGroup);

    const iconSizeRow = new Adw.SpinRow({
      title: "Icon size",
      subtitle: "Pixel size of dock icons",
      adjustment: new Gtk.Adjustment({
        lower: 16,
        upper: 96,
        step_increment: 2,
        page_increment: 8,
        value: settings.get_int("icon-size"),
      }),
    });
    settings.bind("icon-size", iconSizeRow, "value", BIND_FLAGS);
    appearanceGroup.add(iconSizeRow);

    // Behavior group
    const behaviorGroup = new Adw.PreferencesGroup({
      title: "Behavior",
    });
    page.add(behaviorGroup);

    const autoHideRow = new Adw.SwitchRow({
      title: "Auto-hide",
      subtitle: "Dock hides when the pointer moves away from it",
    });
    settings.bind("auto-hide", autoHideRow, "active", BIND_FLAGS);
    behaviorGroup.add(autoHideRow);

    const bounceRow = new Adw.SwitchRow({
      title: "Bounce on launch",
      subtitle: "Animate the dock icon when an app starts",
    });
    settings.bind("bounce-on-launch", bounceRow, "active", BIND_FLAGS);
    behaviorGroup.add(bounceRow);

    const animDurationRow = new Adw.SpinRow({
      title: "Animation duration",
      subtitle: "Show/hide animation time in milliseconds (0 = instant)",
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 1000,
        step_increment: 10,
        page_increment: 50,
        value: settings.get_int("animation-duration"),
      }),
    });
    settings.bind("animation-duration", animDurationRow, "value", BIND_FLAGS);
    behaviorGroup.add(animDurationRow);

    const showThresholdRow = new Adw.SpinRow({
      title: "Show threshold",
      subtitle: "Distance in pixels from screen edge to trigger dock show",
      adjustment: new Gtk.Adjustment({
        lower: 5,
        upper: 100,
        step_increment: 5,
        page_increment: 10,
        value: settings.get_int("show-threshold"),
      }),
    });
    settings.bind("show-threshold", showThresholdRow, "value", BIND_FLAGS);
    behaviorGroup.add(showThresholdRow);

    // Magnification group
    const magGroup = new Adw.PreferencesGroup({
      title: "Magnification",
      description: "Icon grows when the pointer is near it",
    });
    page.add(magGroup);

    const magEnabledRow = new Adw.SwitchRow({
      title: "Enable magnification",
    });
    settings.bind("magnification-enabled", magEnabledRow, "active", BIND_FLAGS);
    magGroup.add(magEnabledRow);

    // Max scale - connect to adjustment's signal, not the row's
    const magScaleAdj = new Gtk.Adjustment({
      lower: 1.0,
      upper: 2.0,
      step_increment: 0.05,
      page_increment: 0.1,
      value: settings.get_double("magnification-scale"),
    });
    const magScaleRow = new Adw.SpinRow({
      title: "Max scale",
      subtitle: "1.0 = no magnification, 2.0 = double size",
      adjustment: magScaleAdj,
      digits: 2,
    });
    magScaleAdj.connect("value-changed", () => {
      settings.set_double("magnification-scale", magScaleAdj.get_value());
    });
    this._trackSignal(settings, "changed::magnification-scale", () => {
      magScaleAdj.set_value(settings.get_double("magnification-scale"));
    });
    magGroup.add(magScaleRow);

    // Falloff distance
    const magFalloffAdj = new Gtk.Adjustment({
      lower: 40,
      upper: 300,
      step_increment: 10,
      page_increment: 20,
      value: settings.get_int("magnification-falloff"),
    });
    const magFalloffRow = new Adw.SpinRow({
      title: "Falloff distance",
      subtitle: "How far the magnification wave reaches (pixels)",
      adjustment: magFalloffAdj,
    });
    magFalloffAdj.connect("value-changed", () => {
      settings.set_int("magnification-falloff", magFalloffAdj.get_value());
    });
    this._trackSignal(settings, "changed::magnification-falloff", () => {
      magFalloffAdj.set_value(settings.get_int("magnification-falloff"));
    });
    magGroup.add(magFalloffRow);

    // Indicators group
    const indGroup = new Adw.PreferencesGroup({
      title: "Indicators",
    });
    page.add(indGroup);

    const indicatorsRow = new Adw.SwitchRow({
      title: "Running indicators",
      subtitle: "Show a dot under icons of running apps",
    });
    settings.bind("running-indicators", indicatorsRow, "active", BIND_FLAGS);
    indGroup.add(indicatorsRow);

    // Indicator style
    const indicatorStyleModel = new Gtk.StringList({
      strings: ["Dots per window", "Horizontal bar"],
    });
    const indicatorStyleRow = new Adw.ComboRow({
      title: "Indicator style",
      subtitle: "Dots per window (macOS) or a single horizontal bar",
      model: indicatorStyleModel,
      selected: settings.get_int("running-indicator-style"),
    });
    indicatorStyleRow.connect("notify::selected", () => {
      settings.set_int("running-indicator-style", indicatorStyleRow.selected);
    });
    this._trackSignal(settings, "changed::running-indicator-style", () => {
      indicatorStyleRow.selected = settings.get_int("running-indicator-style");
    });
    indGroup.add(indicatorStyleRow);

    // Performance group
    const perfGroup = new Adw.PreferencesGroup({
      title: "Performance",
    });
    page.add(perfGroup);

    // Icon Quality
    const qualityModel = new Gtk.StringList({ strings: ["x1", "x2", "x4"] });
    const qualityRow = new Adw.ComboRow({
      title: "Icon Quality",
      subtitle: "Set icon resolution to improve rendering quality",
      model: qualityModel,
      selected:
        settings.get_int("icon-quality") === 4 ? 2 : settings.get_int("icon-quality") === 2 ? 1 : 0,
    });
    qualityRow.connect("notify::selected", () => {
      const values = [1, 2, 4];
      settings.set_int("icon-quality", values[qualityRow.selected]);
    });
    this._trackSignal(settings, "changed::icon-quality", () => {
      const v = settings.get_int("icon-quality");
      qualityRow.selected = v === 4 ? 2 : v === 2 ? 1 : 0;
    });
    perfGroup.add(qualityRow);

    // Framerate
    const fpsModel = new Gtk.StringList({ strings: ["30", "60", "120"] });
    const fpsRow = new Adw.ComboRow({
      title: "Framerate",
      subtitle: "Set animation framerate. Higher is smoother but uses more CPU",
      model: fpsModel,
      selected:
        settings.get_int("magnification-framerate") === 120
          ? 2
          : settings.get_int("magnification-framerate") === 60
            ? 1
            : 0,
    });
    fpsRow.connect("notify::selected", () => {
      const values = [30, 60, 120];
      settings.set_int("magnification-framerate", values[fpsRow.selected]);
    });
    this._trackSignal(settings, "changed::magnification-framerate", () => {
      const v = settings.get_int("magnification-framerate");
      fpsRow.selected = v === 120 ? 2 : v === 60 ? 1 : 0;
    });
    perfGroup.add(fpsRow);

    // Disconnect all tracked signals when the window is closed.
    window.connect("closed", () => this._disconnectAll());
  }

  private _trackSignal(
    source: { connect(signal: string, callback: (...args: unknown[]) => void): number },
    signal: string,
    callback: (...args: unknown[]) => void,
  ): void {
    const id = source.connect(signal, callback);
    this._signalIds.push(id);
  }

  private _disconnectAll(): void {
    this._signalIds = [];
  }
}
