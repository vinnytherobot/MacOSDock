UUID = macos-dock@vinnytherobot.github.io
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
VERSION = $(shell node -e "console.log(require('./metadata.json').version)")
# GNOME Shell < 45 cannot load ES-module extensions; install the legacy build there.
SHELL_MAJOR = $(shell gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -n1)
LEGACY_SHELL = $(shell [ -n "$(SHELL_MAJOR)" ] && [ "$(SHELL_MAJOR)" -lt 45 ] && echo yes)

.PHONY: build build-legacy install install-modern install-legacy clean lint zip

node_modules: package.json package-lock.json
	npm ci
	@touch node_modules

build: node_modules
	npm run build
	glib-compile-schemas schemas/

lint: node_modules
	npx biome check src/

build-legacy: node_modules
	node legacy/build.mjs
	glib-compile-schemas dist-legacy/schemas/

ifeq ($(LEGACY_SHELL),yes)
install: install-legacy
else
install: install-modern
endif

install-legacy: build-legacy
	rm -rf $(INSTALL_DIR)
	mkdir -p $(INSTALL_DIR)
	cp -r dist-legacy/* $(INSTALL_DIR)/
	@echo "Installed GNOME $(SHELL_MAJOR) build. Restart Shell (Alt+F2 → r) or re-login."

install-modern: build
	rm -rf $(INSTALL_DIR)
	mkdir -p $(INSTALL_DIR)
	cp -r dist/* $(INSTALL_DIR)/
	cp metadata.json $(INSTALL_DIR)/
	cp stylesheet.css $(INSTALL_DIR)/
	cp -r schemas $(INSTALL_DIR)/
	@echo "Installed. Restart Shell (Alt+F2 → r) or re-login."

zip: build
	@cp metadata.json dist/
	@cp stylesheet.css dist/
	@mkdir -p dist/schemas
	@cp schemas/*.gschema.xml dist/schemas/
	@rm -f dist/schemas/gschemas.compiled
	@cd dist && zip -r ../$(UUID).v$(VERSION).zip . -x '*.map' -x 'schemas/gschemas.compiled'
	@echo "Created $(UUID).v$(VERSION).zip"

clean:
	npm run clean
	rm -rf dist-legacy
	rm -rf schemas/*.compiled
