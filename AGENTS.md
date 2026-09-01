# Agent Guidelines

This document provides guidelines for AI agents working on this codebase.

## Project Overview

MacOS Dock is a GNOME Shell extension that provides a macOS-style dock experience. It is written in TypeScript and targets GNOME Shell 45+.

## Architecture

```
src/
  extension.ts          # Entry point for GNOME Shell
  prefs.ts              # Extension preferences UI
  lib/
    dockManager.ts      # Core dock lifecycle and layout
    dockVisibility.ts   # Auto-hide logic and animation
    iconManager.ts      # App icon management
    magnification.ts    # Hover magnification effect
    intellihide.ts      # Window overlap detection
    signalManager.ts    # GObject signal lifecycle
    windowPreview.ts    # Window thumbnail preview popup
```

## GNOME Extension Standards

All code must follow the [EGO Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html) and [GNOME Extension Best Practices](https://gjs.guide/extensions/review-guidelines/best-practices.html).

### Lifecycle and Cleanup

- Each class owns its resources (signals, GLib sources, actors) and cleans them up in `stop()` or `disable()`.
- Do not initialize in one class and clean up in another. The owner calls `stop()` on child instances.
- After `stop()`/`disable()`, null out references so instances are never reused.
- Do **not** use boolean guard flags like `this._enabled` or `this._destroyed` to protect against improper lifecycle calls.

### GLib Sources and Timeouts

- Track every `GLib.timeout_add` / `GLib.idle_add` source ID in a field.
- Remove existing sources immediately before creating a new one of the same kind.
- Keep source removal next to source creation so reviewers can verify cleanup.
- Remove all active sources in `stop()` before destroying actors.

### Signal Management

All GObject signal connections must go through `SignalManager` to ensure proper cleanup in `stop()`/`disable()`. Never call `connect()` directly without storing the connection ID.

### Settings

All settings are defined in `schemas/org.gnome.shell.extensions.macosdock.gschema.xml`. Settings are read via `Gio.Settings` and changes are propagated through signal listeners in `dockManager.ts`.

Feature toggles (e.g. window previews) are checked at the call site — in `dockManager.ts` or `iconManager.ts` — not inside popup or widget classes.

### enable() / disable()

Keep `enable()` and `disable()` adjacent in the entry point class. `disable()` must mirror `enable()` cleanup in reverse dependency order.

## Key Patterns

### Icon Lifecycle

Icons are created in `iconManager.ts` and managed through the `_icons` Map. The dock container (`St.BoxLayout`) is created in `dockManager.ts` and passed to all subsystems.

### Magnification

Magnification uses polling at configurable framerates. Scale transitions use linear interpolation (lerp) for smooth visual feedback.

### Window Previews

`WindowPreviewPopup` is owned by `DockManager`. `IconManager` triggers show/hide on hover when the `window-previews` setting is enabled. Only `DockManager.disable()` calls `WindowPreviewPopup.stop()`.

## Common Tasks

### Adding a New Setting

1. Add the key to `schemas/org.gnome.shell.extensions.macosdock.gschema.xml`
2. Add the UI element in `prefs.ts`
3. Add a listener in `dockManager.ts` to propagate changes

### Modifying Dock Behavior

The dock is managed by `DockManager`. Auto-hide logic lives in `DockVisibility`. Window overlap detection is handled by `Intellihide`.

### Changing Icon Appearance

Icons are styled in `stylesheet.css`. The icon size and quality settings affect rendering in `iconManager.ts`.

## Testing

- Run `npm run build` to verify TypeScript compilation
- Install with `make install` and restart GNOME Shell
- Test all settings in the preferences window
- Verify auto-hide behavior at screen edges
- Check magnification smoothness at different framerates

## Versioning

Follow semantic versioning. Update `metadata.json` version and `package.json` version together.
