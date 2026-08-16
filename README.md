# MacOS Dock for GNOME Shell

A macOS-style dock extension for GNOME Shell featuring smooth magnification, configurable animations, and native-like behavior.

## Features

- **Auto-hide dock** with configurable show/hide thresholds and smooth animations
- **Magnification effect** with adjustable scale and falloff distance
- **Running indicators** — dots per window (macOS style) or horizontal bar
- **Click-to-minimize** for focused applications
- **Configurable performance** settings for framerate and animation duration
- **Native GNOME integration** — hides the default dash to avoid conflicts

## Compatibility

- GNOME Shell 45+
- Tested on Fedora, Ubuntu, and Arch Linux

## Installation

### From Source

```bash
git clone https://github.com/vinnytherobot/MacOSDock.git
cd MacOSDock
make install
```

The extension will be installed to `~/.local/share/gnome-shell/extensions/macos-dock@vinnytherobot.github.io/`.

### Restart GNOME Shell

- **X11**: Press `Alt+F2`, type `r`, and press Enter
- **Wayland**: Log out and log back in

### Enable the Extension

```bash
gnome-extensions enable macos-dock@vinnytherobot.github.io
```

## Configuration

Access the extension preferences through GNOME Extensions app or:

```bash
gnome-extensions prefs macos-dock@vinnytherobot.github.io
```

### Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Auto-hide | Hide dock when pointer moves away | Enabled |
| Bounce on launch | Animate icon when app starts | Enabled |
| Animation duration | Show/hide animation time (ms) | 200 |
| Show threshold | Distance from edge to trigger show (px) | 25 |
| Enable magnification | Scale icons on hover | Enabled |
| Max scale | Maximum magnification factor | 1.4 |
| Falloff distance | Magnification wave reach (px) | 100 |
| Running indicators | Show running app indicators | Enabled |
| Indicator style | Dots per window or horizontal bar | Dots |
| Framerate | Animation framerate (Hz) | 60 |

## Development

### Prerequisites

- Node.js 18+
- TypeScript 5+
- GNOME Shell SDK (for type definitions)

### Build

```bash
npm install
npm run build
```

### Watch Mode

```bash
npm run watch
```

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request.

## Acknowledgments

- GNOME Shell extension development community
- Dash-to-Dock project for inspiration on native dash hiding techniques
