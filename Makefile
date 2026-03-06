EXTENSION_NAME := symfony-explorer
VERSION := $(shell node -p "require('./package.json').version")
VSIX := $(EXTENSION_NAME)-$(VERSION).vsix

.PHONY: install build package local-install clean

install:
	npm install

build: install
	npm run build

package: build
	npx @vscode/vsce package --allow-missing-repository

local-install: package
	cursor --install-extension $(VSIX)
	@echo "\n✅ $(EXTENSION_NAME) v$(VERSION) installed. Reload Cursor to activate."

clean:
	$(RM) -r out $(VSIX)
