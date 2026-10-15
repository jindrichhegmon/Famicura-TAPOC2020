#!/usr/bin/env bash
# Vydání aplikace Famicura Kamera pro iPhone do TestFlightu (App Store Connect) jedním příkazem: přenese web do aplikace,
# sestaví archiv s novým číslem sestavení a nahraje ho na App Store Connect. Spouštět na Macu ve složce repozitáře:
#   TEAM_ID=XXXXXXXXXX ./vydat-testflight.sh
# Potřeba jednou: Xcode s přihlášeným Apple ID vývojáře (Xcode → Settings → Accounts), aplikace založená v App Store
# Connect (Famicura Kamera, cz.famicura.kamera). Po nahrání Apple sestavení zpracuje (e-mail do ~15 min) a v App Store Connect →
# TestFlight se objeví jako nový build; testerům se nabídne sám (interní skupina) nebo po přidání do externí skupiny.
set -euo pipefail
cd "$(dirname "$0")"
[ -f team.txt ] && TEAM_ID="${TEAM_ID:-$(cat team.txt)}" || true
[ -n "${TEAM_ID:-}" ] || { echo "Zadejte Team ID: TEAM_ID=XXXXXXXXXX ./vydat-testflight.sh"; exit 1; }
echo "$TEAM_ID" > team.txt
command -v xcodebuild >/dev/null || { echo "Chybí Xcode – nainstalujte z App Storu, jednou ho spusťte a spusťte znovu."; exit 1; }
VERZE=$(node -p "require('./package.json').version")
SESTAVENI=$(date +%Y%m%d%H%M)   # číslo sestavení musí být pokaždé vyšší; čas to zaručí (Build 1 byl ručně z Xcode)
[ -d ios/App ] || ./pripravit-ios.sh
./scena-ios.sh ios/App >/dev/null   # scene lifecycle (SDK iOS 27)
OUT=vystup; rm -rf "$OUT"; mkdir -p "$OUT"
npm install --no-audit --no-fund >/dev/null
echo "== 1/3 Přenos webu do aplikace (v$VERZE, sestavení $SESTAVENI)"; npx cap sync ios >/dev/null
if [ -f ios/App/App.xcworkspace/contents.xcworkspacedata ]; then PROJ=(-workspace ios/App/App.xcworkspace); else PROJ=(-project ios/App/App.xcodeproj); fi
echo "== 2/3 Sestavení (archiv)"
xcodebuild "${PROJ[@]}" -scheme App -configuration Release -destination 'generic/platform=iOS' -archivePath "$OUT/App.xcarchive" \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM_ID" MARKETING_VERSION="$VERZE" CURRENT_PROJECT_VERSION="$SESTAVENI" archive -quiet
echo "== 3/3 Nahrání na App Store Connect (TestFlight)"
export_options() {   # $1 = metoda (app-store-connect od Xcode 15, starší Xcode zná app-store)
cat > "$OUT/ExportOptions-testflight.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>method</key><string>$1</string>
	<key>teamID</key><string>$TEAM_ID</string>
	<key>signingStyle</key><string>automatic</string>
	<key>destination</key><string>upload</string>
	<key>uploadSymbols</key><true/>
	<key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST
}
export_options app-store-connect
if ! xcodebuild -exportArchive -archivePath "$OUT/App.xcarchive" -exportOptionsPlist "$OUT/ExportOptions-testflight.plist" -exportPath "$OUT/testflight" -allowProvisioningUpdates -quiet; then
  echo "   (metoda app-store-connect neprošla – zkouším app-store pro starší Xcode)"
  export_options app-store
  xcodebuild -exportArchive -archivePath "$OUT/App.xcarchive" -exportOptionsPlist "$OUT/ExportOptions-testflight.plist" -exportPath "$OUT/testflight" -allowProvisioningUpdates -quiet
fi
echo
echo "Hotovo: Famicura Kamera $VERZE ($SESTAVENI) je nahraná. Až přijde e-mail od Apple „completed processing“, je v App Store Connect → TestFlight;"
echo "testeři s aplikací TestFlight dostanou nabídku aktualizace sami. Kdyby nahrání selhalo na přihlášení: Xcode → Settings → Accounts → přidat Apple ID."
