---
name: nasazeni-po-uprave
description: "Po každé úpravě kódu v některé z aplikací Jindřicha Hegmona (Famicura Tapo – kamera, Famicura Ring, a jakákoli další jeho aplikace s nasazením na VPS, Netlify nebo Windows server) připrav na konec odpovědi hotový blok příkazů k vložení do Terminálu na Macu: cd do složky projektu, git pull, nasazení na server, co skript bude chtít a co odpovědět, a jak ověřit, že to jede. Použij VŽDY, když jsi něco změnil, commitoval nebo pushnul v jeho repozitáři, i když o nasazení výslovně nežádá; dál když se ptá „jak to nasadím“, „co mám spustit“, „jsem v Downloads“, „git pull“, „deploy“, „nasazení“, „nahraj to na server“, „proč se změna neprojevila“, nebo když se má něco stáhnout na Windows server u kamery. Netýká se to úprav, které se nikam nenasazují (dokumenty, maily, analýzy dat)."
---

# Nasazení po úpravě

## Proč tenhle skill existuje

Jindřich není vývojář. Pracuje na dvou Macech (hlavní Mac a MacBook Air, uživatel
`jindrichhegmonAIR`), příkazy kopíruje do Terminálu a často stojí v úplně jiné
složce (typicky `~/Downloads`). Když po úpravě dostane jen „nasaďte to“, neví,
co spustit, kde, a co odpovídat na otázky skriptů. Každá odpověď, která končí
úpravou kódu, proto končí i hotovým blokem, který stačí vložit. Cíl: nula
přemýšlení na jeho straně, jedna zkopírovaná věc, jasná kontrola na konci.

## Kdy blok připravit

Vždy, když jsi v jeho repozitáři něco změnil a pushnul (nebo mu radíš, jak
změnu dostat na server). Také když se ptá na cestu, složku, `git pull`,
nasazení, nebo proč změnu na serveru nevidí. Když jsi změnu jen popsal a nic
nepushnul, blok nepřipravuj, ale řekni, že ho dostane po nahrání.

## Postup

1. **Zjisti, o kterou aplikaci jde** (podle repozitáře, ve kterém pracuješ) a
   otevři `references/aplikace.md`. Je tam pro každou aplikaci složka na Macu,
   kam se pushuje, co nasazení dělá, které skripty se kdy používají, co se ptají
   a jak se ověří výsledek. Aplikaci, která tam není, nejdřív doplň (viz níže).
2. **Rozhodni, co je po téhle změně potřeba.** Podívej se, které soubory se
   změnily (`git diff --stat` proti stavu před tvou prací):
   - jen obsah, který se nasazuje jedním skriptem → `git pull` + ten skript;
   - Ring: změna jen v `public/` nebo `netlify/` → Netlify nasadí sama po
     pushi na `main`, na Macu není co spouštět, jen počkat a ověřit;
   - nová proměnná prostředí, nová tabulka v SQL, nový skript pro server
     u kamery, změna v Caddy → přidej tyhle kroky **před** nasazení a ve
     správném pořadí, každý s tím, co se u něj bude zadávat;
   - Windows server u kamery: skript se tam nekopíruje, stáhne se z GitHubu
     příkazem `Invoke-WebRequest` (vzor v referenci) a spustí v PowerShellu
     jako správce.
3. **Napiš blok podle šablony níže.** Vždy začni řádkem `cd`, protože
   nevíš, kde v Terminálu stojí. Projekty má ve složce **Downloads**; na
   Airu byl jeden klon i přímo v domovské složce. Proto `cd` vždy zkusí obě
   místa v jednom řádku, bez úprav:
   `cd ~/Downloads/Famicura-TAPOC2020 2>/dev/null || cd ~/Famicura-TAPOC2020`
   **V bloku nikdy není nic k dosazení**: žádné `<IP>`, „dosaďte název
   složky“, „vaše heslo“. Když hodnotu neznáš, vezmi ji z reference, zjisti ji
   z repozitáře, nebo se zeptej dřív, než blok napíšeš. Blok, který musí
   upravit, je pro něj k ničemu.
4. **U každé otázky skriptu řekni, co odpovědět** (Enter = výchozí, „heslo
   účtu kamery“, „stejný klíč jako v Netlify“). Hesla nikdy do příkazu ani do
   chatu: skripty je čtou skrytě, to je záměr.
5. **Zakonči ověřením**: adresa, kterou otevřít, a co tam má být vidět
   (nový prvek, „Diagnostika: odpovídá“, `/api/health`), včetně obnovení
   stránky (Cmd+R) a případného odhlášení/přihlášení, když se měnilo přihlášení.

## Šablona bloku (na konci odpovědi, česky)

```
**Nasazení** (Terminál na Macu, kdekoli stojíte):

cd ~/Downloads/Famicura-TAPOC2020 2>/dev/null || cd ~/Famicura-TAPOC2020
git pull
./deploy/vps-deploy.sh

Skript se na nic neptá; na konci vypíše adresu. Pak v prohlížeči obnovte
stránku (Cmd+R) a zkontrolujte <co>.
```

Když je kroků víc, očísluj je a u každého jednou větou řekni, co dělá a co
bude chtít. Když je krok na jiném stroji (Windows server, telefon s aplikací
Tapo, Netlify), řekni to hned v nadpisu kroku. Nepiš víc příkazů, než je pro
tuhle změnu nutné: `vps-env.sh`, `vps-kamera.sh` nebo `wireguard-vps.sh`
patří do bloku jen tehdy, když se změna bez nich neprojeví.

## Když něco selže

Pod blok dej nejvýš dvě záchrany, které jsou u téhle změny nejpravděpodobnější,
každou na jeden řádek. Celý seznam níže do odpovědi nepatří; je pro tebe,
abys věděl, co poradit, až se něco pokazí:

- `git pull` hlásí místní změny → `git stash` a znovu `git pull` (jeho
  změny to uloží stranou, nic nesmaže).
- „No such file or directory“ u `cd` → projekt na tomhle Macu není; dej mu
  `git clone` do `~/Downloads` (příkaz je v referenci) a blok znovu.
- Skript hlásí `Permission denied (publickey)` → na tomhle Macu chybí klíč
  `~/.ssh/id_ed25519_jhnapps`; kopíruje se z druhého Macu, nikdy ne přes chat.
- Změna na webu není vidět → obnovit stránku bez keše (Cmd+Shift+R); u Netlify
  počkat 1–2 minuty na build.

## Nová aplikace nebo změna nasazení

Když pracuješ v repozitáři, který v `references/aplikace.md` chybí, nebo jsi
přidal či přejmenoval skript nasazení, referenci hned doplň: podívej se do
`deploy/`, `netlify.toml`, `package.json` (`scripts`) a do README na část
o nasazení, a zapiš stejné položky, jaké mají ostatní aplikace. Pokud složka
skillu není zapisovatelná, vypiš nový záznam v odpovědi a požádej Jindřicha,
aby si skill nechal aktualizovat. Bez záznamu bys příště hádal složku i
příkazy a to je přesně to, co má tenhle skill odstranit.

## Bezpečnost (platí pro všechny jeho aplikace)

- Hesla, klíče a tokeny nikdy na příkazovou řádku, do gitu ani do chatu.
  Skripty je čtou přes `read -rs` nebo je berou ze serveru.
- `.env`, `cameras.json`, `go2rtc.yaml`, `bin/`, `data/` a soubory
  `*.conf` s klíči WireGuard se nikdy necommitují; po instalaci se konfigurace
  s klíčem maže.
- Nasazuje se jen to, co prošlo testy (`npm test` v repozitáři, kde jsou).
