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
```

## Key Patterns

### Settings

All settings are defined in `schemas/org.gnome.shell.extensions.macosdock.gschema.xml`. Settings are read via `Gio.Settings` and changes are propagated through signal listeners in `dockManager.ts`.

### Signal Management

All GObject signal connections must go through `SignalManager` to ensure proper cleanup in `disable()`. Never call `connect()` directly without storing the connection ID.

### Icon Lifecycle

Icons are created in `iconManager.ts` and managed through the `_icons` Map. The dock container (`St.BoxLayout`) is created in `dockManager.ts` and passed to all subsystems.

### Magnification

Magnification uses polling at configurable framerates. Scale transitions use linear interpolation (lerp) for smooth visual feedback.

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
