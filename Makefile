UUID = macos-dock@vinnytherobot.github.io
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
VERSION = $(shell node -e "console.log(require('./metadata.json').version)")

.PHONY: build install clean lint zip

build:
	npm run build
	glib-compile-schemas schemas/

lint:
	npx biome check src/

install: build
	mkdir -p $(INSTALL_DIR)
	cp -r dist/* $(INSTALL_DIR)/
	cp metadata.json $(INSTALL_DIR)/
	cp stylesheet.css $(INSTALL_DIR)/
	cp -r schemas $(INSTALL_DIR)/
	@echo "Installed. Restart Shell (Alt+F2 → r) or re-login."

zip: build
	@mkdir -p dist/schemas
	@cp -r schemas/*.compiled dist/schemas/ 2>/dev/null || true
	@cd dist && zip -r ../$(UUID).v$(VERSION).zip . -x '*.map'
	@echo "Created $(UUID).v$(VERSION).zip"

clean:
	npm run clean
	rm -rf schemas/*.compiled
