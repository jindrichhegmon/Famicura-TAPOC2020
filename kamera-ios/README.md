# Famicura Kamera pro iPhone

Nativní aplikace (Capacitor) nad aplikací rodiny a mobilního dispečera na serveru Famicura
(`/proto/rodina.html`): obraz z kamery, soukromí, nahrávky, náramek, prsten. Aplikace je jen obal:
po startu přejde na server, přihlášení si pamatuje. Nový vzhled nebo funkce se do ní dostanou
nasazením serveru (`./deploy/vps-deploy.sh`), nová verze v App Storu není potřeba.

- Bundle ID `cz.famicura.kamera`, schéma odkazu `famicurakamera://otevrit?tenant=…&kamera=…`
  (aplikace PéčeDoma jím otevře Kameru místo webu; bez parametrů otevře poslední stav).
- Tlačítko „‹ PéčeDoma“ v hlavičce vede zpět do aplikace PéčeDoma (`pecedoma://`).
- Bez spojení se serverem ukáže úvodní stránka důvod a tlačítko Zkusit znovu.

## Co je potřeba (jednou)

Mac s Xcode (App Store) a Node.js (LTS); účet Apple Developer (Team ID z developer.apple.com →
Membership); pro TestFlight aplikace založená v App Store Connect (My Apps → + → název
„Famicura Kamera“, Bundle ID cz.famicura.kamera, SKU famicura-kamera).

## Postup

```bash
cd ~/Downloads/Famicura-TAPOC2020/kamera-ios 2>/dev/null || cd ~/Famicura-TAPOC2020/kamera-ios
./pripravit-ios.sh            # poprvé vytvoří projekt Xcode, nastaví název, ikonu a schéma, otevře Xcode
```

V Xcode: App → Signing & Capabilities → Team. Zkouška: iPhone kabelem, ▶ Run.
TestFlight jedním příkazem: `TEAM_ID=433U5VUWE2 ./vydat-testflight.sh` (nebo Product → Archive →
Distribute App → App Store Connect → Upload). Pak App Store Connect → TestFlight → testeři.

## Soubory

- `capacitor.config.json` – název, Bundle ID, povolená adresa serveru (allowNavigation).
- `www/index.html` – úvodní stránka: spojení se serverem, přechod na aplikaci rodiny, parametry z odkazu.
- `pripravit-ios.sh`, `vydat-testflight.sh` – příprava projektu a vydání; `ios/` a `vystup/` se generují, do gitu nepatří.
- `ikona-1024.png` – ikona (z `public/proto/ikony/famicura-512.png`).

## Grafika pro App Store (`appstore/`)

Volitelný banner stránky aplikace v App Storu (App Store Connect → verze → Product Page Information → Header /
Search Results): `header-5244x2950.png` a `search-3840x1646.png`, vygenerované z `ikona-1024.png` (modrý přechod
v barvách ikony, ikona vlevo od středu, bez textu – název přes banner doplňuje Apple). Pro TestFlight nejsou potřeba.

## Scene lifecycle (SDK iOS 27)

Sestavení z Xcode 27 musí používat UIScene, jinak aplikace na iOS 27 spadne při startu (Apple zamítne podle 2.1).
`pripravit-ios.sh` i `vydat-testflight.sh` proto volají `./scena-ios.sh ios/App`: doplní `SceneDelegate.swift`, zapojí ho do
projektu, do `Info.plist` dá `UIApplicationSceneManifest` a do `AppDelegate.swift` konfiguraci scény. Jde spouštět opakovaně.
