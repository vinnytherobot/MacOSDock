# MacOS Dock - Features & Updates Roadmap

This document outlines potential features and updates for the MacOSDock GNOME Shell extension, organized by category. Features are designed to enhance user experience and introduce innovative capabilities not found in competing dock extensions.

---

## Table of Contents

1. [UX Improvements](#1-ux-improvements)
2. [Innovative Features](#2-innovative-features)
3. [Technical Improvements](#3-technical-improvements)
4. [Integration Features](#4-integration-features)
5. [Implementation Priority](#5-implementation-priority)

---

## 1. UX Improvements

Features that enhance existing functionality and bring the dock closer to macOS parity.

### 1.1 Window Preview Thumbnails
**Description**: Show live thumbnail previews of app windows when hovering over a dock icon.

**Behavior**:
- Hover over icon → display thumbnail(s) of open windows
- Multiple windows show stacked previews with slight offset
- Click thumbnail to focus that specific window
- Close button on each thumbnail preview

**Technical Notes**:
- Use `Clutter.OffscreenEffect` for window capture
- Implement as tooltip-like popup above/below dock
- Requires `Meta.Window.get_texture()` for live thumbnails

### 1.2 Context Menus (Right-Click)
**Description**: Right-click menu on dock icons with app-specific options.

**Default Options**:
- New Window
- Show All Windows
- Keep in Dock / Remove from Dock
- Quit Application
- Options submenu (Window Management)

**Technical Notes**:
- Use `St.PopupMenu` for menu rendering
- Integrate with `Shell.App` for app-specific actions
- Support keyboard navigation

### 1.3 App Name Tooltips
**Description**: Show app name tooltip when hovering over dock icons.

**Behavior**:
- 500ms delay before showing tooltip
- Tooltip follows mouse position
- Clean fade-in/fade-out animation
- Respects system tooltip styling

**Technical Notes**:
- Use `St.Tooltip` or custom `St.BoxLayout` tooltip
- Position calculation to avoid screen edges

### 1.4 Drag-and-Drop Reordering
**Description**: Allow users to reorder dock icons by dragging.

**Behavior**:
- Long-press + drag to reorder
- Visual feedback during drag (icon follows cursor)
- Smooth animation when icons shift to make space
- Persist new order to favorites list
- Support dragging apps to/from favorites

**Technical Notes**:
- Use `Clutter.DragAction` for drag handling
- Implement drop zones between existing icons
- Update `org.gnome.shell` `favorite-apps` on drop

### 1.5 Dock Position Options
**Description**: Allow dock placement on any screen edge.

**Options**:
- Bottom (default, macOS-style)
- Left (Ubuntu-style)
- Right
- Top (less common, but available)

**Technical Notes**:
- Add `dock-position` setting (enum: bottom, left, right, top)
- Adjust `DockManager._updatePosition()` for each orientation
- Update magnification and visibility logic for vertical docks
- Consider different pivot points for magnification per position

### 1.6 Background Customization
**Description**: Allow users to customize dock background appearance.

**Options**:
- Background color with alpha channel
- Opacity slider (0-100%)
- Blur effect toggle and intensity
- Border radius adjustment
- Border color and width

**Technical Notes**:
- Use `Shell.BlurEffect` for blur (GNOME 3.36+)
- Dynamic CSS generation based on settings
- Preview changes in real-time

### 1.7 Keyboard Shortcuts
**Description**: Keyboard shortcuts for dock navigation and control.

**Proposed Shortcuts**:
- `Super+D` - Toggle dock visibility
- `Super+[1-9]` - Focus app at position 1-9
- `Super+0` - Focus 10th app
- `Super+Left/Right` - Navigate between dock icons
- `Super+Enter` - Activate selected icon

**Technical Notes**:
- Use `Main.wm.addKeybinding()` for global shortcuts
- Implement keyboard navigation state machine
- Visual indicator for selected icon

### 1.8 Smooth Icon Animations
**Description**: Animated transitions when icons are added or removed from dock.

**Behavior**:
- New icons: fade in + scale from 0.8 to 1.0
- Removed icons: fade out + scale to 0.8
- Duration: 200ms (configurable)
- No layout jumps during transitions

**Technical Notes**:
- Use `Clutter.Actor.ease()` for animations
- Queue animations to prevent layout thrashing
- Consider using `Clutter.ActorMeta` for declarative animations

### 1.9 Notification Badges
**Description**: Show unread count badges on dock icons.

**Behavior**:
- Badge shows number (1-99+, then 99+)
- Configurable position (top-right, top-left, etc.)
- Badge color customizable
- Optional: show different colors per app type

**Technical Notes**:
- Integrate with `Shell.AppSystem` for app state
- Create `St.BoxLayout` badge overlay
- Update on app notification events

### 1.10 Trash/Recycle Bin
**Description**: macOS-style trash can icon in dock.

**Behavior**:
- Fixed position (right side of dock, after separator)
- Empty/full visual states
- Click to open trash folder
- Right-click to empty trash
- Drag-and-drop files to trash

**Technical Notes**:
- Monitor trash directory via `Gio.FileMonitor`
- Create custom icon for empty/full states
- Implement drag-and-drop target zone

---

## 2. Innovative Features

Unique features that differentiate MacOSDock from other GNOME dock extensions.

### 2.1 Smart Icon Grouping (Stacks)
**Description**: Group multiple windows of the same app into a visual stack with click-to-expand.

**Behavior**:
- Multiple windows of same app stack into one icon with visual depth effect
- Click stacked icon → fan out windows in grid view
- Click specific window to focus it
- Stack indicator shows window count
- Optional: auto-group by default or manual grouping

**Why Innovative**:
- macOS shows individual dots but doesn't visually stack
- Dash-to-Dock shows window previews but doesn't stack icons
- This creates a cleaner dock with visual hierarchy

**Technical Notes**:
- Implement `StackedIcon` actor with layered `St.Icon` children
- Grid view popup with `Clutter.GridLayout`
- Track window-to-stack mapping

### 2.2 Activity-Based Auto-Hide
**Description**: Hide dock based on user activity patterns and focus state.

**Behavior**:
- Learn user patterns (e.g., hide during work hours, show during breaks)
- Detect focus mode (e.g., when a distraction-free app is active)
- Customizable rules:
  - Hide when specific apps are focused
  - Hide after X minutes of inactivity
  - Show on mouse movement to screen edge
  - Show on keyboard shortcut regardless of state

**Why Innovative**:
- Current auto-hide is purely position-based
- This adds temporal and contextual awareness
- Adapts to user workflow, not just pointer position

**Technical Notes**:
- Implement activity tracker with `GLib.timeout_add()`
- Create rule engine for hide/show conditions
- Persist activity patterns in settings

### 2.3 Workspace-Aware Dock
**Description**: Show different icon sets per workspace with visual workspace indicator.

**Behavior**:
- Option 1: Show only apps on current workspace
- Option 2: Show all apps but dim non-active-workspace apps
- Visual workspace indicator (dots or mini-map)
- Drag app to different workspace via dock
- Quick workspace switcher in dock

**Why Innovative**:
- Most docks show all apps regardless of workspace
- This creates workspace-specific workflows
- Reduces visual clutter in multi-workspace setups

**Technical Notes**:
- Monitor `global.workspace_manager` for workspace changes
- Filter icons by `window.get_workspace()`
- Create workspace indicator widget

### 2.4 Progress Indicators
**Description**: Show download/install progress directly on dock icons.

**Behavior**:
- Circular progress ring around icon
- Linear progress bar below icon
- Animated pulse during active download
- Color change on completion (green flash)

**Apps Supported**:
- Web browsers (download progress)
- Software center (install progress)
- File operations (copy/move)
- Custom via D-Bus signals

**Why Innovative**:
- No GNOME dock extension shows real-time progress
- macOS shows progress but only in Launchpad
- This provides system-wide progress visibility

**Technical Notes**:
- Monitor `org.freedesktop.Progress` if available
- Implement `Clutter.Canvas` for custom drawing
- Create progress overlay actor

### 2.5 Quick Actions Menu
**Description**: Long-press or gesture to show app-specific quick actions.

**Behavior**:
- Long-press icon → slide up quick actions panel
- Actions based on app type:
  - Browser: New Window, New Incognito, History
  - Terminal: New Window, Split Horizontal, Split Vertical
  - File Manager: Home, Documents, Downloads, Trash
- Customizable actions per app
- Keyboard shortcut to trigger

**Why Innovative**:
- macOS has limited Quick Actions (just "Options")
- This extends the concept to app-specific workflows
- Reduces need to open full app for common tasks

**Technical Notes**:
- Implement `QuickActionsPanel` actor
- Integrate with `Gio.DesktopAppInfo` for app actions
- Store custom actions in GSettings

### 2.6 Focus Mode Integration
**Description**: Dim or hide non-essential apps when a focus mode is active.

**Behavior**:
- Define "focus apps" (e.g., code editor, writing app)
- When focus app is active:
  - Dim non-focus app icons (50% opacity)
  - Optional: hide non-focus apps entirely
  - Show focus timer/indicator in dock
- Manual focus mode toggle

**Why Innovative**:
- No dock extension integrates with focus/productivity modes
- GNOME has no built-in focus mode
- This creates a distraction-free dock experience

**Technical Notes**:
- Create focus mode settings (list of focus apps)
- Implement dimming via `Clutter.Actor.opacity`
- Optional: integrate with `gnome-pomodoro` or similar

### 2.7 App Snapshots (Live Thumbnails)
**Description**: Show live, updating thumbnails of app windows in a grid above the dock.

**Behavior**:
- Hover over icon → show grid of live window thumbnails
- Thumbnails update in real-time (5fps to save CPU)
- Click thumbnail to focus window
- Drag thumbnail to move window to different monitor/workspace
- Close button on each thumbnail

**Why Innovative**:
- Dash-to-Dock has static previews
- This shows LIVE, UPDATING thumbnails
- Provides true "Mission Control" feel in the dock

**Technical Notes**:
- Use `Clutter.OffscreenEffect` for live capture
- Throttle updates to 5fps for performance
- Implement `Clutter.GridLayout` for thumbnail grid

### 2.8 Smart Sorting
**Description**: Automatically sort icons based on usage frequency or recent activity.

**Behavior**:
- Options:
  - Manual (default, user-defined order)
  - Most Used (sort by launch count)
  - Recently Used (sort by last active time)
  - Alphabetical
- Pinned apps always stay first
- Sorting happens in background (no visual jarring)

**Why Innovative**:
- Most docks have manual or alphabetical only
- This adapts to user behavior automatically
- Reduces time to find frequently used apps

**Technical Notes**:
- Track app launch counts in GSettings
- Implement sorting algorithm with stable sort
- Animate icon reordering smoothly

### 2.9 Visual Effects
**Description**: Dynamic background effects that respond to mouse movement or app state.

**Effects**:
- **Parallax**: Background shifts slightly with mouse movement
- **Glow**: Dock glows when mouse approaches
- **Pulse**: Subtle pulse animation on running app icons
- **Color Shift**: Background color shifts based on time of day (warm at night, cool during day)

**Why Innovative**:
- No dock extension has dynamic visual effects
- Creates a more "alive" and responsive dock
- Personalization beyond static colors

**Technical Notes**:
- Use `Clutter.PropertyTransition` for animations
- Implement effect classes with configurable parameters
- Use `Shell.BlurEffect` for glow effects

### 2.10 Cross-Workspace Drag
**Description**: Drag app icons between workspaces directly from the dock.

**Behavior**:
- Drag icon to workspace indicator → move app to that workspace
- Drag icon to edge of screen → move to adjacent workspace
- Visual feedback shows target workspace
- Batch move: drag multiple selected icons

**Why Innovative**:
- No GNOME dock supports cross-workspace drag
- Reduces need to use overview for workspace management
- Faster workspace organization

**Technical Notes**:
- Implement drop zones on workspace indicator
- Use `Clutter.DragAction` with custom drop handling
- Integrate with `global.workspace_manager`

---

## 3. Technical Improvements

Infrastructure and performance enhancements.

### 3.1 Multi-Monitor Support
**Description**: Extend dock to multiple monitors with per-monitor settings.

**Features**:
- Separate dock on each monitor
- Per-monitor icon sets (optional)
- Per-monitor auto-hide behavior
- Unified settings or per-monitor overrides

**Technical Notes**:
- Monitor `Main.layoutManager.monitors` for monitor changes
- Create separate `DockManager` instances per monitor
- Share signal management across instances

### 3.2 Proper Icon Quality/DPI Scaling
**Description**: Implement actual DPI scaling for crisp icons at any size.

**Behavior**:
- Load icons at 1x, 2x, or 4x native resolution
- Scale down to display size for sharp rendering
- Automatic detection of display DPI
- Manual override option

**Technical Notes**:
- Use `St.Icon.set_icon_size()` with scale factor
- Load icons via `Gio.File` at higher resolution
- Apply `Clutter.SnapInstanceNode` for scaling

### 3.3 Dynamic Dock Height
**Description**: Adjust dock height based on icon size and content.

**Behavior**:
- Auto-calculate height from icon size + padding
- Smooth height transitions when icon size changes
- Account for indicator size
- Minimum and maximum height constraints

**Technical Notes**:
- Update `DockManager.DOCK_HEIGHT` dynamically
- Use `Clutter.Actor.set_height()` with animation
- Recalculate on icon size changes

### 3.4 Improved Bounce Detection
**Description**: More accurate detection of app launches for bounce animation.

**Behavior**:
- Monitor `Shell.AppSystem` `application-state-changed` signal
- Track app state transitions (starting → running)
- Debounce multiple rapid launches
- Optional: disable bounce for specific apps

**Technical Notes**:
- Replace focus-based detection with state-based
- Implement app state machine
- Add bounce exceptions list to settings

### 3.5 Performance Optimizations
**Description**: Optimize magnification and animation performance.

**Improvements**:
- Reduce polling frequency when dock is idle
- Use `Clutter.FrameClock` instead of `GLib.timeout_add`
- Implement dirty flag for layout calculations
- Profile and optimize hot paths

**Technical Notes**:
- Measure frame times with `Clutter.get_frame_time()`
- Use `Clutter.Actor.set_pivot_point()` for GPU-accelerated transforms
- Batch property changes to prevent multiple redraws

### 3.6 Memory Leak Prevention
**Description**: Improve signal lifecycle management and resource cleanup.

**Improvements**:
- Audit all `connect()` calls for matching `disconnect()`
- Implement weak references where appropriate
- Add debug logging for leaked signals
- Create `ResourceTracker` utility class

**Technical Notes**:
- Use `SignalManager` consistently across all components
- Implement `dispose()` pattern for actors
- Add memory profiling in debug mode

### 3.7 Accessibility Features
**Description**: Add accessibility support for screen readers and keyboard navigation.

**Features**:
- ARIA labels for dock icons
- Keyboard navigation (arrow keys, Enter, Escape)
- High contrast mode support
- Screen reader announcements for state changes

**Technical Notes**:
- Use `Atk.Object` for accessibility
- Implement `keyboard-focus` handling
- Support `high-contrast` stylesheet

---

## 4. Integration Features

Features that integrate with other GNOME components and services.

### 4.1 GNOME Shell Notifications
**Description**: Show notification indicators on dock icons.

**Behavior**:
- Badge shows notification count
- Different badge colors for urgent vs normal
- Click icon → show notification center or app
- Clear notifications from dock

**Technical Notes**:
- Monitor `Main.notificationDaemon` for notifications
- Integrate with `Shell.NotificationDaemon`
- Create notification badge overlay

### 4.2 Media Player Controls
**Description**: Show media player controls in dock for active media.

**Behavior**:
- Detect active media player via MPRIS
- Show album art as dock icon (optional)
- Hover to show play/pause, next, previous controls
- Click album art to open player

**Technical Notes**:
- Monitor MPRIS D-Bus signals
- Create `MediaPlayerControls` widget
- Handle multiple media players

### 4.3 Calendar/Event Previews
**Description**: Show upcoming calendar events on dock hover.

**Behavior**:
- Hover over calendar icon → show next 3 events
- Event details (title, time, location)
- Click event to open calendar app
- Remind me feature

**Technical Notes**:
- Integrate with `EvolutionDataServer` (GNOME Calendar backend)
- Create calendar preview widget
- Handle calendar permissions

### 4.4 Weather Widget
**Description**: Show current weather in dock.

**Behavior**:
- Weather icon in dock (optional position)
- Hover to show temperature and forecast
- Click to open weather app
- Configurable weather source

**Technical Notes**:
- Integrate with weather APIs (OpenWeatherMap, etc.)
- Create weather widget actor
- Cache weather data to avoid API limits

### 4.5 System Tray Integration
**Description**: Optional: include system tray icons in dock.

**Behavior**:
- Show system tray icons (network, volume, battery)
- Click to open system settings
- Drag to reorder
- Hide/show individual icons

**Technical Notes**:
- Monitor `StatusNotifierWatcher` D-Bus service
- Create system tray container
- Handle icon themes

---

## 5. Implementation Priority

### High Priority (Quick Wins)
1. **App Name Tooltips** - Simple, high UX value
2. **Context Menus** - Expected feature, moderate effort
3. **Smooth Icon Animations** - Visual polish, moderate effort
4. **Dynamic Dock Height** - Fix current limitation, easy
5. **Notification Badges** - Useful, moderate effort

### Medium Priority (Core Features)
1. **Window Preview Thumbnails** - High value, moderate complexity
2. **Drag-and-Drop Reordering** - Expected feature, high complexity
3. **Dock Position Options** - High value, moderate effort
4. **Background Customization** - Personalization, moderate effort
5. **Keyboard Shortcuts** - Accessibility, moderate effort

### High Priority (Innovative)
1. **Smart Icon Grouping (Stacks)** - Differentiating feature
2. **Workspace-Aware Dock** - Unique workflow feature
3. **Focus Mode Integration** - Productivity feature
4. **Progress Indicators** - System integration feature
5. **Quick Actions Menu** - Workflow enhancement

### Lower Priority (Advanced)
1. **Multi-Monitor Support** - Complex, but expected by power users
2. **Activity-Based Auto-Hide** - Advanced intelligence
3. **App Snapshots (Live Thumbnails)** - Performance intensive
4. **Visual Effects** - Nice to have, not essential
5. **Cross-Workspace Drag** - Advanced workflow feature

### Future Considerations
1. **Trash/Recycle Bin** - Useful but requires file system integration
2. **Smart Sorting** - Nice to have, requires usage tracking
3. **Media Player Controls** - Niche but useful for some users
4. **Calendar/Event Previews** - Integration complexity
5. **Weather Widget** - External API dependency

---

## Technical Feasibility Notes

### GNOME Shell API Limitations
- **No native blur**: Must use `Shell.BlurEffect` (available since GNOME 3.36)
- **Limited DPI control**: `St.Icon` doesn't expose fine-grained DPI scaling
- **No native drag-and-drop**: Must implement with `Clutter.DragAction`
- **Window capture**: `Meta.Window.get_texture()` available but performance varies
- **D-Bus integration**: Limited to available interfaces (MPRIS, StatusNotifier, etc.)

### Performance Considerations
- **Magnification polling**: Keep at 60Hz max, reduce when idle
- **Window thumbnails**: Throttle updates to 5-10fps
- **Live effects**: Use `Clutter.FrameClock` instead of timers where possible
- **Memory**: Monitor for leaks, especially with window texture caching

### Cross-Version Compatibility
- Target GNOME 45+ (Shell 45-50)
- Use feature detection where possible
- Maintain fallbacks for older GNOME versions
- Test on Fedora, Ubuntu, and Arch Linux

---

## Conclusion

The MacOSDock extension has a solid foundation with its magnification engine, smooth animations, and clean architecture. By implementing the high-priority UX improvements and innovative features outlined above, it can become the definitive macOS-style dock for GNOME Shell.

The most differentiating features will be:
1. **Smart Icon Grouping (Stacks)** - Unique visual hierarchy
2. **Workspace-Aware Dock** - Workspace-specific workflows
3. **Focus Mode Integration** - Distraction-free experience
4. **Progress Indicators** - System-wide visibility
5. **Quick Actions Menu** - App-specific workflows

These features would set MacOSDock apart from Dash-to-Dock, Ubuntu Dock, and other competitors by offering not just a visual clone, but an intelligent, workflow-aware dock that adapts to how users actually work.
