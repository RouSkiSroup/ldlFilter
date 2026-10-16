# Lidl Product Filter 🛒

Uživatelský skript (Tampermonkey / Greasemonkey) pro **Lidl.cz** a **Lidl.sk**, který umožňuje bleskurychle filtrovat a přednačítat produkty podle kombinace **textu** (názvu, značky), **přítomnosti akumulátoru v balení** (pouze nářadí bez baterií / sady), **velikosti slevy v %** a **cenového rozpětí**, s pokročilým řazením a hromadným načítáním stránek.

Inspirováno a navrženo na základě [productFilter pro Alzu](https://github.com/RouSkiSroup/productFilter).

---

## ⚡ Hlavní funkce

- 🔍 **Kombinované filtrování:**
  - **Textové vyhledávání:** Okamžité filtrování při psaní (bez diakritiky, podpora více slov např. `aku vrtacka 20v` nebo `parkside performance`).
  - **Filtr akumulátoru (Nářadí bez baterie):**
    - `Vše`: nerozhoduje (zobrazí všechny produkty).
    - `🚫 Bez baterie`: vybere **pouze nářadí bez akumulátoru a nabíječky** (*body only* / *– bez akumulátoru a nabíječky*), odfiltruje sady s bateriemi a samostatné nabíječky/akumulátory. Ideální pro ty, kteří už baterie mají doma!
    - `🔋 S baterií`: vybere sady nářadí, kde je akumulátor přímo součástí balení.
  - **Minimální sleva:** Presety `Vše` (i bez slevy), `> 0 %` (jakákoliv sleva), `≥ 10 %`, `≥ 20 %`, `≥ 30 %`, `≥ 40 %`, `≥ 50 %`, `≥ 60 %`.
  - **Kombinace filtrů:** Lze filtrovat např. *vrtačka* + *bez baterie* + *sleva nad 30 %*, nebo jen *bez baterie* + *sleva nad 50 %*.
  - **Cenové rozpětí:** Volitelný filtr pro minimální a maximální cenu (Kč).
- 🚀 **Bleskurychlé hromadné načítání (Preloading):**
  - **1 dávka:** Tlačítko pro načtení další dávky 48 produktů nebo stisknutí klávesy **`Ctrl`**.
  - **Hromadné načítání:** Zadejte počet dávek (např. 5, 10, 20) nebo `0` pro načtení celého katalogu.
  - Skript reaguje přímo na změny DOMu bez zbytečných prodlev – načítá maximální možnou rychlostí, kterou server Lidlu dovolí.
  - Tlačítko **⏹ Zastavit** pro okamžité přerušení.
- ⚖ **Pokročilé řazení:**
  - Výchozí pořadí
  - Od nejlevnějšího
  - Od nejdražšího
  - **Největší sleva v %** (od nejvyšší slevy dolů)
  - **Největší úspora v Kč** (od největší absolutní úspory dolů)
- ↕ **Auto-scroll:**
  - Automatické udržování pozice (vypnuto / začátek seznamu / poslední načtený produkt).
- 🎨 **Moderní tmavé rozhraní (Glassmorphism):**
  - Minimalizovatelná plovoucí bublina `🔍` s odznakem počtu zobrazených produktů.
  - Přesouvatelný panel (drag & drop za záhlaví).
  - Přehledné počítadlo nalezených výsledků (např. `Zobrazeno 14 z 480 načtených (z celkem 3 670)`).
  - Trvalé ukládání vašeho nastavení do `localStorage`.
- 🔄 **Automatická kontrola aktualizací.**

---

## 📥 Instalace

1. Nainstalujte si rozšíření do prohlížeče:
   - [Tampermonkey](https://www.tampermonkey.net/) (doporučeno pro Chrome, Edge, Firefox, Brave, Safari)
2. Klikněte na odkaz pro instalaci skriptu:
   - 👉 **[Instalovat lidl-filter.user.js](https://raw.githubusercontent.com/RouSkiSroup/ldlFilter/main/lidl-filter.user.js)**
3. V okně Tampermonkey klikněte na **Instalovat** (Install).
4. Otevřete libovolnou stránku s produkty na Lidlu, například:
   - **[Lidl Slevy](https://www.lidl.cz/q/query/slevy)**
   - **[Lidl Hledání Parkside](https://www.lidl.cz/q/search?q=parkside)**
   - Nebo libovolnou kategorii na `lidl.cz` / `lidl.sk`.

---

## 🛠 Jak funguje detekce "bez baterie"

Lidl má u nářadí Parkside a dalších značek velmi striktní a systematické značení:
1. **Verze bez baterie:** v názvu mívají `– bez akumulátoru a nabíječky` / `(bez akumulátoru)` a v popisu `Akumulátor a nabíječka nejsou součástí balení` či `Doporučený akumulátor: 20 V`.
2. **Sady s baterií:** v názvu mají kapacitu, např. `, Smart 8 Ah`, `, 2 Ah`, `, 2x 4 Ah` a v popisu rozpis `Složení sady: 1x ... akumulátor ...`.
3. **Samostatné akumulátory/nabíječky:** skript je identifikuje a v režimu `🚫 Bez baterie` vyřazuje, takže vidíte pouze samotné stroje a nářadí.

Všechna tato data skript extrahuje z atributu `data-grid-data` a cachuje v paměti (`WeakMap`), takže filtrování funguje za méně než **1 milisekundu**.

---

## 🚀 Jak skript zvládá tisíce produktů bez sekání prohlížeče

Lidl na svých stránkách ve výchozím stavu používá komponentu `SNBBatchRenderComponent` s `IntersectionObserverem`, která jakoukoliv dávku produktů (48 položek) po odrolování o více než 1040 px nahoru **kompletně smaže z DOMu** a nahradí ji prázdným komentářem `<!---->`. Kvůli tomu:
- Nebylo možné v odrolovaných produktech vyhledávat textem.
- Načítání se předčasně zastavovalo, protože počet produktů v DOMu kvůli mazání nerostl.

**Řešení ve verzi 1.3.0:**
1. **Zachování všech produktů v paměti DOM:** Skript zachytí `IntersectionObserver` tak, aby Lidl dávky neodstraňoval. Všechny načtené produkty zůstávají dostupné pro okamžité filtrování textem, slevou i cenou.
2. **Hardwarová C++ akcelerace (`content-visibility: auto`):** Aby se prohlížeč nezahltil a nesekal při tisících položek, skript aplikuje nativní CSS vlastnost `content-visibility: auto` s `contain-intrinsic-size`. Jádro prohlížeče (Blink/WebKit) tak kompletně přeskakuje layout a vykreslování položek mimo obrazovku, což zajišťuje hladké posouvání (60/120 FPS) s minimální spotřebou RAM a procesoru.

---

## 📝 Licence

MIT License.
