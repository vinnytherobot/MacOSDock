// Builds a GNOME Shell 42 compatible copy of the extension into dist-legacy/.
//
// GNOME 42 loads extension.js and prefs.js as legacy GJS scripts (no ES
// modules), so the ESM sources in src/ are bundled into single files and their
// gi:// and resource:/// imports are mapped onto the legacy `imports` object.
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shims = join(root, "legacy", "shims");
const outDir = join(root, "dist-legacy");
const SHELL_VERSIONS = ["42"];

const shimPaths = {
  "gi://Adw": join(shims, "adw.js"),
  "gi://Gtk": join(shims, "gtk.js"),
  "resource:///org/gnome/shell/extensions/extension.js": join(shims, "extension.js"),
  "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js": join(shims, "prefs.js"),
};

const legacyImports = {
  name: "legacy-imports",
  setup(b) {
    b.onResolve({ filter: /^(gi|resource):/ }, (args) => {
      if (shimPaths[args.path]) return { path: shimPaths[args.path] };
      return { path: args.path, namespace: "legacy" };
    });

    b.onLoad({ filter: /.*/, namespace: "legacy" }, (args) => {
      const gi = args.path.match(/^gi:\/\/(\w+)$/);
      if (gi)
        return { contents: `const ns = imports.gi.${gi[1]};\nexport default ns;`, loader: "js" };

      const ui = args.path.match(/^resource:\/\/\/org\/gnome\/shell\/ui\/(\w+)\.js$/);
      if (ui) return { contents: `module.exports = imports.ui.${ui[1]};`, loader: "js" };

      return { errors: [{ text: `No GNOME 42 mapping for import "${args.path}"` }] };
    });
  },
};

async function bundle(entry, footer) {
  await build({
    entryPoints: [join(root, "src", entry)],
    outfile: join(outDir, entry.replace(/\.ts$/, ".js")),
    bundle: true,
    format: "iife",
    globalName: "MacosDockLegacy",
    target: "firefox91", // GJS 1.72 (GNOME 42) runs SpiderMonkey 91
    define: { "import.meta.url": "__macosDockExtensionUri" },
    plugins: [legacyImports],
    banner: { js: "var __macosDockExtensionUri = null;" },
    footer: { js: footer },
    logLevel: "warning",
  });
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await bundle(
  "extension.ts",
  `function init(extension) {
  __macosDockExtensionUri = extension.dir.get_child("extension.js").get_uri();
  return new MacosDockLegacy.default(extension);
}`,
);

await bundle(
  "prefs.ts",
  `var __macosDockPrefs = null;
function init(metadata) {
  __macosDockPrefs = new MacosDockLegacy.default(metadata);
}
function fillPreferencesWindow(window) {
  __macosDockPrefs.fillPreferencesWindow(window);
}`,
);

const metadata = JSON.parse(readFileSync(join(root, "metadata.json"), "utf8"));
metadata["shell-version"] = SHELL_VERSIONS;
writeFileSync(join(outDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
copyFileSync(join(root, "stylesheet.css"), join(outDir, "stylesheet.css"));
cpSync(join(root, "schemas"), join(outDir, "schemas"), { recursive: true });

console.log(`Built GNOME ${SHELL_VERSIONS.join(", ")} extension in dist-legacy/`);
