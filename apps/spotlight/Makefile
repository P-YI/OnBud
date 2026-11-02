# OpenAFM launcher (apps/spotlight) — builds with the Command Line Tools only (swift build + iconutil, no Xcode project).
#   make app      build/Products.noindex/OpenAFM.app (release, ad-hoc signed, with icon; .noindex keeps
#                 development builds out of Spotlight, so only the installed app shows up there)
#   make install  make app, then copy it to /Applications (replacing an older copy) and register that one
#   make smoke    core checks + live requests through the running controller
#   make run      build the app and open it with the panel shown
#   make dmg      build/OpenAFM-<version>.dmg (the app + an Applications link) for GitHub Releases
#   make release  the DMG, its sha256 and a filled-in Homebrew cask (scripts/release.sh)
#   make clean

ICON_SRC ?= Resources/Artwork/AppLogo.png
MENUBAR_SRC ?= Resources/Artwork/MenuBarLogo.png
APP      := build/Products.noindex/OpenAFM.app
WIDGET   := $(APP)/Contents/PlugIns/OpenAFMWidget.appex
REPO     := $(abspath ../..)
CONFIG   ?= release
BIN       = $(shell swift build -c $(CONFIG) --show-bin-path)
VERSION  := $(shell plutil -extract CFBundleShortVersionString raw Resources/Info.plist)
DMG      := build/OpenAFM-$(VERSION).dmg
# The controller the app copies to ~/OpenAFM/adaptive-coding-agent on setup (no git checkout needed).
# Tests, docs and benchmarks stay in the repository.
BACKEND_FILES := bin services policies scripts opencode tools/pdftext tools/translate package.json README.md LICENSE THIRD_PARTY_NOTICES.md

.PHONY: app smoke run clean icon dmg release install

app: icon
	swift build -c $(CONFIG) --product AFMSpotlight
	rm -rf "$(APP)" build/OpenAFM.app build/dmg
	mkdir -p "$(APP)/Contents/MacOS" "$(APP)/Contents/Resources"
	cp "$(BIN)/AFMSpotlight" "$(APP)/Contents/MacOS/AFMSpotlight"
	cp Resources/Info.plist "$(APP)/Contents/Info.plist"
	cp build/AppIcon.icns "$(APP)/Contents/Resources/AppIcon.icns"
	cp build/icons/MenuBar.png build/icons/MenuBar@2x.png build/icons/MenuBarColor.png build/icons/MenuBarColor@2x.png build/icons/PanelIcon.png "$(APP)/Contents/Resources/"
	mkdir -p "$(APP)/Contents/Resources/backend"
	cd "$(REPO)" && rsync -a --relative $(BACKEND_FILES) "$(abspath $(APP))/Contents/Resources/backend/"
	echo "$(VERSION) $$(git -C "$(REPO)" rev-parse --short HEAD 2>/dev/null)" > "$(APP)/Contents/Resources/backend/.openafm-bundled"
	cp "$(REPO)/LICENSE" "$(REPO)/THIRD_PARTY_NOTICES.md" "$(APP)/Contents/Resources/"
	# pdftext (PDF text + Vision OCR) is OpenAFM's own helper on system frameworks only, so it ships inside the app.
	swiftc -O -o "$(APP)/Contents/MacOS/pdftext" "$(REPO)/tools/pdftext/main.swift" -framework PDFKit -framework Vision -framework AppKit
	# Chat widget: a WidgetKit extension (sandboxed; reads only the app's snapshot folder).
	mkdir -p "$(WIDGET)/Contents/MacOS" "$(WIDGET)/Contents/Resources"
	swiftc -O -parse-as-library -application-extension -module-name OpenAFMWidget \
	  -target $(shell uname -m)-apple-macos15.0 \
	  -o "$(WIDGET)/Contents/MacOS/OpenAFMWidget" Widget/ChatWidget.swift Sources/SpotlightCore/WidgetSnapshot.swift \
	  -framework WidgetKit -framework SwiftUI
	cp Widget/Info.plist "$(WIDGET)/Contents/Info.plist"
	cp build/icons/PanelIcon.png "$(WIDGET)/Contents/Resources/"
	plutil -lint "$(APP)/Contents/Info.plist" "$(WIDGET)/Contents/Info.plist"
	# Ad-hoc signatures (inside out) so SMAppService, WidgetKit and Gatekeeper see a consistent bundle (not notarized).
	codesign --force --sign - --timestamp=none "$(APP)/Contents/MacOS/pdftext"
	codesign --force --sign - --timestamp=none --entitlements Widget/Widget.entitlements "$(WIDGET)"
	codesign --force --sign - --timestamp=none "$(APP)"
	# Refresh Finder/Dock's icon cache and the Services menu for this bundle path.
	touch "$(APP)"
	# (Skipped once OpenAFM is installed in /Applications: that copy keeps the URL scheme, Services and widget.)
	if [ ! -d /Applications/OpenAFM.app ]; then \
	  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$(APP)"; \
	  pluginkit -a "$(WIDGET)" 2>/dev/null || true; \
	fi
	@echo "Built $(APP)"

# White-background .icns and panel logo from OpenAFM_Icon2.2, menu-bar silhouette (black) and color logo from OpenAFM_Icon3
# (scripts/make-icons.swift uses Core Image; sips + iconutil make the iconset).
icon: build/AppIcon.icns

build/icons/AppIcon-1024.png: $(ICON_SRC) $(MENUBAR_SRC) scripts/make-icons.swift
	@test -f "$(ICON_SRC)" -a -f "$(MENUBAR_SRC)" || { echo "missing $(ICON_SRC) or $(MENUBAR_SRC)"; exit 1; }
	mkdir -p build/icons
	swift scripts/make-icons.swift "$(ICON_SRC)" "$(MENUBAR_SRC)" build/icons

build/AppIcon.icns: build/icons/AppIcon-1024.png
	rm -rf build/AppIcon.iconset && mkdir -p build/AppIcon.iconset
	for s in 16 32 128 256 512; do \
	  sips -z $$s $$s build/icons/AppIcon-1024.png --out build/AppIcon.iconset/icon_$${s}x$${s}.png >/dev/null; \
	  d=$$((s * 2)); sips -z $$d $$d build/icons/AppIcon-1024.png --out build/AppIcon.iconset/icon_$${s}x$${s}@2x.png >/dev/null; \
	done
	iconutil -c icns build/AppIcon.iconset -o build/AppIcon.icns

smoke:
	swift build -c $(CONFIG) --product spotlight-smoke
	"$(BIN)/spotlight-smoke" $(SMOKE_ARGS)

dmg: app
	rm -rf build/dmg.noindex "$(DMG)" && mkdir -p build/dmg.noindex
	cp -R "$(APP)" build/dmg.noindex/ && ln -s /Applications build/dmg.noindex/Applications
	cp "$(REPO)/LICENSE" build/dmg.noindex/LICENSE.txt
	hdiutil create -volname "OpenAFM $(VERSION)" -srcfolder build/dmg.noindex -fs HFS+ -format UDZO -ov "$(DMG)"
	rm -rf build/dmg.noindex   # a second OpenAFM.app would otherwise show up in Spotlight and Launchpad
	@shasum -a 256 "$(DMG)"

LSREGISTER := /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
install: app
	-osascript -e 'quit app "OpenAFM"' 2>/dev/null; sleep 1
	rm -rf /Applications/OpenAFM.app && cp -R "$(APP)" /Applications/OpenAFM.app
	# Only the installed copy stays registered (URL scheme, Services menu, widget).
	-$(LSREGISTER) -u "$(APP)"
	-pluginkit -r "$(WIDGET)" 2>/dev/null
	$(LSREGISTER) -f /Applications/OpenAFM.app
	-pluginkit -a /Applications/OpenAFM.app/Contents/PlugIns/OpenAFMWidget.appex 2>/dev/null
	open /Applications/OpenAFM.app
	@echo "Installed /Applications/OpenAFM.app. If Launch at login was on for the build copy, turn it off and on again in Settings."

release:
	scripts/release.sh

run: app
	open "$(APP)" --args --show

clean:
	rm -rf build .build
