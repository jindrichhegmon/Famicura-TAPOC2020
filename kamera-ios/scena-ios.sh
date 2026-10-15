#!/usr/bin/env bash
# Scene lifecycle (UIScene) pro projekt Xcode z Capacitoru – od SDK iOS 27 (Xcode 27) povinné: aplikace bez něj spadne
# hned při startu na iOS 27 (pád UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption, Apple ji zamítne).
# Doplní SceneDelegate.swift, zapojí ho do projektu, do Info.plist dá UIApplicationSceneManifest (okno z Main.storyboard)
# a do AppDelegate konfiguraci scény. Jde spouštět opakovaně; volá ho pripravit-ios.sh i vydat-testflight.sh.
#   ./scena-ios.sh [ios/App]
set -euo pipefail
D="${1:-ios/App}"; APP="$D/App"; PBX="$D/App.xcodeproj/project.pbxproj"; P="$APP/Info.plist"; PB=/usr/libexec/PlistBuddy
[ -f "$APP/AppDelegate.swift" ] || { echo "Nenašel jsem $APP/AppDelegate.swift – nejdřív npx cap add ios."; exit 1; }
# 1) SceneDelegate.swift: okno i CAPBridgeViewController vytvoří UIKit z Main.storyboard; odkazy (URL schéma, Universal
#    Links), kterými byla aplikace spuštěná nebo oslovená, jdou Capacitoru stejně jako dřív přes ApplicationDelegateProxy
cat > "$APP/SceneDelegate.swift" <<'SWIFT'
import UIKit
import Capacitor

/* Scene lifecycle (UIScene): od SDK iOS 27 povinné – bez něj aplikace spadne při startu na iOS 27. Okno
 * a CAPBridgeViewController si UIKit vytvoří z Main.storyboard (UISceneStoryboardFile v Info.plist); tady se jen
 * předávají odkazy (URL schéma, Universal Links) Capacitoru stejně jako dřív v AppDelegate. Generuje scena-ios.sh. */
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard scene is UIWindowScene else { return }
        if let url = connectionOptions.urlContexts.first?.url {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
        }
        if let activity = connectionOptions.userActivities.first {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url else { return }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }
}
SWIFT
# 2) AppDelegate: konfigurace scény (jedna scéna „Default Configuration“)
if ! grep -q configurationForConnecting "$APP/AppDelegate.swift"; then
  node -e '
const fs = require("fs"); const f = process.argv[1]; let s = fs.readFileSync(f, "utf8");
const m = s.match(/func application\(_ application: UIApplication, didFinishLaunchingWithOptions[\s\S]*?\n    \}\n/);
if (!m) { console.error("AppDelegate.swift: nenašel jsem didFinishLaunchingWithOptions"); process.exit(1); }
const add = `
    // Scene lifecycle (povinné od SDK iOS 27): jedna scéna s oknem z Main.storyboard – SceneDelegate.swift, Info.plist (scena-ios.sh)
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }
`;
s = s.replace(m[0], m[0] + add); fs.writeFileSync(f, s);' "$APP/AppDelegate.swift"
fi
# 3) Info.plist: manifest scény místo UIMainStoryboardFile (storyboard načítá scéna)
$PB -c "Delete :UIMainStoryboardFile" "$P" >/dev/null 2>&1 || true
$PB -c "Delete :UIApplicationSceneManifest" "$P" >/dev/null 2>&1 || true
M=":UIApplicationSceneManifest"; R="$M:UISceneConfigurations:UIWindowSceneSessionRoleApplication"
$PB -c "Add $M dict" "$P"
$PB -c "Add $M:UIApplicationSupportsMultipleScenes bool false" "$P"
$PB -c "Add $M:UISceneConfigurations dict" "$P"
$PB -c "Add $R array" "$P"
$PB -c "Add $R:0 dict" "$P"
$PB -c "Add $R:0:UISceneConfigurationName string 'Default Configuration'" "$P"
$PB -c "Add $R:0:UISceneDelegateClassName string '\$(PRODUCT_MODULE_NAME).SceneDelegate'" "$P"
$PB -c "Add $R:0:UISceneStoryboardFile string Main" "$P"
# 4) projekt Xcode: SceneDelegate.swift vedle AppDelegate.swift (odkaz na soubor, skupina, fáze Sources)
if ! grep -q "SceneDelegate.swift" "$PBX"; then
  node -e '
const fs = require("fs"); const f = process.argv[1]; let s = fs.readFileSync(f, "utf8");
const bf = s.match(/^\t\t([0-9A-F]{24}) \/\* AppDelegate\.swift in Sources \*\/ = \{isa = PBXBuildFile; fileRef = ([0-9A-F]{24}) \/\* AppDelegate\.swift \*\/; \};$/m);
if (!bf) { console.error("project.pbxproj: nenašel jsem AppDelegate.swift"); process.exit(1); }
const BF = bf[1], FR = bf[2];
const id = (n) => { let h = "5C3E0A0" + n; while (h.length < 24) h += "B2D4E6F8A0C1D2E3".charAt(h.length % 16); return h.toUpperCase(); };
const NBF = id(1), NFR = id(2);
s = s.replace(bf[0], bf[0] + `\n\t\t${NBF} /* SceneDelegate.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${NFR} /* SceneDelegate.swift */; };`);
s = s.replace(new RegExp(`^(\\t\\t${FR} /\\* AppDelegate\\.swift \\*/ = \\{isa = PBXFileReference;[^\\n]*\\n)`, "m"), `$1\t\t${NFR} /* SceneDelegate.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = SceneDelegate.swift; sourceTree = "<group>"; };\n`);
s = s.replace(new RegExp(`^(\\t+${FR} /\\* AppDelegate\\.swift \\*/,\\n)`, "m"), `$1\t\t\t\t${NFR} /* SceneDelegate.swift */,\n`);
s = s.replace(new RegExp(`^(\\t+${BF} /\\* AppDelegate\\.swift in Sources \\*/,\\n)`, "m"), `$1\t\t\t\t${NBF} /* SceneDelegate.swift in Sources */,\n`);
if ((s.match(/SceneDelegate\.swift/g) || []).length !== 6) { console.error("project.pbxproj: úprava se nepovedla"); process.exit(1); }
fs.writeFileSync(f, s);' "$PBX"
fi
echo "   scene lifecycle: SceneDelegate.swift, UIApplicationSceneManifest v Info.plist, AppDelegate – hotovo"
