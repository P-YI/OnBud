# OnBud launcher (apps/spotlight) — builds with the Command Line Tools only (swift build + iconutil, no Xcode project).
#   make app      build/Products.noindex/OnBud.app (release, ad-hoc signed, with icon; .noindex keeps
#                 development builds out of Spotlight, so only the installed app shows up there)
#   make install  make app, then copy it to /Applications (replacing an older copy) and register that one
#   make smoke    core checks + live requests through the running controller
#   make run      build the app and open it with the panel shown
#   make dmg      build/OnBud-<version>.dmg (the app + an Applications link) for GitHub Releases
#   make release  the DMG, its sha256 and a filled-in Homebrew cask (scripts/release.sh)
#   make clean

ICON_SRC ?= Resources/Artwork/AppLogo.png
MENUBAR_SRC ?= Resources/Artwork/MenuBarLogo.png
APP      := build/Products.noindex/OnBud.app
WIDGET   := $(APP)/Contents/PlugIns/OnBudWidget.appex
REPO     := $(abspath ../..)
CONFIG   ?= release
BIN       = $(shell swift build -c $(CONFIG) --show-bin-path)
VERSION  := $(shell plutil -extract CFBundleShortVersionString raw Resources/Info.plist)
DMG      := build/OnBud-$(VERSION).dmg
# The controller the app copies to ~/OnBud/adaptive-coding-agent on setup (no git checkout needed).
# Tests, docs and benchmarks stay in the repository.
BACKEND_FILES := bin services policies scripts opencode skills tools/pdftext tools/pdftool tools/pim tools/translate package.json README.md LICENSE THIRD_PARTY_NOTICES.md

.PHONY: app smoke run clean icon dmg release install

app: icon
	swift build -c $(CONFIG) --product AFMSpotlight
	rm -rf "$(APP)" build/OnBud.app build/dmg
	mkdir -p "$(APP)/Contents/MacOS" "$(APP)/Contents/Resources"
	cp "$(BIN)/AFMSpotlight" "$(APP)/Contents/MacOS/AFMSpotlight"
	cp Resources/Info.plist "$(APP)/Contents/Info.plist"
	cp build/AppIcon.icns "$(APP)/Contents/Resources/AppIcon.icns"
	cp build/icons/MenuBar.png build/icons/MenuBar@2x.png build/icons/MenuBarColor.png build/icons/MenuBarColor@2x.png build/icons/PanelIcon.png "$(APP)/Contents/Resources/"
	mkdir -p "$(APP)/Contents/Resources/backend"
	cd "$(REPO)" && rsync -a --relative $(BACKEND_FILES) "$(abspath $(APP))/Contents/Resources/backend/"
	echo "$(VERSION) $$(git -C "$(REPO)" rev-parse --short HEAD 2>/dev/null)" > "$(APP)/Contents/Resources/backend/.onbud-bundled"
	cp "$(REPO)/LICENSE" "$(REPO)/THIRD_PARTY_NOTICES.md" "$(APP)/Contents/Resources/"
	# pdftext (PDF text + Vision OCR) is OnBud's own helper on system frameworks only, so it ships inside the app.
	swiftc -O -o "$(APP)/Contents/MacOS/pdftext" "$(REPO)/tools/pdftext/main.swift" -framework PDFKit -framework Vision -framework AppKit
	# Chat widget: a WidgetKit extension (sandboxed; reads only the app's snapshot folder).
	mkdir -p "$(WIDGET)/Contents/MacOS" "$(WIDGET)/Contents/Resources"
	swiftc -O -parse-as-library -application-extension -module-name OnBudWidget \
	  -target $(shell uname -m)-apple-macos15.0 \
	  -o "$(WIDGET)/Contents/MacOS/OnBudWidget" Widget/ChatWidget.swift Sources/SpotlightCore/WidgetSnapshot.swift \
	  -framework WidgetKit -framework SwiftUI -framework Foundation \
	  -Xlinker -e -Xlinker _NSExtensionMain   # like Xcode's app-extension target: Foundation's entry sets up the
	                                          # extension runtime, then runs the @main WidgetBundle (__swift5_entry)
	cp Widget/Info.plist "$(WIDGET)/Contents/Info.plist"
	cp build/icons/PanelIcon.png "$(WIDGET)/Contents/Resources/"
	plutil -lint "$(APP)/Contents/Info.plist" "$(WIDGET)/Contents/Info.plist"
	# Ad-hoc signatures (inside out) so SMAppService, WidgetKit and Gatekeeper see a consistent bundle (not notarized).
	codesign --force --sign - --timestamp=none "$(APP)/Contents/MacOS/pdftext"
	codesign --force --sign - --timestamp=none --entitlements Widget/Widget.entitlements "$(WIDGET)"
	codesign --force --sign - --timestamp=none "$(APP)"
	# Refresh Finder/Dock's icon cache and the Services menu for this bundle path.
	touch "$(APP)"
	# (Skipped once OnBud is installed in /Applications: that copy keeps the URL scheme, Services and widget.)
	if [ ! -d /Applications/OnBud.app ]; then \
	  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$(APP)"; \
	  pluginkit -a "$(WIDGET)" 2>/dev/null || true; \
	fi
	@echo "Built $(APP)"

# Light-blue .icns and panel logo from AppLogo.png (OnBud_Icon3), menu-bar silhouette (black) and color logo from
# MenuBarLogo.png (OnBud_Icon2); both in Resources/Artwork
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
	hdiutil create -volname "OnBud $(VERSION)" -srcfolder build/dmg.noindex -fs HFS+ -format UDZO -ov "$(DMG)"
	rm -rf build/dmg.noindex   # a second OnBud.app would otherwise show up in Spotlight and Launchpad
	@shasum -a 256 "$(DMG)"

LSREGISTER := /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
install: app
	-osascript -e 'quit app "OnBud"' 2>/dev/null; sleep 1
	rm -rf /Applications/OnBud.app && cp -R "$(APP)" /Applications/OnBud.app
	# Only the installed copy stays registered (URL scheme, Services menu, widget).
	-$(LSREGISTER) -u "$(APP)"
	-pluginkit -r "$(WIDGET)" 2>/dev/null
	$(LSREGISTER) -f /Applications/OnBud.app
	-pluginkit -a /Applications/OnBud.app/Contents/PlugIns/OnBudWidget.appex 2>/dev/null
	open /Applications/OnBud.app
	@echo "Installed /Applications/OnBud.app. If Launch at login was on for the build copy, turn it off and on again in Settings."

release:
	scripts/release.sh

run: app
	open "$(APP)" --args --show

clean:
	rm -rf build .build
