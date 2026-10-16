// ==UserScript==
// @name         Lidl Product Filter
// @namespace    http://tampermonkey.net/
// @version      1.3.3
// @description  Filtrování produktů na Lidl.cz podle textu, slevy a přítomnosti akumulátoru (bez baterie / se sadou), efektivní dávkové přednačítání a řazení
// @author       Filip J. & Tomi
// @match        https://www.lidl.cz/*
// @match        https://www.lidl.sk/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @updateURL    https://raw.githubusercontent.com/RouSkiSroup/ldlFilter/main/lidl-filter.user.js
// @downloadURL  https://raw.githubusercontent.com/RouSkiSroup/ldlFilter/main/lidl-filter.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ─── Prevence unmountování dávek Lidlem ────────────────────────────────────
    // Lidl ve Vue komponentě SNBBatchRenderComponent používá IntersectionObserver s rootMargin "1040px 0px 1040px 0px".
    // Když se dávka odroluje nahoru, Vue komponenta ji kompletně odmountuje z DOMu (nahradí prázdným komentářem <!---->).
    // Tím v DOMu zůstávalo vždy jen cca 20 dávek (~1008 produktů) a zbytek katalogu nebyl v DOMu dostupný.
    // Aby zůstaly v DOMu VŠECHNY produkty pro textové i slevové filtrování a vyhledávání:
    // 1. Injektujeme kód přímo do hlavního JavaScript kontextu stránky (Main World) pomocí <script> elementu.
    // 2. Přepíšeme IntersectionObserverEntry.prototype.isIntersecting getter, aby pro .s-product-batch vracel vždy true.
    // 3. Obalíme window.IntersectionObserver konstruktor pro zaručení isIntersecting: true.
    // 4. O plynulost renderingu 3000+ prvků se stará CSS content-visibility: auto (HW akcelerace jádrem prohlížeče).

    const patchCode = `(function() {
        if (window.__lf_io_patched) return;
        window.__lf_io_patched = true;

        try {
            if (typeof IntersectionObserverEntry !== 'undefined' && IntersectionObserverEntry.prototype) {
                const desc = Object.getOwnPropertyDescriptor(IntersectionObserverEntry.prototype, 'isIntersecting');
                const orig = desc ? desc.get : null;
                Object.defineProperty(IntersectionObserverEntry.prototype, 'isIntersecting', {
                    get() {
                        const t = this.target;
                        if (t && (t.classList?.contains('s-product-batch') || t.matches?.('.s-product-batch') || t.closest?.('.s-product-batch'))) {
                            return true;
                        }
                        return orig ? orig.call(this) : true;
                    },
                    configurable: true,
                    enumerable: true
                });
            }
        } catch (e) {}

        try {
            if (typeof window !== 'undefined' && window.IntersectionObserver) {
                const NativeIntersectionObserver = window.IntersectionObserver;
                window.IntersectionObserver = function (callback, options) {
                    const rootMarginStr = options?.rootMargin ? String(options.rootMargin) : '';
                    const isBatchObserver = rootMarginStr.includes('1040px');
                    const wrappedCallback = (entries, observer) => {
                        for (let i = 0; i < entries.length; i++) {
                            const entry = entries[i];
                            const target = entry.target;
                            const isBatch = isBatchObserver ||
                                (target && (target.classList?.contains('s-product-batch') || target.matches?.('.s-product-batch') || target.closest?.('.s-product-batch')));
                            if (isBatch) {
                                try {
                                    Object.defineProperty(entry, 'isIntersecting', {
                                        value: true,
                                        writable: true,
                                        configurable: true
                                    });
                                } catch (e) {
                                    try {
                                        entries[i] = new Proxy(entry, {
                                            get(t, p, r) {
                                                if (p === 'isIntersecting') return true;
                                                const v = Reflect.get(t, p, r);
                                                return typeof v === 'function' ? v.bind(t) : v;
                                            }
                                        });
                                    } catch (e2) {}
                                }
                            }
                        }
                        return callback(entries, observer);
                    };
                    return new NativeIntersectionObserver(wrappedCallback, options);
                };
                window.IntersectionObserver.prototype = NativeIntersectionObserver.prototype;
            }
        } catch (e) {}
    })();`;

    // 1. Spuštění v kontextu userscriptu
    try { eval(patchCode); } catch (e) {}

    // 2. Injekce přímo do DOMu pro běh v hlavním okně (Main World)
    function injectPatch() {
        const target = document.head || document.documentElement;
        if (!target) return false;
        if (document.getElementById('lf-patch-script')) return true;

        const s = document.createElement('script');
        s.id = 'lf-patch-script';
        s.textContent = patchCode;
        try {
            target.appendChild(s);
            return true;
        } catch (e) {
            return false;
        }
    }

    if (!injectPatch()) {
        const obs = new MutationObserver(() => {
            if (injectPatch()) obs.disconnect();
        });
        try {
            obs.observe(document, { childList: true, subtree: true });
        } catch (e) {}
        if (document.readyState === 'loading') {
            document.addEventListener('readystatechange', injectPatch, { once: true });
            document.addEventListener('DOMContentLoaded', injectPatch, { once: true });
        }
    }

    // ─── Konstanty & Úložiště ──────────────────────────────────────────────────
    const CURRENT_VERSION = '1.3.3';
    const RAW_URL = 'https://raw.githubusercontent.com/RouSkiSroup/ldlFilter/main/lidl-filter.user.js';

    const STORAGE = {
        minDiscount:   'lf_min_discount',
        textQuery:     'lf_text_query',
        batteryMode:   'lf_battery_mode',
        filterEnabled: 'lf_filter_enabled',
        batches:       'lf_batches',
        minimized:     'lf_minimized',
        sortMode:      'lf_sort_mode',
        scrollMode:    'lf_scroll_mode',
        minPrice:      'lf_min_price',
        maxPrice:      'lf_max_price',
    };

    // -1 = Bez omezení slevy (všechny produkty, i ty bez slevy)
    //  0 = Jakákoliv sleva (> 0 %)
    // 10, 20, 30... = minimální sleva v %
    const DISCOUNT_PRESETS = [-1, 0, 10, 20, 30, 40, 50, 60];

    const SORT_MODES = [
        { id: 0, label: '⚖ Řazení: Výchozí' },
        { id: 1, label: '⚖ Řazení: Od nejlevnějšího' },
        { id: 2, label: '⚖ Řazení: Od nejdražšího' },
        { id: 3, label: '⚖ Řazení: Největší sleva %' },
        { id: 4, label: '⚖ Řazení: Největší úspora Kč' },
    ];

    const SCROLL_MODES = [
        { id: 0, label: '↕ Posun: Vypnuto' },
        { id: 1, label: '↕ Posun: Začátek seznamu' },
        { id: 2, label: '↕ Posun: Poslední produkt' },
    ];

    // Selektory na Lidl.cz / Lidl.sk
    const SELECTORS = {
        gridContainer:   'ol.s-product-grid, ul.s-product-grid, .s-product-grid, [data-testselector="s-product-grid__list"], .odsc-tile-grid',
        productItem:     'li[id^="grid-item-"], .s-product-batch > li, ol.s-product-grid > li, ul.s-product-grid > li, .s-product-grid > li, [data-testselector="s-product-grid__list-item"], .product-grid-box',
        loadMoreButton:  'button.s-load-more__button',
        productsCount:   '.s-products-count__label',
        loadMoreText:    '.s-load-more__text',
    };

    // ─── Stav ──────────────────────────────────────────────────────────────────
    let minDiscount        = -1;       // -1 = Vše, 0 = jakákoliv sleva, 10-60 = %
    let textQuery          = '';       // Text pro vyhledávání
    let batteryMode        = 'all';    // 'all' | 'without' | 'with'
    let minPrice           = null;     // Minimální cena v Kč
    let maxPrice           = null;     // Maximální cena v Kč
    let filteringEnabled   = false;    // Hlavní přepínač filtru
    let currentSortMode    = 0;        // 0-4
    let autoScrollMode     = 0;        // 0-2
    let multiLoadBatches   = 5;        // Počet dávek pro hromadné načtení (0 = vše)
    let isMultiLoading     = false;
    let stopRequested      = false;
    let currentLoadedBatches = 0;
    let isSorting          = false;

    // Cache extrahovaných dat pro bleskurychlé vyhledávání bez opakovaného parsování
    const productDataCache = new WeakMap();

    // ─── Styly ─────────────────────────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
        /* ── Optimalizace renderingu pro tisíce produktů (HW akcelerace prohlížeče) ── */
        .s-product-batch {
            content-visibility: auto;
            contain-intrinsic-size: 1px 1200px;
        }

        /* ── Spolehlivé skrytí nehodících se produktových karet ── */
        li.lf-hidden, .lf-hidden {
            display: none !important;
            visibility: hidden !important;
            height: 0 !important;
            min-height: 0 !important;
            max-height: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
            border: none !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }

        #lf-bubble {
            position: fixed; bottom: 80px; right: 20px; z-index: 999999;
            width: 48px; height: 48px; border-radius: 50%;
            background: linear-gradient(135deg, #0050aa, #002b66);
            color: #fff; font-size: 22px;
            display: flex; align-items: center; justify-content: center;
            cursor: pointer; box-shadow: 0 4px 18px rgba(0, 80, 170, 0.55);
            user-select: none; transition: background 0.3s, transform 0.2s, box-shadow 0.3s;
            border: 1px solid rgba(255, 255, 255, 0.25);
        }
        #lf-bubble:hover { transform: scale(1.1); box-shadow: 0 6px 22px rgba(0, 80, 170, 0.7); }
        #lf-bubble.active {
            background: linear-gradient(135deg, #16a34a, #22c55e);
            box-shadow: 0 4px 18px rgba(34, 197, 94, 0.55);
        }
        #lf-bubble-badge {
            position: absolute; top: -4px; right: -4px;
            background: #facc15; color: #000;
            font-size: 10px; font-weight: 800; line-height: 1;
            padding: 2px 5px; border-radius: 9px;
            display: none; white-space: nowrap; box-shadow: 0 2px 6px rgba(0,0,0,0.4);
        }
        #lf-bubble.active #lf-bubble-badge { display: block; }

        #lf-panel {
            position: fixed; bottom: 80px; right: 20px; z-index: 999999;
            width: 324px; border-radius: 16px;
            background: rgba(15, 17, 28, 0.94);
            backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.12);
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            font-size: 13px; color: #e2e8f0;
            display: none; user-select: none;
        }

        /* ── Hlavička panelu ── */
        #lf-drag-handle {
            padding: 13px 16px 10px;
            cursor: grab; display: flex; align-items: center; justify-content: space-between;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        #lf-drag-handle:active { cursor: grabbing; }
        .lf-header-title {
            font-weight: 700; font-size: 14px;
            background: linear-gradient(90deg, #60a5fa, #facc15);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            pointer-events: none; display: flex; align-items: center; gap: 6px;
        }
        .lf-version {
            font-size: 10px; color: #64748b; font-weight: 500;
        }
        .lf-ctrl-btn {
            background: none; border: none;
            color: rgba(255, 255, 255, 0.45); font-size: 16px; cursor: pointer;
            padding: 2px 6px; transition: color 0.15s, transform 0.1s;
        }
        .lf-ctrl-btn:hover { color: rgba(255, 255, 255, 0.95); transform: scale(1.1); }

        /* ── Tělo ── */
        #lf-body { padding: 12px 16px 16px; }

        /* ── Hlavní přepínač ── */
        #lf-toggle-filter {
            width: 100%; padding: 10px; border: none; border-radius: 10px;
            font-size: 13px; font-weight: 700; letter-spacing: 0.3px;
            cursor: pointer; transition: background 0.25s, transform 0.1s, opacity 0.15s;
            margin-bottom: 6px;
            background: linear-gradient(135deg, #dc2626, #b91c1c);
            color: #fff; box-shadow: 0 3px 10px rgba(220, 38, 38, 0.35);
        }
        #lf-toggle-filter:hover { transform: translateY(-1px); opacity: 0.94; }
        #lf-toggle-filter.enabled {
            background: linear-gradient(135deg, #16a34a, #22c55e);
            box-shadow: 0 3px 10px rgba(34, 197, 94, 0.35);
        }

        /* ── Počítadlo výsledků ── */
        #lf-count {
            font-size: 11px; color: #94a3b8; text-align: center;
            margin-bottom: 10px; min-height: 15px; transition: color 0.2s;
        }
        #lf-count.has-results { color: #86efac; font-weight: 600; }
        #lf-count.no-results  { color: #fca5a5; font-weight: 600; }

        /* ── Sekce filtrů ── */
        #lf-filter-section {
            border-top: 1px solid rgba(255,255,255,0.08);
            padding-top: 10px; margin-bottom: 4px;
        }
        .lf-label {
            display: block; color: #94a3b8; font-size: 10px;
            text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 5px; font-weight: 700;
        }

        /* ── Textové vyhledávání ── */
        .lf-search-box {
            position: relative; display: flex; align-items: center; margin-bottom: 10px;
        }
        #lf-text-input {
            width: 100%; box-sizing: border-box;
            padding: 8px 30px 8px 10px;
            background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 8px; color: #f8fafc; font-size: 12px; outline: none;
            transition: border-color 0.2s, background 0.2s;
        }
        #lf-text-input:focus {
            border-color: #60a5fa; background: rgba(255, 255, 255, 0.12);
        }
        #lf-text-clear {
            position: absolute; right: 8px; background: none; border: none;
            color: rgba(255, 255, 255, 0.4); font-size: 14px; cursor: pointer;
            padding: 2px; display: none; line-height: 1;
        }
        #lf-text-clear:hover { color: #fff; }

        /* ── Filtr akumulátoru ── */
        #lf-battery-presets {
            display: flex; gap: 4px; margin-bottom: 10px;
        }
        .lf-battery-btn {
            flex: 1; padding: 6px 3px; border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 6px; background: rgba(255, 255, 255, 0.06);
            color: #94a3b8; font-size: 10.5px; font-weight: 600; cursor: pointer;
            transition: background 0.15s, color 0.15s, border-color 0.15s;
            text-align: center; white-space: nowrap;
        }
        .lf-battery-btn:hover { background: rgba(255, 255, 255, 0.14); color: #f1f5f9; }
        .lf-battery-btn.selected {
            background: linear-gradient(135deg, #0050aa, #2563eb);
            color: #fff; border-color: #60a5fa; box-shadow: 0 2px 8px rgba(37, 99, 235, 0.4);
        }

        /* ── Presety slev ── */
        #lf-discount-presets {
            display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-bottom: 8px;
        }
        .lf-discount-btn {
            padding: 6px 2px; border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 6px; background: rgba(255, 255, 255, 0.06);
            color: #94a3b8; font-size: 11px; font-weight: 600; cursor: pointer;
            transition: background 0.15s, color 0.15s, border-color 0.15s;
            text-align: center; white-space: nowrap;
        }
        .lf-discount-btn:hover { background: rgba(255, 255, 255, 0.14); color: #f1f5f9; }
        .lf-discount-btn.selected {
            background: linear-gradient(135deg, #0050aa, #2563eb);
            color: #fff; border-color: #60a5fa; box-shadow: 0 2px 8px rgba(37, 99, 235, 0.4);
        }

        /* ── Cenové rozmezí ── */
        .lf-price-row {
            display: flex; gap: 6px; align-items: center; margin-bottom: 8px;
        }
        .lf-price-input {
            flex: 1; box-sizing: border-box; width: 50%;
            padding: 6px 8px; background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.16);
            border-radius: 6px; color: #f8fafc; font-size: 11px; outline: none;
        }
        .lf-price-input:focus { border-color: #60a5fa; }

        /* ── Oddělovač ── */
        .lf-divider { border: none; border-top: 1px solid rgba(255, 255, 255, 0.08); margin: 10px 0; }

        /* ── Tlačítka akcí ── */
        .lf-btn {
            padding: 8px 10px; border: none; border-radius: 8px;
            background: rgba(255, 255, 255, 0.09); color: #cbd5e1;
            font-size: 11px; font-weight: 600; cursor: pointer;
            transition: background 0.15s, transform 0.1s; letter-spacing: 0.2px;
            white-space: nowrap; text-align: center;
        }
        .lf-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.16); transform: translateY(-1px); }
        .lf-btn:active { transform: translateY(0); }
        .lf-btn:disabled { opacity: 0.35; cursor: not-allowed; transform: none; }
        .lf-btn-primary { background: linear-gradient(135deg, #0050aa, #2563eb); color: #fff; }
        .lf-btn-primary:hover:not(:disabled) { background: linear-gradient(135deg, #0060cc, #3b82f6); opacity: 0.95; }
        .lf-btn-danger  { background: linear-gradient(135deg, #dc2626, #b91c1c); color: #fff; }
        .lf-btn-danger:hover:not(:disabled) { opacity: 0.92; }
        .lf-btn-active  { background: linear-gradient(135deg, #0050aa, #2563eb) !important; color: #fff !important; }

        #lf-load-one { width: 100%; margin-bottom: 6px; }
        #lf-toggle-sort { width: 100%; margin-bottom: 6px; }
        #lf-toggle-scroll { width: 100%; margin-bottom: 6px; }

        /* ── Hromadné načítání ── */
        .lf-multiload-row {
            display: flex; gap: 6px; align-items: center; margin-bottom: 6px;
        }
        #lf-batches-input {
            width: 55px; padding: 7px 4px; box-sizing: border-box;
            background: rgba(255, 255, 255, 0.09); border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 8px; color: #f1f5f9; font-size: 12px;
            outline: none; text-align: center; flex-shrink: 0;
        }
        #lf-batches-input:focus { border-color: #60a5fa; }

        #lf-load-status {
            font-size: 11px; color: #93c5fd; min-height: 16px;
            text-align: center; margin-bottom: 6px; font-weight: 500;
        }
        #lf-stop-row { display: none; margin-bottom: 6px; }
        #lf-stop { width: 100%; }

        /* ── Auto-update banner ── */
        #lf-update-banner {
            display: none; width: 100%; box-sizing: border-box;
            margin-bottom: 10px; padding: 8px 12px;
            background: linear-gradient(135deg, #92400e, #b45309);
            border: 1px solid #f59e0b; border-radius: 10px; cursor: pointer;
            font-size: 11px; font-weight: 700; color: #fef3c7;
            text-align: center; transition: opacity 0.15s, transform 0.1s;
            animation: lf-pulse 2s ease-in-out infinite;
        }
        #lf-update-banner:hover { opacity: 0.92; transform: translateY(-1px); }
        #lf-update-banner.applied {
            background: rgba(255, 255, 255, 0.07); border-color: rgba(255, 255, 255, 0.15);
            color: #94a3b8; font-weight: 400; animation: none; cursor: default;
        }
        @keyframes lf-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.0); }
            50%       { box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.35); }
        }

        /* ── Spinner ── */
        @keyframes lf-spin { to { transform: rotate(360deg); } }
        .lf-spinner {
            display: inline-block; width: 12px; height: 12px;
            border: 2px solid rgba(255, 255, 255, 0.25);
            border-top-color: #60a5fa; border-radius: 50%;
            animation: lf-spin 0.7s linear infinite;
            vertical-align: middle; margin-right: 5px;
        }
    `;

    // ─── Stavba UI ─────────────────────────────────────────────────────────────
    const bubble = document.createElement('div');
    bubble.id = 'lf-bubble';
    bubble.title = 'Lidl Product Filter';
    bubble.innerHTML = '🔍<span id="lf-bubble-badge">0</span>';

    const panel = document.createElement('div');
    panel.id = 'lf-panel';
    panel.innerHTML = `
        <div id="lf-drag-handle">
            <div class="lf-header-title">
                <span>🛒</span>
                <span>Lidl Product Filter</span>
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
                <span class="lf-version">v${CURRENT_VERSION}</span>
                <button class="lf-ctrl-btn" id="lf-minimize" title="Minimalizovat">−</button>
            </div>
        </div>

        <div id="lf-body">
            <button id="lf-update-banner"></button>
            <button id="lf-toggle-filter">● Filtrování VYPNUTO</button>
            <div id="lf-count"></div>

            <div id="lf-filter-section">
                <!-- Textový filtr -->
                <label class="lf-label">Hledat v názvu / značce</label>
                <div class="lf-search-box">
                    <input type="text" id="lf-text-input" placeholder="např. vrtačka, aku, parkside..." autocomplete="off" />
                    <button type="button" id="lf-text-clear" title="Vymazat">✕</button>
                </div>

                <!-- Filtr akumulátoru -->
                <label class="lf-label">Akumulátor v balení</label>
                <div id="lf-battery-presets">
                    <button type="button" class="lf-battery-btn selected" data-battery="all" title="Všechny produkty (nerozhoduje)">Vše</button>
                    <button type="button" class="lf-battery-btn" data-battery="without" title="Pouze nářadí bez akumulátoru a nabíječky (body only)">🚫 Bez baterie</button>
                    <button type="button" class="lf-battery-btn" data-battery="with" title="Pouze sady s akumulátorem v balení">🔋 S baterií</button>
                </div>

                <!-- Sleva -->
                <label class="lf-label">Minimální sleva</label>
                <div id="lf-discount-presets"></div>

                <!-- Cenový rozsah -->
                <label class="lf-label">Cenové rozpětí (Kč)</label>
                <div class="lf-price-row">
                    <input type="number" id="lf-min-price" class="lf-price-input" placeholder="Od Kč" min="0" />
                    <input type="number" id="lf-max-price" class="lf-price-input" placeholder="Do Kč" min="0" />
                </div>
            </div>

            <div id="lf-load-section">
                <hr class="lf-divider"/>

                <button class="lf-btn" id="lf-load-one">📄 Načíst 1 dávku (48) &nbsp;<span style="color:#64748b;font-weight:400;">(Ctrl)</span></button>

                <div class="lf-multiload-row">
                    <input type="number" id="lf-batches-input" min="0" max="200" title="Počet dávek (0 = všechny)"/>
                    <button class="lf-btn lf-btn-primary" id="lf-load-many" style="flex:1;">Načíst více dávek</button>
                </div>

                <div id="lf-load-status"></div>
                <div id="lf-stop-row">
                    <button class="lf-btn lf-btn-danger" id="lf-stop">⏹ Zastavit načítání</button>
                </div>

                <hr class="lf-divider"/>

                <button class="lf-btn" id="lf-toggle-sort">⚖ Řazení: Výchozí</button>
                <button class="lf-btn" id="lf-toggle-scroll">↕ Posun: Vypnuto</button>
            </div>
        </div>
    `;

    // ─── Reference na elementy ─────────────────────────────────────────────────
    const presetsEl       = panel.querySelector('#lf-discount-presets');
    const filterSection   = panel.querySelector('#lf-filter-section');
    const loadStatus      = panel.querySelector('#lf-load-status');
    const textInput       = panel.querySelector('#lf-text-input');
    const textClearBtn    = panel.querySelector('#lf-text-clear');
    const minPriceInput   = panel.querySelector('#lf-min-price');
    const maxPriceInput   = panel.querySelector('#lf-max-price');
    const batchesInput    = panel.querySelector('#lf-batches-input');
    const toggleFilterBtn = panel.querySelector('#lf-toggle-filter');
    const loadOneBtn      = panel.querySelector('#lf-load-one');
    const loadManyBtn     = panel.querySelector('#lf-load-many');
    const toggleSortBtn   = panel.querySelector('#lf-toggle-sort');
    const toggleScrollBtn = panel.querySelector('#lf-toggle-scroll');
    const stopBtn         = panel.querySelector('#lf-stop');
    const stopRow         = panel.querySelector('#lf-stop-row');
    const countEl         = panel.querySelector('#lf-count');
    const bubbleBadge     = bubble.querySelector('#lf-bubble-badge');
    const minimizeBtn     = panel.querySelector('#lf-minimize');

    // ─── Tlačítka slevových presetů ────────────────────────────────────────────
    DISCOUNT_PRESETS.forEach(val => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lf-discount-btn';
        btn.dataset.discount = String(val);
        if (val === -1) {
            btn.textContent = 'Vše';
            btn.title = 'Všechny produkty (i bez slevy)';
        } else if (val === 0) {
            btn.textContent = '> 0 %';
            btn.title = 'Jakákoliv sleva';
        } else {
            btn.textContent = `≥ ${val} %`;
            btn.title = `Sleva ${val} % a více`;
        }
        btn.addEventListener('click', () => {
            minDiscount = val;
            save(STORAGE.minDiscount, minDiscount);
            renderDiscountPresets();
            applyFilter();
            applySort();
            updateBubble();
        });
        presetsEl.appendChild(btn);
    });

    // ─── Tlačítka filtru akumulátoru ───────────────────────────────────────────
    panel.querySelectorAll('.lf-battery-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            batteryMode = btn.dataset.battery || 'all';
            save(STORAGE.batteryMode, batteryMode);
            renderBatteryPresets();
            applyFilter();
            applySort();
            updateBubble();
        });
    });

    function renderBatteryPresets() {
        panel.querySelectorAll('.lf-battery-btn').forEach(btn => {
            btn.classList.toggle('selected', btn.dataset.battery === batteryMode);
        });
    }

    // ─── Drag & Drop panelu a bubliny ──────────────────────────────────────────
    function makeDraggable(el, handle) {
        let dragging = false, ox = 0, oy = 0, didMove = false;

        handle.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            dragging = true;
            didMove = false;
            const rect = el.getBoundingClientRect();
            ox = e.clientX - rect.left;
            oy = e.clientY - rect.top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            didMove = true;
            const x = e.clientX - ox;
            const y = e.clientY - oy;
            el.style.right  = 'auto';
            el.style.bottom = 'auto';
            el.style.left   = Math.max(0, Math.min(x, window.innerWidth  - el.offsetWidth))  + 'px';
            el.style.top    = Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight)) + 'px';
        });

        document.addEventListener('mouseup', e => {
            if (dragging && didMove) e.stopImmediatePropagation();
            dragging = false;
        });

        handle.addEventListener('click', e => {
            if (didMove) { e.stopImmediatePropagation(); didMove = false; }
        }, true);
    }

    makeDraggable(panel, panel.querySelector('#lf-drag-handle'));
    makeDraggable(bubble, bubble);

    // ─── Ukládání a načítání stavu ─────────────────────────────────────────────
    function save(key, value) {
        try {
            localStorage.setItem(key, String(value));
        } catch (e) { /* ignore */ }
    }

    function loadSavedState() {
        const savedDiscount = parseInt(localStorage.getItem(STORAGE.minDiscount) ?? '-1', 10);
        minDiscount = DISCOUNT_PRESETS.includes(savedDiscount) ? savedDiscount : -1;
        renderDiscountPresets();

        const savedBattery = localStorage.getItem(STORAGE.batteryMode);
        batteryMode = ['all', 'without', 'with'].includes(savedBattery) ? savedBattery : 'all';
        renderBatteryPresets();

        textQuery = localStorage.getItem(STORAGE.textQuery) || '';
        textInput.value = textQuery;
        textClearBtn.style.display = textQuery ? 'block' : 'none';

        const savedMinPrice = parseFloat(localStorage.getItem(STORAGE.minPrice) || '');
        minPrice = Number.isFinite(savedMinPrice) && savedMinPrice >= 0 ? savedMinPrice : null;
        if (minPrice !== null) minPriceInput.value = minPrice;

        const savedMaxPrice = parseFloat(localStorage.getItem(STORAGE.maxPrice) || '');
        maxPrice = Number.isFinite(savedMaxPrice) && savedMaxPrice >= 0 ? savedMaxPrice : null;
        if (maxPrice !== null) maxPriceInput.value = maxPrice;

        multiLoadBatches = parseInt(localStorage.getItem(STORAGE.batches) || '5', 10);
        if (!Number.isFinite(multiLoadBatches) || multiLoadBatches < 0) multiLoadBatches = 5;
        batchesInput.value = multiLoadBatches;
        updateLoadManyLabel();

        filteringEnabled = localStorage.getItem(STORAGE.filterEnabled) === '1';

        currentSortMode = parseInt(localStorage.getItem(STORAGE.sortMode) || '0', 10);
        if (currentSortMode < 0 || currentSortMode >= SORT_MODES.length) currentSortMode = 0;

        autoScrollMode = parseInt(localStorage.getItem(STORAGE.scrollMode) || '0', 10);
        if (autoScrollMode < 0 || autoScrollMode >= SCROLL_MODES.length) autoScrollMode = 0;

        const minimized = localStorage.getItem(STORAGE.minimized);
        if (minimized === '0') {
            panel.style.display = 'block';
            bubble.style.display = 'none';
        }
    }

    function renderDiscountPresets() {
        panel.querySelectorAll('.lf-discount-btn').forEach(btn => {
            btn.classList.toggle('selected', parseInt(btn.dataset.discount, 10) === minDiscount);
        });
    }

    function updateLoadManyLabel() {
        loadManyBtn.textContent = multiLoadBatches === 0 ? 'Načíst všechny produkty' : 'Načíst více dávek';
    }

    // ─── Normalizace textu (bez diakritiky) ────────────────────────────────────
    function normalize(str) {
        if (!str) return '';
        return String(str)
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim();
    }

    function parsePrice(text) {
        if (typeof text === 'number') return text;
        if (!text) return NaN;
        // Odstraní mezery, Kč, čárku nahradí tečkou
        const clean = String(text)
            .replace(/\s+/g, '')
            .replace(/[^\d.,]/g, '')
            .replace(',', '.');
        const num = parseFloat(clean);
        return Number.isFinite(num) ? num : NaN;
    }

    // ─── Nalezení a normalizace karet produktů ────────────────────────────────
    // Na Lidl.cz / Lidl.sk jsou produkty v mřížce obaleny v <li> elementech (např. <li id="grid-item-0-...">).
    // Pro správné fungování CSS Gridu a odolnost vůči hydrataci Vue/Nuxt musíme skrývat
    // a řadit přímo tyto rodičovské <li> elementy, nikoli jen jejich vnitřní elementy.
    function getProductCards() {
        const cards = [];
        const seen = new Set();

        const batches = document.querySelectorAll('.s-product-batch');
        if (batches.length > 0) {
            batches.forEach(batch => {
                const lis = batch.querySelectorAll('li[id^="grid-item-"], ol > li, ul > li, :scope > li, [data-testselector="s-product-grid__list-item"], .product-grid-box');
                lis.forEach(li => {
                    const card = li.closest('li[id^="grid-item-"]') || li.closest('li') || li;
                    if (!seen.has(card)) {
                        seen.add(card);
                        cards.push(card);
                    }
                });
            });
        }

        if (cards.length === 0) {
            const gridContainers = document.querySelectorAll(SELECTORS.gridContainer);
            gridContainers.forEach(grid => {
                const lis = grid.querySelectorAll('li[id^="grid-item-"], .s-product-batch > li, :scope > li, [data-testselector="s-product-grid__list-item"], .product-grid-box');
                lis.forEach(li => {
                    const card = li.closest('li[id^="grid-item-"]') || li.closest('li') || li;
                    if (!seen.has(card)) {
                        seen.add(card);
                        cards.push(card);
                    }
                });
            });
        }

        if (cards.length === 0) {
            const raw = document.querySelectorAll('li[id^="grid-item-"], .s-product-batch > li, [data-testselector="s-product-grid__list-item"], .product-grid-box');
            raw.forEach(el => {
                const card = el.closest('li[id^="grid-item-"]') || el.closest('li') || el;
                if (!seen.has(card)) {
                    seen.add(card);
                    cards.push(card);
                }
            });
        }

        return cards;
    }

    // ─── Extrakce informací o produktu a detekce baterie ─────────────────────────
    // Lidl ukládá kompletní JSON do data-grid-data atributu (při SSR).
    // Po hydrataci Vue komponenty se data čerpají z DOMu nebo existující cache.
    function extractProductInfo(card) {
        let title = '';
        let brand = '';
        let category = '';
        let description = '';
        let currentPrice = NaN;
        let oldPrice = NaN;
        let discountPercent = 0;
        let absoluteDiscount = 0;

        // 1. Zkusíme data-grid-data (buď přímo na kartě, nebo v libovolném potomku)
        const dataHolder = (card.hasAttribute && card.hasAttribute('data-grid-data'))
            ? card
            : (card.querySelector ? card.querySelector('[data-grid-data]') : null);

        const rawData = dataHolder ? (dataHolder.getAttribute('data-grid-data') || dataHolder.dataset?.gridData) : null;
        if (rawData) {
            try {
                const data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
                title = data.fullTitle || data.title || '';
                brand = data.brand?.name || '';
                category = data.category || '';

                if (data.keyfacts) {
                    description = `${data.keyfacts.supplementalDescription || ''} ${data.keyfacts.description || ''}`.trim();
                }

                if (data.price) {
                    if (typeof data.price.price === 'number') {
                        currentPrice = data.price.price;
                    }
                    const disc = data.price.discount;
                    if (disc) {
                        if (typeof disc.percentageDiscount === 'number' && disc.percentageDiscount > 0) {
                            discountPercent = disc.percentageDiscount;
                        }
                        if (typeof disc.absoluteDiscount === 'number' && disc.absoluteDiscount > 0) {
                            absoluteDiscount = disc.absoluteDiscount;
                        }
                        if (typeof disc.deletedPrice === 'number' && disc.deletedPrice > 0) {
                            oldPrice = disc.deletedPrice;
                        }
                    }
                    if (isNaN(oldPrice) && typeof data.price.oldPrice === 'number' && data.price.oldPrice > 0) {
                        oldPrice = data.price.oldPrice;
                    }
                }
            } catch (err) {
                // v případě chyby v JSON fallbackujeme na DOM níže
            }
        }

        // 2. DOM fallback pro název
        if (!title && card.querySelector) {
            const titleEl = card.querySelector(
                '.product-grid-box__title, .product-grid-box-title, .s-grid-box-skeleton__name, [data-testselector="product-title"], h2, h3, a.odsc-tile__link, .ods-typography-title-medium-bold'
            );
            if (titleEl) title = titleEl.textContent.trim();
        }

        // 3. DOM fallback pro značku
        if (!brand && card.querySelector) {
            const brandEl = card.querySelector(
                '.product-grid-box__brand, .product-grid-box-brand, [data-testselector="product-brand"]'
            );
            if (brandEl) brand = brandEl.textContent.trim();
        }

        // 4. DOM fallback pro popis
        if (!description) {
            const descEl = card.querySelector ? card.querySelector('.product-grid-box__desc, .product-grid-box-desc, .keyfacts') : null;
            description = descEl ? descEl.textContent.trim() : (card.textContent || '').trim();
        }

        // 5. DOM fallback pro cenu
        if (isNaN(currentPrice) && card.querySelector) {
            const priceEl = card.querySelector(
                '.product-grid-box__price, .ods-price-card__price, .s-grid-box-skeleton__price, [data-testselector="price"], .ods-typography-title-large-bold'
            );
            if (priceEl) currentPrice = parsePrice(priceEl.textContent);
        }

        // 6. DOM fallback pro původní přeškrtnutou cenu
        if (isNaN(oldPrice) && card.querySelector) {
            const strokeEl = card.querySelector(
                '.ods-price-card__strikethrough-price, .ods-strikethrough-price, s, del, strike, [class*="strikethrough"], [class*="stroke"]'
            );
            if (strokeEl) oldPrice = parsePrice(strokeEl.textContent);
        }

        // 7. Detekce procenta slevy z DOMu (pokud nebylo v JSON)
        // Lidl na kartách zobrazuje červený odznak např. "-33%", "-16%", "-50%"
        if (discountPercent === 0 && card.textContent) {
            const badgeMatch = card.textContent.match(/-\s*(\d{1,2})\s*%/);
            if (badgeMatch) {
                const parsed = parseInt(badgeMatch[1], 10);
                if (parsed > 0 && parsed <= 99) {
                    discountPercent = parsed;
                }
            }
        }

        // 8. Výpočet slevy pokud máme obě ceny
        if (discountPercent === 0 && !isNaN(oldPrice) && !isNaN(currentPrice) && oldPrice > currentPrice) {
            discountPercent = Math.round(((oldPrice - currentPrice) / oldPrice) * 100);
        }
        if (absoluteDiscount === 0 && !isNaN(oldPrice) && !isNaN(currentPrice) && oldPrice > currentPrice) {
            absoluteDiscount = Math.round(oldPrice - currentPrice);
        }

        const searchText = normalize(`${title} ${brand} ${category}`);

        // ─── Klasifikace akumulátoru ───
        // 'WITHOUT'      = AKU nářadí bez akumulátoru a nabíječky (body only)
        // 'WITH'         = Sady nářadí s akumulátorem v balení (např. Smart 8 Ah, 2 Ah, složení sady)
        // 'BATTERY_ONLY' = Samostatný akumulátor nebo nabíječka (nikoli nářadí)
        // 'OTHER'        = Ostatní produkty (síťové nářadí, zahradní nábytek, oblečení...)
        let batteryStatus = 'OTHER';

        const normTitle = normalize(title);
        const fullDescText = normalize(`${title} ${description}`);

        const toolKeywords = [
            'vrtacka', 'sroubovak', 'kladivo', 'pila', 'bruska', 'utahovak',
            'kompresor', 'pumpa', 'pistole', 'hoblik', 'nuzky', 'vysavac',
            'sekacka', 'vyzinac', 'fukar', 'svitilna', 'reflektor', 'freza',
            'sponkovacka', 'nytovacka', 'krovinorez', 'pajecka', 'multinaradi',
            'cistic', 'mycka', 'kartac', 'multibruska', 'cerpadlo', 'postrikovac',
            'misenka', 'retezova', 'pokosova', 'ocaska', 'tavna'
        ];
        const hasToolKeyword = toolKeywords.some(k => normTitle.includes(k));

        const isStandaloneBatteryOrCharger = !hasToolKeyword &&
            /\b(akumulator|baterie|nabijecka|smart akumulator|nabijeci)\b/i.test(normTitle);

        const withoutPatterns = [
            /bez\s+akumulator/i,
            /bez\s+bater/i,
            /\bbez\s+aku\b/i,
            /nejsou\s+soucasti\s+baleni/i,
            /neni\s+soucasti\s+baleni/i,
            /doporuceny\s+akumulator/i,
            /\bbody\s+only\b/i
        ];
        const hasWithout = withoutPatterns.some(p => p.test(fullDescText));

        const withPatterns = [
            /,\s*(?:smart\s+)?\d+(?:,\d+)?\s*ah\b/i,
            /,\s*\d+x\s*(?:smart\s+)?\d+(?:,\d+)?\s*ah\b/i,
            /\b\d+(?:,\d+)?\s*ah\s+a\s+\d+(?:,\d+)?\s*ah\b/i,
            /vcetne\s+akumulator/i,
            /vcetne\s+bater/i,
            /s\s+akumulatorem/i,
            /s\s+baterii/i,
            /slozeni\s+sady:.*?(?:akumulator|baterie)/i
        ];
        const hasWith = withPatterns.some(p => p.test(fullDescText));

        if (isStandaloneBatteryOrCharger) {
            batteryStatus = 'BATTERY_ONLY';
        } else if (hasWithout && !hasWith) {
            batteryStatus = 'WITHOUT';
        } else if (hasWith && !hasWithout) {
            batteryStatus = 'WITH';
        } else if (hasWithout && hasWith) {
            batteryStatus = /bez\s+akumulator/i.test(normTitle) ? 'WITHOUT' : 'WITH';
        } else if (/\baku\b/i.test(normTitle)) {
            batteryStatus = 'AKU_UNSPECIFIED';
        }

        return {
            title,
            brand,
            category,
            currentPrice: isNaN(currentPrice) ? 0 : currentPrice,
            oldPrice: isNaN(oldPrice) ? 0 : oldPrice,
            discountPercent,
            absoluteDiscount,
            searchText,
            batteryStatus,
        };
    }

    function getProductInfo(card) {
        if (productDataCache.has(card)) {
            const cached = productDataCache.get(card);
            if (cached && (cached.title || cached.currentPrice > 0)) {
                return cached;
            }
        }
        const info = extractProductInfo(card);
        if (info && (info.title || info.currentPrice > 0)) {
            productDataCache.set(card, info);
        }
        return info;
    }

    // ─── Filtrační logika ──────────────────────────────────────────────────────
    function applyFilter() {
        let cards = getProductCards();
        const fetchedTotal = getPagingFetchedCount();
        if (fetchedTotal && cards.length < fetchedTotal) {
            window.dispatchEvent(new Event('resize'));
            window.dispatchEvent(new Event('scroll'));
            cards = getProductCards();
        }
        const total = cards.length;

        if (!filteringEnabled) {
            cards.forEach(card => {
                card.classList.remove('lf-hidden');
                card.style.removeProperty('display');
            });
            updateCount(null, total);
            return;
        }

        // Příprava slov pro textové vyhledávání (např. "aku vrtacka" -> ["aku", "vrtacka"])
        const queryWords = textQuery.trim()
            ? normalize(textQuery).split(/\s+/).filter(Boolean)
            : [];

        let shown = 0;
        cards.forEach(card => {
            const info = getProductInfo(card);

            // 1. Textový filtr: všechna zadaná slova musí být v názvu / značce
            let textMatch = true;
            if (queryWords.length > 0) {
                textMatch = queryWords.every(word => info.searchText.includes(word));
            }

            // 2. Slevový filtr:
            //    -1 = jakýkoliv produkt (i bez slevy)
            //     0 = jakákoliv sleva (> 0 %)
            //    >0 = sleva >= minDiscount
            let discountMatch = true;
            if (minDiscount === 0) {
                discountMatch = info.discountPercent > 0;
            } else if (minDiscount > 0) {
                discountMatch = info.discountPercent >= minDiscount;
            }

            // 3. Filtr akumulátoru:
            //    'all'     = bez omezení (jakékoliv produkty)
            //    'without' = pouze nářadí bez akumulátoru a nabíječky (body only)
            //    'with'    = pouze sady s akumulátorem
            let batteryMatch = true;
            if (batteryMode === 'without') {
                batteryMatch = info.batteryStatus === 'WITHOUT';
            } else if (batteryMode === 'with') {
                batteryMatch = info.batteryStatus === 'WITH';
            }

            // 4. Cenový filtr
            let priceMatch = true;
            if (minPrice !== null && info.currentPrice < minPrice) priceMatch = false;
            if (maxPrice !== null && info.currentPrice > maxPrice) priceMatch = false;

            const matches = textMatch && discountMatch && batteryMatch && priceMatch;
            if (matches) {
                card.classList.remove('lf-hidden');
                card.style.removeProperty('display');
                shown++;
            } else {
                card.classList.add('lf-hidden');
                card.style.setProperty('display', 'none', 'important');
            }
        });

        updateCount(shown, total);
    }

    function getPagingInfo() {
        const lmText = document.querySelector(SELECTORS.loadMoreText);
        if (lmText && lmText.textContent) {
            const m = lmText.textContent.match(/([\d\s]+)\s*(?:\/|z)\s*([\d\s]+)/i);
            if (m) {
                const current = parseInt(m[1].replace(/[^\d]/g, ''), 10);
                const total = parseInt(m[2].replace(/[^\d]/g, ''), 10);
                if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
                    return { current, total };
                }
            }
        }
        return { current: null, total: null };
    }

    function getTotalCatalogCount() {
        const paging = getPagingInfo();
        if (paging.total) return paging.total;

        // Fallback: zkusí najít celkový počet z hlavičky (např. "3670 produktů")
        const label = document.querySelector(SELECTORS.productsCount);
        if (label) {
            const num = parseInt(label.textContent.replace(/[^\d]/g, ''), 10);
            if (Number.isFinite(num) && num > 0) return num;
        }
        return null;
    }

    function getPagingFetchedCount() {
        return getPagingInfo().current;
    }

    function getBatchCount() {
        return document.querySelectorAll('.s-product-batch').length;
    }

    function updateCount(shown, total) {
        const catalogTotal = getTotalCatalogCount();
        const fetchedTotal = getPagingFetchedCount();
        const effectiveTotal = Math.max(total, fetchedTotal || 0);
        const catalogStr = catalogTotal && catalogTotal > effectiveTotal
            ? ` (z celkem ${catalogTotal.toLocaleString('cs-CZ')})`
            : (catalogTotal && effectiveTotal >= catalogTotal ? ` (vše načteno)` : '');

        if (!filteringEnabled || shown === null) {
            countEl.textContent = effectiveTotal > 0 ? `Načteno ${effectiveTotal.toLocaleString('cs-CZ')} produktů${catalogStr}` : '';
            countEl.className = '';
            return;
        }
        countEl.textContent = `Zobrazeno ${shown.toLocaleString('cs-CZ')} z ${effectiveTotal.toLocaleString('cs-CZ')} načtených${catalogStr}`;
        countEl.className = shown === 0 ? 'no-results' : 'has-results';
    }

    function updateBubble() {
        const isSortActive = currentSortMode !== 0;
        const active = filteringEnabled || isSortActive;

        bubble.classList.toggle('active', active);
        if (active) {
            const cards = getProductCards();
            const visibleCount = cards.filter(card => !card.classList.contains('lf-hidden') && card.style.display !== 'none').length;
            bubbleBadge.textContent = String(visibleCount);
        }
    }

    function updateFilterToggle() {
        if (filteringEnabled) {
            toggleFilterBtn.textContent = '● Filtrování ZAPNUTO';
            toggleFilterBtn.classList.add('enabled');
            filterSection.style.display = 'block';
        } else {
            toggleFilterBtn.textContent = '● Filtrování VYPNUTO';
            toggleFilterBtn.classList.remove('enabled');
            filterSection.style.display = 'none';
        }
    }

    // ─── Řazení produktů ───────────────────────────────────────────────────────
    function updateSortUI() {
        toggleSortBtn.textContent = SORT_MODES[currentSortMode].label;
        toggleSortBtn.classList.toggle('lf-btn-active', currentSortMode !== 0);
    }

    function applySort() {
        if (currentSortMode === 0 || isSorting) return;
        const container = document.querySelector(SELECTORS.gridContainer);
        if (!container) return;

        isSorting = true;
        const cards = getProductCards();

        cards.sort((a, b) => {
            const infoA = getProductInfo(a);
            const infoB = getProductInfo(b);
            switch (currentSortMode) {
                case 1: // Od nejlevnějšího
                    return (infoA.currentPrice || Infinity) - (infoB.currentPrice || Infinity);
                case 2: // Od nejdražšího
                    return (infoB.currentPrice || 0) - (infoA.currentPrice || 0);
                case 3: // Největší sleva v %
                    return infoB.discountPercent - infoA.discountPercent;
                case 4: // Největší úspora v Kč
                    return infoB.absoluteDiscount - infoA.absoluteDiscount;
                default:
                    return 0;
            }
        });

        // Připojení existujících uzlů aktualizuje jejich pozice v DOMu
        cards.forEach(card => container.appendChild(card));
        setTimeout(() => { isSorting = false; }, 50);
    }

    // ─── Automatický posun (Scroll) ───────────────────────────────────────────
    function updateScrollUI() {
        toggleScrollBtn.textContent = SCROLL_MODES[autoScrollMode].label;
        toggleScrollBtn.classList.toggle('lf-btn-active', autoScrollMode !== 0);
    }

    function scrollToProductList() {
        const grid = document.querySelector(SELECTORS.gridContainer);
        if (grid) grid.scrollIntoView({ behavior: 'instant', block: 'start' });
    }

    function scrollToLatestVisibleProduct() {
        const cards = getProductCards();
        const visible = cards.filter(card => !card.classList.contains('lf-hidden') && card.style.display !== 'none');
        if (visible.length > 0) {
            visible[visible.length - 1].scrollIntoView({ behavior: 'instant', block: 'nearest' });
        }
    }

    setInterval(() => {
        if (autoScrollMode === 1) scrollToProductList();
        else if (autoScrollMode === 2) scrollToLatestVisibleProduct();
    }, 2000);

    // ─── Načítání dalších produktů ────────────────────────────────────────────
    function getLoadMoreButton() {
        return document.querySelector(SELECTORS.loadMoreButton);
    }

    function isCatalogFullyLoaded() {
        const total = getTotalCatalogCount();
        const fetched = getPagingFetchedCount();
        const currentCards = getProductCards().length;

        if (total && total > 0) {
            if (fetched && fetched >= total) return true;
            if (currentCards >= total) return true;
        }

        const lmText = document.querySelector(SELECTORS.loadMoreText);
        if (lmText && lmText.textContent) {
            const m = lmText.textContent.match(/(\d+)\s*\/\s*(\d+)/);
            if (m) {
                const cur = parseInt(m[1].replace(/\s+/g, ''), 10);
                const tot = parseInt(m[2].replace(/\s+/g, ''), 10);
                if (cur > 0 && tot > 0 && cur >= tot) return true;
            }
        }
        return false;
    }

    // Čeká, až bude tlačítko pro načtení další dávky přítomné v DOMu a připravené ke kliknutí
    async function waitForButtonReady(maxWaitMs = 15000) {
        const startTime = Date.now();
        while (Date.now() - startTime < maxWaitMs) {
            if (stopRequested) return null;
            if (isCatalogFullyLoaded()) return null;

            const btn = getLoadMoreButton();
            if (btn) {
                const isDisabled = btn.disabled || btn.hasAttribute('disabled') || btn.classList.contains('is-loading');
                if (!isDisabled) {
                    return btn;
                }
            }
            await new Promise(r => setTimeout(r, 120));
        }
        return null;
    }

    async function loadOneBatch() {
        const btn = await waitForButtonReady(4000);
        if (btn) {
            const beforeCards = getProductCards().length;
            const beforeBatches = getBatchCount();
            const beforeFetched = getPagingFetchedCount() || 0;
            btn.click();
            await waitForMoreProducts(beforeCards, beforeBatches, beforeFetched, 8000);
            applyFilter();
            applySort();
            updateBubble();
            return true;
        }
        return false;
    }

    // Čeká na přidání nových produktů do DOMu nebo aktualizaci stránkování
    function waitForMoreProducts(prevCards, prevBatches, prevFetched, maxWaitMs = 15000) {
        return new Promise(resolve => {
            const checkProgress = () => {
                const currentCards = getProductCards().length;
                const currentBatches = getBatchCount();
                const currentFetched = getPagingFetchedCount() || 0;

                const progressed = currentCards > prevCards
                    || currentBatches > prevBatches
                    || currentFetched > prevFetched;

                return {
                    cards: currentCards,
                    batches: currentBatches,
                    fetched: currentFetched,
                    progress: progressed
                };
            };

            const initial = checkProgress();
            if (initial.progress) return resolve(initial);

            let done = false;
            let observer = null;
            let interval = null;
            let timer = null;

            const finish = () => {
                if (done) return;
                done = true;
                if (observer) observer.disconnect();
                if (interval) clearInterval(interval);
                if (timer) clearTimeout(timer);
                resolve(checkProgress());
            };

            observer = new MutationObserver(() => {
                const state = checkProgress();
                if (state.progress) finish();
            });
            observer.observe(document.body, { childList: true, subtree: true, characterData: true });

            interval = setInterval(() => {
                const state = checkProgress();
                if (state.progress) finish();
            }, 150);

            timer = setTimeout(finish, maxWaitMs);
        });
    }

    async function runMultiLoad() {
        if (isMultiLoading) return;
        isMultiLoading = true;
        stopRequested = false;
        currentLoadedBatches = 0;

        const loadAll = multiLoadBatches === 0;
        const targetLabel = loadAll ? '∞' : String(multiLoadBatches);

        loadManyBtn.disabled = true;
        loadManyBtn.innerHTML = `<span class="lf-spinner"></span>Načítání…`;
        stopRow.style.display = 'block';
        loadStatus.textContent = `Načítání: 0 / ${targetLabel}`;

        let reachedEnd = false;
        let consecutiveRetries = 0;

        while (!stopRequested && (loadAll || currentLoadedBatches < multiLoadBatches)) {
            // 1. Zkontrolujeme, zda již nemáme celý katalog
            if (isCatalogFullyLoaded()) {
                reachedEnd = true;
                break;
            }

            // 2. Počkáme, až bude tlačítko přítomné a povolené ke kliknutí (až doběhne předchozí render)
            const btn = await waitForButtonReady(12000);
            if (stopRequested) break;

            if (!btn) {
                if (isCatalogFullyLoaded()) {
                    reachedEnd = true;
                    break;
                }
                consecutiveRetries++;
                if (consecutiveRetries >= 3) break;
                await new Promise(r => setTimeout(r, 800));
                continue;
            }

            const beforeCards = getProductCards().length;
            const beforeBatches = getBatchCount();
            const beforeFetched = getPagingFetchedCount() || 0;

            btn.click();

            // 3. Počkáme, až se objeví nové produkty v DOMu nebo se aktualizuje stránkování
            const result = await waitForMoreProducts(beforeCards, beforeBatches, beforeFetched, 15000);
            if (stopRequested) break;

            if (result.progress || result.cards > beforeCards || result.batches > beforeBatches || (result.fetched && result.fetched > beforeFetched)) {
                consecutiveRetries = 0;
                currentLoadedBatches++;
                const total = getTotalCatalogCount();
                const currentCount = Math.max(result.fetched || 0, result.cards || 0);
                const totalStr = total ? ` (${currentCount.toLocaleString('cs-CZ')} / ${total.toLocaleString('cs-CZ')})` : ` (${currentCount} produktů)`;
                loadStatus.textContent = `Načítání: ${currentLoadedBatches} / ${targetLabel}${totalStr}`;
            } else {
                if (isCatalogFullyLoaded()) {
                    reachedEnd = true;
                    break;
                }
                consecutiveRetries++;
                if (consecutiveRetries >= 3) break;
                await new Promise(r => setTimeout(r, 800));
                continue;
            }

            // Krátká pauza pro plynulost v prohlížeči
            await new Promise(r => setTimeout(r, 200));
        }

        isMultiLoading = false;
        loadManyBtn.disabled = false;
        loadManyBtn.textContent = loadAll ? 'Načíst všechny produkty' : 'Načíst více dávek';
        stopRow.style.display = 'none';

        if (stopRequested) {
            loadStatus.textContent = `⏹ Zastaveno po ${currentLoadedBatches} dávkách`;
        } else if (reachedEnd || isCatalogFullyLoaded()) {
            loadStatus.textContent = `✓ Načteno vše (konec katalogu)`;
        } else if (consecutiveRetries >= 3) {
            loadStatus.textContent = `⚠ Načteno ${currentLoadedBatches} dávek (zkuste pokračovat dalším kliknutím)`;
        } else {
            loadStatus.textContent = `✓ Načteno ${currentLoadedBatches} dávek`;
        }
        setTimeout(() => { loadStatus.textContent = ''; }, 4500);

        // Vyvoláme resize a scroll událost, aby se ujistilo, že všechny dávky jsou namountované
        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('scroll'));

        applyFilter();
        applySort();
        updateBubble();
    }

    // ─── Kontrola nových verzí (Auto-update) ───────────────────────────────────
    function isNewerVersion(remote, local) {
        const r = remote.split('.').map(Number);
        const l = local.split('.').map(Number);
        const len = Math.max(r.length, l.length);
        for (let i = 0; i < len; i++) {
            const rv = r[i] ?? 0;
            const lv = l[i] ?? 0;
            if (rv > lv) return true;
            if (rv < lv) return false;
        }
        return false;
    }

    function checkForUpdate() {
        const url = RAW_URL + '?t=' + Date.now();
        const handleResp = text => {
            const match = text.match(/@version\s+([\d.]+)/);
            if (!match) return;
            const latest = match[1];
            if (!isNewerVersion(latest, CURRENT_VERSION)) return;
            const banner = document.getElementById('lf-update-banner');
            if (!banner) return;
            banner.textContent = `⬆ Nová verze v${latest} k dispozici — klikněte pro aktualizaci`;
            banner.style.display = 'block';
            banner.addEventListener('click', () => {
                window.open(RAW_URL, '_blank', 'noopener');
                setTimeout(() => {
                    banner.textContent = '↻ Obnovte stránku pro aktivaci nové verze';
                    banner.classList.add('applied');
                }, 500);
            });
        };

        if (typeof GM_xmlhttpRequest !== 'undefined') {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                onload(resp) {
                    if (resp.status === 200) handleResp(resp.responseText);
                },
                onerror() {},
            });
        } else if (typeof fetch !== 'undefined') {
            fetch(url)
                .then(r => r.ok ? r.text() : '')
                .then(text => { if (text) handleResp(text); })
                .catch(() => {});
        }
    }

    // ─── MutationObserver pro dynamické produkty a hydrataci ──────────────────
    let domObserverAttached = false;
    let domDebounce = null;
    function startDOMObserver() {
        if (domObserverAttached) return;
        domObserverAttached = true;

        new MutationObserver(mutations => {
            if (isSorting) return;
            let hasChildMutation = false;
            for (let i = 0; i < mutations.length; i++) {
                if (mutations[i].type === 'childList') {
                    hasChildMutation = true;
                    break;
                }
            }
            if (!hasChildMutation) return;

            clearTimeout(domDebounce);
            domDebounce = setTimeout(() => {
                applyFilter();
                applySort();
                updateBubble();
            }, 80);
        }).observe(document.body, { childList: true, subtree: true });
    }

    // ─── Události ovládacích prvků ─────────────────────────────────────────────
    bubble.addEventListener('click', () => {
        panel.style.display = 'block';
        bubble.style.display = 'none';
        save(STORAGE.minimized, '0');
    });

    minimizeBtn.addEventListener('click', () => {
        panel.style.display = 'none';
        bubble.style.display = 'flex';
        save(STORAGE.minimized, '1');
    });

    // Textové vyhledávání s debounce
    let textDebounce = null;
    textInput.addEventListener('input', () => {
        textQuery = textInput.value;
        textClearBtn.style.display = textQuery ? 'block' : 'none';
        save(STORAGE.textQuery, textQuery);
        clearTimeout(textDebounce);
        textDebounce = setTimeout(() => {
            applyFilter();
            applySort();
            updateBubble();
        }, 80);
    });

    textClearBtn.addEventListener('click', () => {
        textInput.value = '';
        textQuery = '';
        textClearBtn.style.display = 'none';
        save(STORAGE.textQuery, '');
        applyFilter();
        applySort();
        updateBubble();
        textInput.focus();
    });

    // Cenový filtr
    const handlePriceChange = () => {
        const minVal = parseFloat(minPriceInput.value);
        minPrice = Number.isFinite(minVal) && minVal >= 0 ? minVal : null;
        save(STORAGE.minPrice, minPrice !== null ? minPrice : '');

        const maxVal = parseFloat(maxPriceInput.value);
        maxPrice = Number.isFinite(maxVal) && maxVal >= 0 ? maxVal : null;
        save(STORAGE.maxPrice, maxPrice !== null ? maxPrice : '');

        applyFilter();
        applySort();
        updateBubble();
    };
    minPriceInput.addEventListener('input', handlePriceChange);
    maxPriceInput.addEventListener('input', handlePriceChange);

    // Počet dávek
    batchesInput.addEventListener('change', () => {
        const parsed = parseInt(batchesInput.value, 10);
        multiLoadBatches = Number.isFinite(parsed) && parsed >= 0 ? parsed : 5;
        batchesInput.value = multiLoadBatches;
        save(STORAGE.batches, multiLoadBatches);
        updateLoadManyLabel();
    });

    // Tlačítka načítání
    loadOneBtn.addEventListener('click', () => {
        loadOneBatch();
    });
    loadManyBtn.addEventListener('click', runMultiLoad);
    stopBtn.addEventListener('click', () => {
        stopRequested = true;
    });

    // Přepínač posunu
    toggleScrollBtn.addEventListener('click', () => {
        autoScrollMode = (autoScrollMode + 1) % SCROLL_MODES.length;
        save(STORAGE.scrollMode, autoScrollMode);
        updateScrollUI();
    });

    // Přepínač řazení
    toggleSortBtn.addEventListener('click', () => {
        currentSortMode = (currentSortMode + 1) % SORT_MODES.length;
        save(STORAGE.sortMode, currentSortMode);
        updateSortUI();
        applySort();
    });

    // Hlavní přepínač filtru
    toggleFilterBtn.addEventListener('click', () => {
        filteringEnabled = !filteringEnabled;
        save(STORAGE.filterEnabled, filteringEnabled ? '1' : '0');
        updateFilterToggle();
        applyFilter();
        applySort();
        updateBubble();
    });

    // Klávesová zkratka Ctrl pro načtení další dávky (pokud uživatel nepíše do inputu)
    document.addEventListener('keydown', e => {
        const tag = document.activeElement?.tagName;
        const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
            || document.activeElement?.isContentEditable;
        if (e.key === 'Control' && !isTyping && !e.shiftKey && !e.altKey && !e.metaKey) {
            loadOneBatch();
        }
    });

    // ─── Inicializace ──────────────────────────────────────────────────────────
    function init() {
        if (!document.body) {
            setTimeout(init, 50);
            return;
        }
        if (!document.getElementById('lf-panel')) {
            (document.head || document.documentElement).appendChild(style);
            document.body.appendChild(bubble);
            document.body.appendChild(panel);
        }
        loadSavedState();
        updateFilterToggle();
        updateScrollUI();
        updateSortUI();
        startDOMObserver();
        applyFilter();
        applySort();
        updateBubble();
        setTimeout(checkForUpdate, 3000);
    }

    // Spuštění po načtení stránky a pojistka pro Single Page Application (Nuxt)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(init, 100));
    } else {
        setTimeout(init, 100);
    }

})();
