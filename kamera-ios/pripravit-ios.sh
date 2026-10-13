#!/usr/bin/env bash
# Příprava aplikace Famicura Kamera pro iPhone (Capacitor) – spouštět na Macu ve složce kamera-ios:
#   ./pripravit-ios.sh
# Poprvé vytvoří projekt Xcode (ios/), nastaví název, ikonu a schéma odkazu famicurakamera:// a otevře Xcode;
# při dalším spuštění jen obnoví projekt a otevře Xcode. Aplikace je obal nad aplikací rodiny na serveru Famicura:
# nový vzhled nebo funkce rodiny se do ní dostanou nasazením serveru, nová verze v App Storu není potřeba.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Chybí Node.js – nainstalujte z https://nodejs.org (LTS) a spusťte znovu."; exit 1; }
command -v xcodebuild >/dev/null || { echo "Chybí Xcode – nainstalujte z App Storu, jednou ho spusťte (souhlas s licencí) a spusťte znovu."; exit 1; }
xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1 || sudo xcodebuild -runFirstLaunch
echo "== 1/4 Balíčky (Capacitor)"
npm install --no-audit --no-fund 2>&1 | tail -1
echo "== 2/4 Projekt Xcode"
if [ ! -d ios/App ]; then npx cap add ios; fi
P=ios/App/App/Info.plist
PB=/usr/libexec/PlistBuddy
pridej() { $PB -c "Print :$1" "$P" >/dev/null 2>&1 && $PB -c "Set :$1 $3" "$P" || $PB -c "Add :$1 $2 $3" "$P"; }
$PB -c "Set :CFBundleDisplayName 'Famicura Kamera'" "$P"
pridej ITSAppUsesNonExemptEncryption bool false          # šifrování jen HTTPS: App Store Connect se neptá na export
# schéma odkazu famicurakamera:// – aplikace PéčeDoma jím otevře Kameru místo webu
$PB -c "Delete :CFBundleURLTypes" "$P" >/dev/null 2>&1 || true
$PB -c "Add :CFBundleURLTypes array" "$P"
$PB -c "Add :CFBundleURLTypes:0 dict" "$P"
$PB -c "Add :CFBundleURLTypes:0:CFBundleURLName string cz.famicura.kamera" "$P"
$PB -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$P"
$PB -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string famicurakamera" "$P"
# tlačítko „‹ PéčeDoma“ v hlavičce otevírá pecedoma:// – iOS chce schémata, na která se aplikace ptá, vyjmenovat
$PB -c "Delete :LSApplicationQueriesSchemes" "$P" >/dev/null 2>&1 || true
$PB -c "Add :LSApplicationQueriesSchemes array" "$P"
$PB -c "Add :LSApplicationQueriesSchemes:0 string pecedoma" "$P"
# jen na výšku (jako web), ikona z ikona-1024.png
$PB -c "Delete :UISupportedInterfaceOrientations" "$P" >/dev/null 2>&1 || true
$PB -c "Add :UISupportedInterfaceOrientations array" "$P"; $PB -c "Add :UISupportedInterfaceOrientations:0 string UIInterfaceOrientationPortrait" "$P"
cp ikona-1024.png ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
echo "== 3/4 Přenos úvodní stránky do aplikace"
npx cap sync ios
echo "== 4/4 Otevírám Xcode"
echo "V Xcode: vlevo klepněte na App → Signing & Capabilities → Team = váš účet Apple Developer (Bundle Identifier cz.famicura.kamera)."
echo "Zkouška na vlastním iPhonu: iPhone připojte kabelem, nahoře vyberte jako cíl a stiskněte ▶ (Run)."
echo "TestFlight: ./vydat-testflight.sh, nebo Product → Archive → Distribute App → App Store Connect (viz README.md)."
npx cap open ios
