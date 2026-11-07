NAME := $(shell node -p "require('./package.json').name")
VERSION := $(shell node -p "require('./package.json').version")
VSIX := $(NAME)-$(VERSION).vsix

# Open-VSX token: read from ~/.config/env
OPEN_VSX_TOKEN := $(shell grep OPEN_VSX_TOKEN ~/.config/env | cut -d '=' -f 2)
.PHONY: build lint format pack clean install-ext

install-mitm:
	mkdir -p ~/.local/bin
	curl -sL https://downloads.mitmproxy.org/12.3.1/mitmproxy-12.3.1-linux-x86_64.tar.gz | tar -xz -C ~/.local/bin
	@echo "mitmproxy installed to ~/.local/bin"
	~/.local/bin/mitmdump --version

build:
	npm run build:production

lint:
	npm run lint

format:
	npm run format

pack: format lint build
	npm run package

install-ext: pack
	code --install-extension $(VSIX)

publish: pack
	@echo "Ready to publish $(NAME) version $(VERSION) to Open VSX."
	@echo -n "Proceed? [y/N] " && read ans && [ "$$ans" = "y" ]
	npx ovsx publish --pat $(OPEN_VSX_TOKEN)

clean:
	rm -rf dist node_modules *.vsix
