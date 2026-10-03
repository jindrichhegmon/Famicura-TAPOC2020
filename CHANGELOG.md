# Změny Famicura Kamera

Verze je na jednom místě v `public/verze.js` a ukazuje se v hlavičce všech
aplikací (hlavní aplikace, rodina, dispečink, provoz, přihlášení). Stejné
číslo nese značka v gitu (`git tag`) a téma „Co je nové“ v nápovědě
dispečinku. Postup nové verze je v README, část „Verze“.

## 1.0 · 3. 10. 2026

První označená verze. Obsahuje:

- Hlavní aplikace: obraz z kamery Tapo přes go2rtc (WebRTC, náhradně HTTPS),
  nahrávky, plány, události kamery (ONVIF) se zápisem do CLB1, diagnostika,
  tunel WireGuard k bráně GL.iNet Mango (nebo Windows server / tunel SSH).
- Aplikace rodiny (telefon, na plochu): účty s pozvánkou SMS, karta Přístup
  poskytovatele (co poskytovatel vidí teď, rychlé přepnutí Ostrý / Rozmazaný /
  Drátěný model, nastavení podle denní doby s časy, nouzový přístup), Klid,
  žádost o plný obraz přes celou obrazovku se zvukem, historie.
- Dispečink poskytovatele (jen po přihlášení): dlaždice v režimu, který rodina
  povolila, fronta alertů s převzetím a uzavřením, eskalace podle nastavení,
  žádost o plný obraz (rodině odejde SMS), nouzový přístup, sledování
  a nahrávání, účty rodiny, poznámky dispečinku ke kameře, trvalá poznámka
  ke klientovi, nastavení pod ozubeným kolečkem, nápověda s obrázky obrazovek
  a asistent (z nápovědy, volitelně AI přes Make), přepínač Jen skutečné / Demo.
- Provoz: flotila míst, provozní alarmy, diagnostika skutečné kamery.
- Stav prototypu sdílený přes server mezi všemi zařízeními.
- Dokumentace: README, návody ve Wordu, prodejní prezentace a scénář videa
  v `docs/prezentace/`.
