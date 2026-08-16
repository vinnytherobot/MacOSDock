UUID = macos-dock@vinnytherobot.github.io
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: build install clean lint

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

clean:
	npm run clean
	rm -rf schemas/*.compiled
