(function () {
    // ---------- INVENTORY MANAGEMENT ----------
    // The Main Ledger, Fixed (Brand & Price master config), Purchase Order, Past Day,
    // Close Day & Carry Forward, Reports, CSV export, backups, Sync via Code, Team
    // Mode, and Dark Mode. This is "the app" — everything a logged-in user actually
    // works with once login.js has let them in.

    const { saveWithRetry, loadWithRetry } = window.AppStorage;

    let rows = [];
    let loaded = false;
    let currentTab = 'ledger';
    let pendingRestoreData = null;

    const todayLabel = () => new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
    document.getElementById('dateLabel').textContent = todayLabel();



    function uid() { return 'r_' + Math.random().toString(36).slice(2, 10); }
    function blankRow() { return { id: uid(), brand: '', opening: 0, newStock: 0, sales: 0, price: 0, fixedManaged: false }; }
    function money(n) { return (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    let storageOK = true;
    let failedSaveKeys = new Set();
    let teamMode = false;
    let meta = { bartender: '', date: '' };



    let metaLoaded = false;

    async function loadMeta() {
        try {
            const res = await loadWithRetry('stock_meta', teamMode);
            const parsed = res ? JSON.parse(res.value) : null;
            meta = (parsed && typeof parsed === 'object')
                ? { bartender: parsed.bartender || '', date: parsed.date || '' }
                : { bartender: '', date: '' };
        } catch (e) {
            meta = { bartender: '', date: '' };
        }
        if (!meta.date) {
            meta.date = new Date().toISOString().slice(0, 10); // default to today
        }
        const nameEl = document.getElementById('bartenderName');
        const dateEl = document.getElementById('ledgerDate');
        if (nameEl) nameEl.value = meta.bartender;
        if (dateEl) dateEl.value = meta.date;
        metaLoaded = true;
    }

    async function saveMeta() {
        const ok = await saveWithRetry('stock_meta', JSON.stringify(meta), teamMode);
        if (ok) { failedSaveKeys.delete('stock_meta'); } else { failedSaveKeys.add('stock_meta'); }
        updateSaveBanner();
        return ok;
    }

    window.updateMeta = async function (field, value) {
        meta[field] = value;
        const ok = await saveMeta();
        flashStatus(ok ? ('SAVED ' + new Date().toLocaleTimeString()) : 'SAVE FAILED — SEE BANNER', !ok);
    };

    async function loadRows() {
        try {
            const res = await loadWithRetry('stock_rows', teamMode);
            rows = res ? JSON.parse(res.value) : null;
            if (rows === null) {
                rows = [];
            }
            storageOK = true;
        } catch (e) {
            rows = [];
            storageOK = false;
        }
        loaded = true;
        render();
    }

    async function saveRows() {
        if (!storageOK) {
            flashStatus('NOT SAVED — RESOLVE STORAGE FIRST', true);
            return;
        }
        const ok = await saveWithRetry('stock_rows', JSON.stringify(rows), teamMode);
        if (ok) { failedSaveKeys.delete('stock_rows'); } else { failedSaveKeys.add('stock_rows'); }
        updateSaveBanner();
        flashStatus(ok ? ('SAVED ' + new Date().toLocaleTimeString()) : 'SAVE FAILED — SEE BANNER', !ok);
    }

    // ---------- FIXED SECTION (Brand & Price master config) ----------
    // The Fixed section is the administrator's master list of brands and prices.
    // It is NOT a separate table — it's the source of truth that the main ledger's
    // Brand and Price columns are kept in sync with. Saving Fixed rewrites the
    // ledger's brand order/prices for the brands it lists, while carefully
    // preserving today's Opening/New/Sales numbers for any brand that still exists,
    // and never silently destroying activity on a brand that gets removed.
    let fixedConfig = []; // [{ brand, price }], one entry per column, left-to-right order preserved

    async function loadFixedConfig() {
        try {
            const res = await loadWithRetry('stock_fixed', teamMode);
            const parsed = res ? JSON.parse(res.value) : null;
            fixedConfig = Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.warn('Fixed config load failed — starting from an empty configuration', e);
            fixedConfig = [];
        }
    }


    async function openFixedEditor() {
        await loadFixedConfig();
        if (!fixedConfig || fixedConfig.length === 0) {
            fixedConfig = Array.from({ length: 4 }, () => ({ brand: '', price: '' }));
        }
        renderFixedEditor();
        const msg = document.getElementById('fixedSaveMsg');
        if (msg) msg.style.display = 'none';
        document.getElementById('fixedModal').classList.add('show');
    };

    window.closeFixedModal = function () {
        document.getElementById('fixedModal').classList.remove('show');
    };

    function renderFixedEditor() {
        const host = document.getElementById('fixedTableHost');
        if (!host) return;
        const brandCells = fixedConfig.map((c, i) => `
        <td>
          <input class="cell-input fixed-input" type="text" placeholder="Brand ${i + 1}" value="${escapeHtml(c.brand || '')}" data-col="${i}" data-field="brand" onchange="updateFixedCell(this)">
          <button type="button" class="fixed-col-remove" title="Remove this column" onclick="removeFixedColumn(${i})">✕ remove</button>
        </td>
      `).join('');
        const priceCells = fixedConfig.map((c, i) => `
        <td><input class="cell-input fixed-input" type="number" min="0" step="0.01" placeholder="0" value="${c.price === '' || c.price == null ? '' : c.price}" data-col="${i}" data-field="price" onchange="updateFixedCell(this)"></td>
      `).join('');
        host.innerHTML = `
        <table class="fixed-table">
          <tbody>
            <tr><th>Brand</th>${brandCells}</tr>
            <tr><th>Prices</th>${priceCells}</tr>
          </tbody>
        </table>
      `;
    }

    window.updateFixedCell = function (input) {
        const col = Number(input.dataset.col);
        const field = input.dataset.field;
        if (!fixedConfig[col]) return;
        if (field === 'brand') {
            fixedConfig[col].brand = input.value;
        } else {
            fixedConfig[col].price = input.value === '' ? '' : Math.max(0, Number(input.value) || 0);
        }
    };

    window.addFixedColumn = function () {
        fixedConfig.push({ brand: '', price: '' });
        renderFixedEditor();
        // Focus the newly added brand cell so the administrator can start typing immediately.
        const inputs = document.querySelectorAll('#fixedTableHost input[data-field="brand"]');
        const last = inputs[inputs.length - 1];
        if (last) last.focus();
    };

    window.removeFixedColumn = function (index) {
        const entry = fixedConfig[index];
        const label = entry && entry.brand ? `"${entry.brand}"` : 'this empty column';
        if (fixedConfig.length > 1 && !confirm(`Remove ${label} from the Fixed list? This only takes effect once you click Save.`)) return;
        fixedConfig.splice(index, 1);
        renderFixedEditor();
    };

    function showFixedSaveMsg(text, isError) {
        const msg = document.getElementById('fixedSaveMsg');
        if (!msg) return;
        msg.textContent = text;
        msg.classList.toggle('error', !!isError);
        msg.style.display = 'block';
    }

    window.saveFixedConfig = async function () {
        // 1. Read + trim brand names, skipping fully blank columns.
        const cleaned = fixedConfig
            .map(c => ({ brand: (c.brand || '').trim(), price: c.price === '' || c.price == null ? 0 : Math.max(0, Number(c.price) || 0) }))
            .filter(c => c.brand !== '');

        // 2. Reject duplicate brand names (case-insensitive) rather than silently merging them.
        const seen = new Set();
        for (const c of cleaned) {
            const key = c.brand.toLowerCase();
            if (seen.has(key)) {
                showFixedSaveMsg(`Duplicate brand "${c.brand}" — please use each brand name only once.`, true);
                return;
            }
            seen.add(key);
        }

        // 3. Brand and Price are read-only in the Main Ledger, so removing a brand from
        // this list takes it out of the active ledger entirely — not just unlocks it.
        // Previously closed/archived days (Reports, "View Past Day") are untouched by
        // this either way, since those are separate saved snapshots. What's at risk is
        // only *today's* not-yet-closed numbers for a brand being dropped, so warn and
        // require explicit confirmation before proceeding if any exist.
        const cleanedKeys = new Set(cleaned.map(c => c.brand.toLowerCase()));
        const aboutToLoseActivity = rows.filter(r => {
            const key = (r.brand || '').trim().toLowerCase();
            if (!key || cleanedKeys.has(key)) return false;
            return Number(r.opening) > 0 || Number(r.newStock) > 0 || Number(r.sales) > 0;
        });
        if (aboutToLoseActivity.length > 0) {
            const list = aboutToLoseActivity.map(r => `"${r.brand}"`).join(', ');
            const proceed = confirm(
                `${list} ${aboutToLoseActivity.length === 1 ? 'is' : 'are'} no longer in this Fixed list and ` +
                `${aboutToLoseActivity.length === 1 ? 'has' : 'have'} unsaved stock entered today (Opening/New/Sales). ` +
                `Removing them here also removes them from today's active Main Ledger — that stock entry won't be ` +
                `recoverable unless today has already been closed for them.\n\nThis does NOT affect any previously ` +
                `closed day or Reports history.\n\nRemove them anyway?`
            );
            if (!proceed) return;
        }

        // 4. Persist the full column set (including any blank columns left as placeholders)
        // so the administrator sees the same layout next time they open Fixed.
        const ok = await saveWithRetry('stock_fixed', JSON.stringify(fixedConfig), teamMode);
        if (!ok) {
            showFixedSaveMsg("Couldn't save the Fixed configuration right now — please try again.", true);
            return;
        }

        // 5. Sync the cleaned, ordered brand/price list into the main ledger.
        syncFixedToLedger(cleaned);
        await saveRows();
        render();

        showFixedSaveMsg('Fixed data saved successfully. Main Ledger updated.', false);
        flashStatus('FIXED CONFIG SAVED — LEDGER UPDATED');
    };

    function syncFixedToLedger(list) {
        // list: [{brand, price}] — trimmed, de-duplicated, in the exact order the
        // administrator entered them. This becomes the new brand order in the ledger.
        // Every active-ledger row corresponds to exactly one Fixed entry; there is no
        // other way for a row to exist here.
        const existingByKey = new Map();
        rows.forEach(r => {
            const key = (r.brand || '').trim().toLowerCase();
            if (key && !existingByKey.has(key)) existingByKey.set(key, r);
        });

        rows = list.map(entry => {
            const key = entry.brand.toLowerCase();
            const existing = existingByKey.get(key);
            if (existing) {
                // Keep existing Opening/New/Sales stock — only brand spelling and price come from Fixed.
                existing.brand = entry.brand;
                existing.price = entry.price;
                existing.fixedManaged = true;
                return existing;
            }
            const fresh = blankRow();
            fresh.brand = entry.brand;
            fresh.price = entry.price;
            fresh.fixedManaged = true;
            return fresh;
        });
        // Any row whose brand isn't in `list` is a brand that was removed from Fixed —
        // it's simply not carried into the new `rows`, so it drops out of the active
        // Main Ledger. Already-closed days keep their own separate archived copy
        // (Reports / View Past Day), which this never touches.
    }

    function updateSaveBanner() {
        const el = document.getElementById('saveWarning');
        if (!el) return;
        if (failedSaveKeys.size > 0) {
            const labels = { stock_rows: 'the ledger table', stock_meta: 'the bartender name / date', stock_daily_tables: 'the day-close archive', stock_history: 'the sales history', stock_fixed: 'the Fixed brand/price configuration' };
            const what = [...failedSaveKeys].map(k => labels[k] || k).join(', ');
            el.style.display = 'block';
            el.innerHTML = `
          <strong>Your last change to ${what} didn't save.</strong><br>
          The storage service returned an error after several attempts. Your edits are still here in this
          tab — please don't close it. If retrying keeps failing, use <strong>💾 Save Backup</strong> in the
          toolbar now to download a copy to your device, so nothing is lost even if this page closes.
          <div class="storage-warning-actions">
            <button class="btn" onclick="retrySave()">Retry Save</button>
          </div>
        `;
        } else {
            el.style.display = 'none';
        }
    }

    window.retrySave = async function () {
        flashStatus('RETRYING SAVE…');
        if (failedSaveKeys.has('stock_rows')) await saveRows();
        if (failedSaveKeys.has('stock_meta')) await saveMeta();
    };

    async function getHistory() {
        try {
            const res = await loadWithRetry('stock_history', teamMode);
            return { ok: true, data: res ? JSON.parse(res.value) : [] };
        } catch (e) {
            console.error('History read failed after retries', e);
            return { ok: false, data: [] };
        }
    }

    async function getDailyTables() {
        try {
            const res = await loadWithRetry('stock_daily_tables', teamMode);
            return { ok: true, data: res ? JSON.parse(res.value) : [] };
        } catch (e) {
            console.error('Daily tables read failed after retries', e);
            return { ok: false, data: [] };
        }
    }

    async function saveDailyTables(list) {
        return await saveWithRetry('stock_daily_tables', JSON.stringify(list), teamMode);
    }

    async function appendHistory(entry) {
        const { ok, data: hist } = await getHistory();
        let list = hist;
        if (!ok) {
            const proceed = confirm(
                "Couldn't confirm your existing sales history — this may just mean nothing's been logged yet, or it could " +
                "be a temporary connection issue. Continuing will start the history log fresh; if you've logged entries " +
                "before, this could erase them. Continue anyway?"
            );
            if (!proceed) {
                flashStatus('DAY CLOSED, BUT NOT LOGGED — HISTORY NOT CONFIRMED', true);
                return;
            }
            list = [];
        }
        list.push(entry);
        const saved = await saveWithRetry('stock_history', JSON.stringify(list), teamMode);
        if (!saved) { flashStatus('HISTORY SAVE FAILED', true); }
    }

    function flashStatus(msg, isError) {
        const el = document.getElementById('statusStamp');
        el.textContent = msg;
        el.style.borderColor = isError ? '#A63D3D' : '';
    }

    function totalOf(r) { return (Number(r.opening) || 0) + (Number(r.newStock) || 0); }
    function closingOf(r) { return totalOf(r) - (Number(r.sales) || 0); }
    function totalsOf(r) { return (Number(r.sales) || 0) * (Number(r.price) || 0); }

    // ---------- THEME ----------
    function applyTheme(theme) {
        const app = document.getElementById('app');
        const btn = document.getElementById('darkToggle');
        if (theme === 'dark') {
            app.classList.add('dark');
            if (btn) btn.textContent = '☀️ Light';
        } else {
            app.classList.remove('dark');
            if (btn) btn.textContent = '🌙 Dark';
        }
    }
    async function initTheme() {
        try {
            const res = await window.storage.get('ui_theme');
            applyTheme(res ? JSON.parse(res.value) : 'light');
        } catch (e) {
            applyTheme('light');
        }
    }
    window.toggleDarkMode = async function () {
        const app = document.getElementById('app');
        const nowDark = !app.classList.contains('dark');
        applyTheme(nowDark ? 'dark' : 'light');
        try { await window.storage.set('ui_theme', JSON.stringify(nowDark ? 'dark' : 'light')); } catch (e) { /* non-critical */ }
    };

    // ---------- TEAM MODE ----------
    // This is a browser-only app with no backend, so there's no way for it to truly
    // sync data between different people or different devices in real time. Team Mode
    // is a deliberately honest, local-only feature instead: it points all reads/writes
    // at a second storage pool (shared:true) on THIS device, separate from your
    // personal one (shared:false). That's genuinely useful for e.g. a shared till
    // computer where you want one "Team" table kept apart from personal scratch data —
    // it is NOT a substitute for real cross-device sharing. For that, use Sync via
    // Code or Save/Load Backup, which work identically regardless of Team Mode.
    // It's off by default and never turns on without a clear confirmation explaining
    // exactly what it does, since it changes which data you're looking at.
    async function initTeamMode() {
        try {
            const res = await window.storage.get('ui_team_mode');
            teamMode = res ? JSON.parse(res.value) === true : false;
        } catch (e) {
            teamMode = false;
        }
        updateTeamModeUI();
    }

    function updateTeamModeUI() {
        const banner = document.getElementById('teamModeBanner');
        const btn = document.getElementById('teamModeToggleBtn');
        if (banner) banner.style.display = teamMode ? 'flex' : 'none';
        if (btn) btn.textContent = teamMode ? '🌐 Team Mode: On' : '🌐 Team Mode: Off';
    }

    async function reloadForModeSwitch() {
        loaded = false;
        metaLoaded = false;
        await loadRows();
        await loadMeta();
    }

    window.toggleTeamMode = async function () {
        if (teamMode) {
            if (!confirm('Turn off Team Mode? You will go back to your personal table — the Team table stays exactly as it is, ready for next time.')) return;
            teamMode = false;
        } else {
            const proceed = confirm(
                "Turn on Team Mode?\n\nThis app runs entirely in your browser, so there's no server tying multiple " +
                "people or devices together automatically. What Team Mode actually does: it switches this browser to a " +
                "SECOND, separate local table (\"Team\") instead of your personal one — useful for keeping a shared " +
                "shift/bar table apart from a personal scratch table on a shared computer. Your personal table is not " +
                "deleted or merged; it's just set aside, and turning Team Mode off returns you to it exactly as you left it.\n\n" +
                "To actually move this table to another device or person, use Sync via Code or Save Backup / Load Backup " +
                "— those work the same whether Team Mode is on or off."
            );
            if (!proceed) return;
            teamMode = true;
        }
        try { await window.storage.set('ui_team_mode', JSON.stringify(teamMode)); } catch (e) { /* non-critical: this is just a personal display preference */ }
        updateTeamModeUI();
        await reloadForModeSwitch();
        flashStatus(teamMode ? 'TEAM MODE ON — VIEWING TEAM TABLE' : 'TEAM MODE OFF — VIEWING YOUR TABLE');
    };

    // ---------- TABS ----------
    window.showTab = function (tab) {
        currentTab = tab;
        document.getElementById('ledgerTab').style.display = tab === 'ledger' ? '' : 'none';
        document.getElementById('reportsTab').style.display = tab === 'reports' ? '' : 'none';
        document.getElementById('tabLedgerBtn').classList.toggle('active', tab === 'ledger');
        document.getElementById('tabReportsBtn').classList.toggle('active', tab === 'reports');
        if (tab === 'reports') renderReports();
    };

    // ---------- LEDGER RENDER ----------
    function renderSummary() {
        const withBrand = rows.filter(r => r.brand && r.brand.trim() !== '');
        const outCount = withBrand.filter(r => closingOf(r) <= 0).length;
        const salesToday = rows.reduce((s, r) => s + totalsOf(r), 0);

        const cards = [
            { label: 'Brands Listed', value: withBrand.length, cls: '' },
            { label: 'Sales Today (Ksh)', value: money(salesToday), cls: '' },
            { label: 'Out of Stock', value: outCount, cls: outCount ? 'bad' : '' },
        ];
        document.getElementById('summaryRow').innerHTML = cards.map(c => `
        <div class="sum-card ${c.cls}">
          <div class="label">${c.label}</div>
          <div class="value">${c.value}</div>
        </div>
      `).join('');
    }

    function render() {
        if (!loaded) return;
        const warnEl = document.getElementById('storageWarning');

        if (!storageOK) {
            warnEl.style.display = 'block';
            warnEl.innerHTML = `
          <strong>Couldn't confirm your saved stock data.</strong><br>
          This can happen on a connection hiccup, and we don't want to guess — assuming "empty" here
          could overwrite a ledger you've already saved. If this is the first time you've seen this,
          try Retry. If it keeps happening, the storage service itself may be temporarily down — that's
          outside what this page can fix on its own, but you can still work below and keep your data safe
          with regular backups until it's resolved.
          <div class="storage-warning-actions">
            <button class="btn" onclick="retryLoad()">Retry Loading</button>
            <button class="btn ghost" onclick="confirmFreshStart()">Continue anyway (I'll back up manually)</button>
          </div>
        `;
            document.getElementById('tableHost').innerHTML = '';
            document.getElementById('summaryRow').innerHTML = '';
            document.getElementById('rowCountLabel').textContent = '';
            return;
        }
        warnEl.style.display = 'none';

        renderSummary();

        document.getElementById('rowCountLabel').textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} total`;

        const host = document.getElementById('tableHost');
        if (rows.length === 0) {
            host.innerHTML = `<div style="padding:40px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--ink-soft);">
          No brands configured yet.<br><br>
          Open <strong>⚙ Fixed</strong> above and add your brand list and prices — the Main Ledger fills in
          automatically once you save.
        </div>`;
            return;
        }

        const q = (document.getElementById('searchBox').value || '').toLowerCase().trim();
        const numbered = rows.map((r, i) => ({ r, no: i + 1 }));
        const filtered = q ? numbered.filter(x => (x.r.brand || '').toLowerCase().includes(q)) : numbered;

        if (filtered.length === 0) {
            host.innerHTML = `<div style="padding:30px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--ink-soft);">No brands match "${q}".</div>`;
            return;
        }

        const closeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.5-7.1"/><path d="M21 3v6h-6"/></svg>`;

        const bodyRows = filtered.map(({ r, no }) => {
            const total = totalOf(r);
            const closing = closingOf(r);
            const totals = totalsOf(r);
            const outOfStock = closing <= 0;
            const rowCls = outOfStock ? 'row-out' : '';
            const stamp = outOfStock
                ? `<span class="stamp out">Out of Stock</span>`
                : `<span class="stamp ok">In Stock</span>`;

            // Brand and Price are always read-only here — they're display-only values
            // owned by the Fixed section. There is no input, no onchange handler, and
            // no way to type into these cells; the only way to change a brand name or
            // price is to open Fixed, edit it there, and save.
            const brandCell = `<span class="fixed-cell" title="Brand is set in the Fixed section — edit it there">${escapeHtml(r.brand)}<span class="fixed-badge" aria-hidden="true">🔒</span></span>`;
            const priceCell = `<span class="fixed-cell" title="Price is set in the Fixed section — edit it there">${money(r.price)}<span class="fixed-badge" aria-hidden="true">🔒</span></span>`;

            return `
          <tr data-id="${r.id}" class="${rowCls}">
            <td class="center no-cell" data-label="No.">${no}</td>
            <td data-label="Brand">${brandCell}</td>
            <td class="num" data-label="Opening Stock"><input class="cell-input" type="number" min="0" value="${r.opening}" onchange="updateField('${r.id}','opening',this.value)"></td>
            <td class="num" data-label="New Stock"><input class="cell-input" type="number" min="0" value="${r.newStock}" onchange="updateField('${r.id}','newStock',this.value)"></td>
            <td class="num" data-label="Total Stock"><span class="computed-val">${total}</span></td>
            <td class="num" data-label="Closing Stock"><span class="computed-val">${closing}</span></td>
            <td class="num sales-cell" data-label="Sales Stock">
              <input class="cell-input sales-total-input" type="number" min="0" value="${r.sales}" onchange="updateField('${r.id}','sales',this.value)">
              <div class="quick-add-wrap">
                <input class="cell-input quick-add-input" type="number" min="0" placeholder="+ add sale" id="saleAdd_${r.id}" onkeydown="if(event.key==='Enter'){event.preventDefault();addSale('${r.id}');}">
                <button class="icon-btn" title="Add this sale to the running total" onclick="addSale('${r.id}')">+</button>
                <button class="icon-btn danger" title="Reset sales to 0" onclick="resetSales('${r.id}')">↺</button>
              </div>
            </td>
            <td class="num" data-label="Price (Ksh)">${priceCell}</td>
            <td class="num" data-label="Totals"><span class="computed-val">${money(totals)}</span><span class="computed-sub">Ksh</span></td>
            <td class="center" data-label="Status">${stamp}</td>
            <td class="center" data-label="Actions">
              <div class="row-actions">
                <button class="icon-btn" title="Close day &amp; carry forward" onclick="closeDay('${r.id}')">${closeIcon}</button>
              </div>
            </td>
          </tr>
        `;
        }).join('');

        host.innerHTML = `
        <table>
          <thead>
            <tr>
              <th class="center" style="width:44px;">No.</th>
              <th>Brand</th>
              <th class="num">Opening Stock</th>
              <th class="num">New Stock</th>
              <th class="num">Total Stock</th>
              <th class="num">Closing Stock</th>
              <th class="num">Sales Stock</th>
              <th class="num">Price (Ksh)</th>
              <th class="num">Totals</th>
              <th class="center">Status</th>
              <th class="center">Actions</th>
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      `;
    }

    window.updateField = function (id, field, value) {
        const r = rows.find(x => x.id === id);
        if (!r) return;
        if (field === 'brand' || field === 'price') {
            // Brand and Price are controlled entirely by the Fixed section. There is no
            // UI path that calls this with those fields, but the guard stays here as an
            // explicit rule rather than relying on the absence of an input element.
            return;
        }
        r[field] = Math.max(0, Number(value) || 0);
        saveRows();
        render();
    };

    window.addSale = function (id) {
        const r = rows.find(x => x.id === id);
        if (!r) return;
        const input = document.getElementById('saleAdd_' + id);
        if (!input) return;
        const amount = Number(input.value);
        if (!amount || amount <= 0) {
            input.focus();
            return;
        }
        r.sales = (Number(r.sales) || 0) + amount;
        saveRows();
        render();
        flashStatus(`+${amount} SALE ADDED — ${r.brand || 'row'}`);
        // Keep focus in the quick-add box for the next buyer, ready for the next entry.
        setTimeout(() => {
            const nextInput = document.getElementById('saleAdd_' + id);
            if (nextInput) nextInput.focus();
        }, 0);
    };

    window.resetSales = function (id) {
        const r = rows.find(x => x.id === id);
        if (!r) return;
        if (!Number(r.sales)) return;
        if (!confirm(`Reset sales stock for "${r.brand || 'this row'}" back to 0? This can't be undone.`)) return;
        r.sales = 0;
        saveRows();
        render();
        flashStatus('SALES RESET — ' + (r.brand || 'row'));
    };

    window.closeDay = async function (id) {
        const r = rows.find(x => x.id === id);
        if (!r) return;
        const closing = closingOf(r);
        await appendHistory({
            rowId: r.id, brand: r.brand, date: new Date().toISOString(),
            opening: r.opening, newStock: r.newStock, sales: r.sales, closing,
            price: r.price, totals: totalsOf(r)
        });
        r.opening = closing;
        r.newStock = 0;
        r.sales = 0;
        saveRows();
        render();
        flashStatus('DAY CLOSED — ' + (r.brand || 'row'));
    };

    let pendingCloseDayDate = null;

    window.closeAllDays = async function () {
        if (rows.length === 0) return;
        await attemptCloseDay(false);
    };

    window.retryCloseDay = async function () {
        document.getElementById('archiveFailModal').classList.remove('show');
        await attemptCloseDay(false);
    };

    window.proceedCloseDayAnyway = async function () {
        document.getElementById('archiveFailModal').classList.remove('show');
        await attemptCloseDay(true);
    };

    window.cancelCloseDay = function () {
        document.getElementById('archiveFailModal').classList.remove('show');
    };

    async function attemptCloseDay(skipArchiveConfirmation) {
        // Archive today's full table as a snapshot before touching it — this is what
        // "View Past Day" reads from. Gated the same cautious way as everything else
        // that writes: if we can't confirm what's already archived, don't silently
        // overwrite it — offer a clear, explicit choice instead of just blocking.
        const archiveDate = (meta.date && meta.date.trim()) || new Date().toISOString().slice(0, 10);
        let dailyTables;
        if (skipArchiveConfirmation) {
            dailyTables = [];
        } else {
            const { ok: archiveReadOk, data } = await getDailyTables();
            if (!archiveReadOk) {
                pendingCloseDayDate = archiveDate;
                document.getElementById('archiveFailModal').classList.add('show');
                return;
            }
            dailyTables = data;
        }

        const snapshot = {
            date: archiveDate,
            bartender: meta.bartender || '',
            rows: JSON.parse(JSON.stringify(rows)),
            closedAt: new Date().toISOString()
        };
        const updatedTables = dailyTables.filter(t => t.date !== archiveDate);
        updatedTables.push(snapshot);
        const archiveSaved = await saveDailyTables(updatedTables);
        if (!archiveSaved) {
            flashStatus('DAY NOT CLOSED — ARCHIVE SAVE FAILED', true);
            return;
        }

        // Log each row to the sales-history trend log, then carry stock forward.
        // Batched into one read/write for the whole action (not per row) so a read
        // failure only ever asks once, instead of once per row in the table.
        const { ok: histReadOk, data: histData } = await getHistory();
        let hist = histReadOk ? histData : null;
        if (!histReadOk) {
            const proceed = confirm(
                "Couldn't confirm your existing sales history — this may just mean nothing's been logged yet, or it could " +
                "be a temporary connection issue. Continuing will start the history log fresh; if you've logged entries " +
                "before, this could erase them.\n\nContinue logging history for this close? (Choosing Cancel still closes " +
                "the day and moves stock forward — it just skips the history log entry this time.)"
            );
            hist = proceed ? [] : null;
        }
        for (const r of rows) {
            const closing = closingOf(r);
            if (hist !== null) {
                hist.push({
                    rowId: r.id, brand: r.brand, date: new Date().toISOString(),
                    opening: r.opening, newStock: r.newStock, sales: r.sales, closing,
                    price: r.price, totals: totalsOf(r)
                });
            }
            r.opening = closing;
            r.newStock = 0;
            r.sales = 0;
        }
        if (hist !== null) {
            const histSaved = await saveWithRetry('stock_history', JSON.stringify(hist), teamMode);
            if (!histSaved) { flashStatus('HISTORY SAVE FAILED', true); }
        }

        // Advance the working date to the next day, ready for the new table.
        const nextDate = new Date(archiveDate + 'T00:00:00');
        nextDate.setDate(nextDate.getDate() + 1);
        meta.date = nextDate.toISOString().slice(0, 10);
        const dateEl = document.getElementById('ledgerDate');
        if (dateEl) dateEl.value = meta.date;
        saveMeta();

        saveRows();
        render();
        flashStatus(`${archiveDate} ARCHIVED — NEW TABLE STARTED FOR ${meta.date}`);
    };

    window.exportCSV = function () {
        const metaLines = `"Bartender","${(meta.bartender || '').replace(/"/g, '""')}"\n"Date","${(meta.date || '').replace(/"/g, '""')}"\n\n`;
        const header = 'No.,Brand,Opening Stock,New Stock,Total Stock,Closing Stock,Sales Stock,Price (Ksh),Totals,Status\n';
        const lines = rows.map((r, i) => {
            const total = totalOf(r);
            const closing = closingOf(r);
            const totals = totalsOf(r);
            const status = closing <= 0 ? 'Out of Stock' : 'In Stock';
            return [i + 1, r.brand, r.opening, r.newStock, total, closing, r.sales, r.price, totals.toFixed(2), status]
                .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
        });
        const csv = metaLines + header + lines.join('\n');
        downloadBlob(csv, 'text/csv', 'stock_ledger_' + new Date().toISOString().slice(0, 10) + '.csv');
    };

    function downloadBlob(content, type, filename) {
        const blob = new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    window.retryLoad = function () {
        loaded = false;
        loadRows();
    };

    window.confirmFreshStart = function () {
        storageOK = true;
        rows = [];
        render();
        flashStatus('STARTED FRESH — NOT YET SAVED');
    };

    // ---------- PURCHASE ORDER ----------
    function renderPOTable() {
        const list = rows.filter(r => r.brand && r.brand.trim() !== '' && closingOf(r) <= 0);
        const host = document.getElementById('poTableHost');
        if (list.length === 0) {
            host.innerHTML = `<div style="padding:20px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--ink-soft);">Nothing is out of stock right now — no purchase order needed.</div>`;
            return;
        }
        const rowsHtml = list.map(r => `
        <tr>
          <td style="font-family:'IBM Plex Sans',sans-serif;font-weight:600;padding:8px;">${escapeHtml(r.brand)}</td>
          <td class="num" style="padding:8px;">Ksh ${money(r.price)}</td>
          <td class="num" style="padding:8px;"><input type="number" min="0" class="cell-input" id="po_qty_${r.id}" data-price="${r.price}" value="0" style="width:90px;" oninput="updatePOCost('${r.id}')"></td>
          <td class="num" style="padding:8px;" id="po_cost_${r.id}">Ksh 0</td>
        </tr>
      `).join('');
        host.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:13px;">
          <thead><tr style="background:var(--navy);color:var(--cream-white);">
            <th style="text-align:left;padding:8px;">Brand</th>
            <th style="text-align:right;padding:8px;">Price</th>
            <th style="text-align:right;padding:8px;">Order Qty</th>
            <th style="text-align:right;padding:8px;">Est. Cost</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      `;
    }
    window.updatePOCost = function (id) {
        const input = document.getElementById('po_qty_' + id);
        const price = Number(input.dataset.price) || 0;
        const qty = Number(input.value) || 0;
        document.getElementById('po_cost_' + id).textContent = 'Ksh ' + money(qty * price);
    };
    window.openPOModal = function () {
        renderPOTable();
        document.getElementById('poModal').classList.add('show');
    };
    window.closePOModal = function () {
        document.getElementById('poModal').classList.remove('show');
    };

    // ---------- VIEW PAST DAY ----------
    window.openPastDayModal = function () {
        document.getElementById('pastDayTableHost').innerHTML = `<div style="padding:20px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--ink-soft);">Pick a date above and click Load.</div>`;
        document.getElementById('pastDayModal').classList.add('show');
    };

    window.closePastDayModal = function () {
        document.getElementById('pastDayModal').classList.remove('show');
    };

    window.loadPastDay = async function () {
        const dateVal = document.getElementById('pastDayInput').value;
        const host = document.getElementById('pastDayTableHost');
        if (!dateVal) {
            host.innerHTML = `<div style="padding:20px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--ink-soft);">Pick a date first.</div>`;
            return;
        }
        host.innerHTML = `<div style="padding:20px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--ink-soft);">Loading…</div>`;
        const { ok, data: dailyTables } = await getDailyTables();
        if (!ok) {
            host.innerHTML = `
          <div class="storage-warning" style="display:block;margin:0;">
            <strong>Couldn't load past tables right now.</strong><br>
            This looks like a temporary connection issue.
            <div class="storage-warning-actions">
              <button class="btn" onclick="loadPastDay()">Retry</button>
            </div>
          </div>`;
            return;
        }
        const match = dailyTables.find(t => t.date === dateVal);
        if (!match) {
            host.innerHTML = `<div style="padding:20px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--ink-soft);">No archived table found for ${dateVal}. A table gets archived automatically when you click "Close Day &amp; Carry Forward" on that date.</div>`;
            return;
        }
        const withBrand = match.rows.filter(r => r.brand && r.brand.trim() !== '');
        if (withBrand.length === 0) {
            host.innerHTML = `<div style="padding:20px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--ink-soft);">That day's table has no brands recorded.</div>`;
            return;
        }
        const bodyRows = withBrand.map((r, i) => {
            const total = (Number(r.opening) || 0) + (Number(r.newStock) || 0);
            const closing = total - (Number(r.sales) || 0);
            const totals = (Number(r.sales) || 0) * (Number(r.price) || 0);
            const status = closing <= 0 ? 'Out of Stock' : 'In Stock';
            return `
          <tr>
            <td style="padding:8px;">${i + 1}</td>
            <td style="padding:8px;font-weight:600;">${escapeHtml(r.brand)}</td>
            <td class="num" style="padding:8px;">${r.opening}</td>
            <td class="num" style="padding:8px;">${r.newStock}</td>
            <td class="num" style="padding:8px;">${total}</td>
            <td class="num" style="padding:8px;">${closing}</td>
            <td class="num" style="padding:8px;">${r.sales}</td>
            <td class="num" style="padding:8px;">${money(r.price)}</td>
            <td class="num" style="padding:8px;">${money(totals)}</td>
            <td class="center" style="padding:8px;">${status}</td>
          </tr>`;
        }).join('');
        host.innerHTML = `
        <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--ink-soft);margin-bottom:8px;">
          Bartender: <strong style="color:var(--ink);">${escapeHtml(match.bartender || '—')}</strong>
          &nbsp;·&nbsp; Closed: ${new Date(match.closedAt).toLocaleString()}
        </div>
        <table style="width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:12px;">
          <thead><tr style="background:var(--navy);color:var(--cream-white);">
            <th style="text-align:left;padding:8px;">No.</th>
            <th style="text-align:left;padding:8px;">Brand</th>
            <th style="text-align:right;padding:8px;">Opening</th>
            <th style="text-align:right;padding:8px;">New</th>
            <th style="text-align:right;padding:8px;">Total</th>
            <th style="text-align:right;padding:8px;">Closing</th>
            <th style="text-align:right;padding:8px;">Sales</th>
            <th style="text-align:right;padding:8px;">Price</th>
            <th style="text-align:right;padding:8px;">Totals</th>
            <th style="text-align:center;padding:8px;">Status</th>
          </tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      `;
    };

    window.printPurchaseOrder = function () {
        const list = rows.filter(r => r.brand && r.brand.trim() !== '' && closingOf(r) <= 0);
        if (list.length === 0) return;
        let grand = 0;
        const lines = list.map(r => {
            const input = document.getElementById('po_qty_' + r.id);
            const qty = input ? Number(input.value) || 0 : 0;
            const cost = qty * (Number(r.price) || 0);
            grand += cost;
            return `<tr>
          <td style="padding:6px 10px;border-bottom:1px solid #ccc;">${escapeHtml(r.brand)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #ccc;text-align:right;">${money(r.price)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #ccc;text-align:right;">${qty}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #ccc;text-align:right;">${money(cost)}</td>
        </tr>`;
        }).join('');
        document.getElementById('poPrintArea').innerHTML = `
        <div style="font-family:'IBM Plex Sans',sans-serif;color:#111;padding:24px;">
          <h2 style="font-family:'Roboto Slab',serif;margin-bottom:2px;">Purchase Order</h2>
          <div style="font-size:12px;color:#555;margin-bottom:16px;">Generated ${new Date().toLocaleString()}</div>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead><tr>
              <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #111;">Brand</th>
              <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #111;">Price (Ksh)</th>
              <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #111;">Qty</th>
              <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #111;">Est. Cost (Ksh)</th>
            </tr></thead>
            <tbody>${lines}</tbody>
            <tfoot><tr>
              <td colspan="3" style="text-align:right;padding:10px;font-weight:700;">Grand Total</td>
              <td style="text-align:right;padding:10px;font-weight:700;">Ksh ${money(grand)}</td>
            </tr></tfoot>
          </table>
        </div>
      `;
        document.getElementById('poPrintArea').classList.add('active');
        window.print();
    };

    // ---------- PRINT LEDGER ----------
    window.printLedger = function () {
        const withBrand = rows
            .map((r, i) => ({ r, no: i + 1 }))
            .filter(x => x.r.brand && x.r.brand.trim() !== '');
        const lines = withBrand.map(({ r, no }) => {
            const total = totalOf(r), closing = closingOf(r), totals = totalsOf(r);
            const status = closing <= 0 ? 'Out of Stock' : 'In Stock';
            return `<tr>
          <td style="padding:5px 8px;border-bottom:1px solid #ccc;text-align:center;">${no}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #ccc;">${escapeHtml(r.brand)}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #ccc;text-align:right;">${r.opening}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #ccc;text-align:right;">${r.newStock}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #ccc;text-align:right;">${total}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #ccc;text-align:right;">${closing}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #ccc;text-align:right;">${r.sales}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #ccc;text-align:right;">${money(r.price)}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #ccc;text-align:right;">${money(totals)}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #ccc;text-align:center;">${status}</td>
        </tr>`;
        }).join('');
        document.getElementById('ledgerPrintArea').innerHTML = `
        <div style="font-family:'IBM Plex Sans',sans-serif;color:#111;padding:24px;">
          <h2 style="font-family:'Roboto Slab',serif;margin-bottom:2px;">Stock Ledger</h2>
          <div style="font-size:12px;color:#555;margin-bottom:4px;">${todayLabel()}</div>
          <div style="font-size:12px;color:#555;margin-bottom:16px;">Bartender: ${escapeHtml(meta.bartender || '—')} &nbsp;|&nbsp; Date: ${escapeHtml(meta.date || '—')}</div>
          <table style="width:100%;border-collapse:collapse;font-size:11.5px;">
            <thead><tr>
              <th style="text-align:center;padding:5px 8px;border-bottom:2px solid #111;">No.</th>
              <th style="text-align:left;padding:5px 8px;border-bottom:2px solid #111;">Brand</th>
              <th style="text-align:right;padding:5px 8px;border-bottom:2px solid #111;">Opening</th>
              <th style="text-align:right;padding:5px 8px;border-bottom:2px solid #111;">New</th>
              <th style="text-align:right;padding:5px 8px;border-bottom:2px solid #111;">Total</th>
              <th style="text-align:right;padding:5px 8px;border-bottom:2px solid #111;">Closing</th>
              <th style="text-align:right;padding:5px 8px;border-bottom:2px solid #111;">Sales</th>
              <th style="text-align:right;padding:5px 8px;border-bottom:2px solid #111;">Price</th>
              <th style="text-align:right;padding:5px 8px;border-bottom:2px solid #111;">Totals</th>
              <th style="text-align:center;padding:5px 8px;border-bottom:2px solid #111;">Status</th>
            </tr></thead>
            <tbody>${lines}</tbody>
          </table>
        </div>
      `;
        document.getElementById('ledgerPrintArea').classList.add('active');
        window.print();
    };

    window.addEventListener('afterprint', function () {
        document.getElementById('poPrintArea').classList.remove('active');
        document.getElementById('poPrintArea').innerHTML = '';
        document.getElementById('ledgerPrintArea').classList.remove('active');
        document.getElementById('ledgerPrintArea').innerHTML = '';
    });

    // ---------- BACKUP / RESTORE ----------
    window.saveBackup = async function () {
        const { ok, data: hist } = await getHistory();
        if (!ok) {
            alert("Couldn't read your history right now, so a backup wasn't created — a backup missing your history would look complete but wouldn't be. Please try again in a moment.");
            return;
        }
        await loadFixedConfig();
        const payload = { exportedAt: new Date().toISOString(), rows, history: hist, fixedConfig };
        downloadBlob(JSON.stringify(payload, null, 2), 'application/json', 'stock_ledger_backup_' + new Date().toISOString().slice(0, 10) + '.json');
    };

    window.triggerLoadBackup = function () {
        document.getElementById('backupFileInput').click();
    };

    window.handleBackupFile = function (evt) {
        const file = evt.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const parsed = JSON.parse(e.target.result);
                if (!parsed || !Array.isArray(parsed.rows)) {
                    alert("This file doesn't look like a valid stock ledger backup.");
                    return;
                }
                pendingRestoreData = parsed;
                document.getElementById('restoreConfirmModal').classList.add('show');
            } catch (err) {
                alert("Could not read that file — make sure it's a valid backup .json file.");
            }
        };
        reader.readAsText(file);
        evt.target.value = '';
    };

    window.cancelRestore = function () {
        pendingRestoreData = null;
        document.getElementById('restoreConfirmModal').classList.remove('show');
    };

    window.confirmRestore = async function () {
        if (!pendingRestoreData) return;
        rows = pendingRestoreData.rows;
        const hist = Array.isArray(pendingRestoreData.history) ? pendingRestoreData.history : [];
        const restoredFixed = Array.isArray(pendingRestoreData.fixedConfig) ? pendingRestoreData.fixedConfig : null;
        const rowsOk = await saveWithRetry('stock_rows', JSON.stringify(rows), teamMode);
        const histOk = await saveWithRetry('stock_history', JSON.stringify(hist), teamMode);
        let fixedOk = true;
        if (restoredFixed) {
            fixedConfig = restoredFixed;
            fixedOk = await saveWithRetry('stock_fixed', JSON.stringify(fixedConfig), teamMode);
        }
        if (rowsOk) { failedSaveKeys.delete('stock_rows'); } else { failedSaveKeys.add('stock_rows'); }
        if (histOk) { failedSaveKeys.delete('stock_history'); } else { failedSaveKeys.add('stock_history'); }
        if (restoredFixed) { if (fixedOk) { failedSaveKeys.delete('stock_fixed'); } else { failedSaveKeys.add('stock_fixed'); } }
        updateSaveBanner();
        pendingRestoreData = null;
        document.getElementById('restoreConfirmModal').classList.remove('show');
        render();
        if (rowsOk && histOk && fixedOk) {
            flashStatus('BACKUP RESTORED');
        } else {
            flashStatus('RESTORE INCOMPLETE — SEE BANNER', true);
        }
    };

    // ---------- SYNC VIA CODE ----------
    // A lighter-weight alternative to Save/Load Backup for quick device-to-device
    // transfer: carries just the live table + bartender/date (not history or day
    // archives) as a copy-pasteable text code, useful where downloading a file is
    // awkward but pasting text isn't.
    let pendingSyncData = null;

    window.openSyncModal = function () {
        document.getElementById('syncCodeOutput').style.display = 'none';
        document.getElementById('pasteSyncInput').value = '';
        document.getElementById('syncModal').classList.add('show');
    };

    window.closeSyncModal = function () {
        document.getElementById('syncModal').classList.remove('show');
    };

    window.copySyncCode = async function () {
        await loadFixedConfig();
        const payload = { rows, meta, fixedConfig };
        const code = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
        const outputEl = document.getElementById('syncCodeOutput');
        outputEl.style.display = 'block';
        outputEl.value = code;
        try {
            if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard API unavailable');
            await navigator.clipboard.writeText(code);
            flashStatus('SYNC CODE COPIED — PASTE IT ON THE OTHER DEVICE');
        } catch (e) {
            flashStatus('COULD NOT AUTO-COPY — SELECT THE CODE BELOW MANUALLY', true);
            outputEl.focus();
            outputEl.select();
        }
    };

    window.loadSyncCode = function () {
        const input = document.getElementById('pasteSyncInput');
        const raw = (input.value || '').trim();
        if (!raw) return;
        try {
            const json = decodeURIComponent(escape(atob(raw)));
            const payload = JSON.parse(json);
            if (!payload || !Array.isArray(payload.rows)) {
                alert("That code doesn't look valid — please check you copied the whole thing.");
                return;
            }
            pendingSyncData = payload;
            document.getElementById('syncConfirmModal').classList.add('show');
        } catch (e) {
            alert("That code doesn't look valid — please check you copied the whole thing.");
        }
    };

    window.cancelSyncRestore = function () {
        pendingSyncData = null;
        document.getElementById('syncConfirmModal').classList.remove('show');
    };

    window.confirmSyncRestore = async function () {
        if (!pendingSyncData) return;
        rows = pendingSyncData.rows;
        if (pendingSyncData.meta && typeof pendingSyncData.meta === 'object') {
            meta = {
                bartender: pendingSyncData.meta.bartender || '',
                date: pendingSyncData.meta.date || meta.date
            };
            const nameEl = document.getElementById('bartenderName');
            const dateEl = document.getElementById('ledgerDate');
            if (nameEl) nameEl.value = meta.bartender;
            if (dateEl) dateEl.value = meta.date;
        }
        const restoredFixed = Array.isArray(pendingSyncData.fixedConfig) ? pendingSyncData.fixedConfig : null;
        const rowsOk = await saveWithRetry('stock_rows', JSON.stringify(rows), teamMode);
        const metaOk = await saveWithRetry('stock_meta', JSON.stringify(meta), teamMode);
        let fixedOk = true;
        if (restoredFixed) {
            fixedConfig = restoredFixed;
            fixedOk = await saveWithRetry('stock_fixed', JSON.stringify(fixedConfig), teamMode);
        }
        if (rowsOk) { failedSaveKeys.delete('stock_rows'); } else { failedSaveKeys.add('stock_rows'); }
        if (metaOk) { failedSaveKeys.delete('stock_meta'); } else { failedSaveKeys.add('stock_meta'); }
        if (restoredFixed) { if (fixedOk) { failedSaveKeys.delete('stock_fixed'); } else { failedSaveKeys.add('stock_fixed'); } }
        updateSaveBanner();
        pendingSyncData = null;
        document.getElementById('syncConfirmModal').classList.remove('show');
        document.getElementById('syncModal').classList.remove('show');
        document.getElementById('pasteSyncInput').value = '';
        render();
        flashStatus((rowsOk && metaOk && fixedOk) ? 'SYNCED FROM CODE' : 'SYNC INCOMPLETE — SEE BANNER', !(rowsOk && metaOk && fixedOk));
    };

    // ---------- REPORTS ----------
    window.toggleReportViewMode = function () {
        const mode = document.getElementById('rptViewSelect').value;
        document.getElementById('rptMonthWrap').style.display = mode === 'month' ? 'flex' : 'none';
        renderReports();
    };

    window.renderReports = async function () {
        const { ok, data: hist } = await getHistory();
        if (!ok) {
            document.getElementById('rptSummaryRow').innerHTML = '';
            document.getElementById('rptTableHost').innerHTML = `
          <div class="storage-warning" style="display:block;margin:0;">
            <strong>Couldn't load your history right now.</strong><br>
            This looks like a temporary connection issue.
            <div class="storage-warning-actions">
              <button class="btn" onclick="renderReports()">Retry</button>
            </div>
          </div>
        `;
            return;
        }
        const mode = document.getElementById('rptViewSelect').value;
        let filtered = hist;
        if (mode === 'month') {
            const monthVal = document.getElementById('rptMonthInput').value;
            if (monthVal) {
                filtered = hist.filter(h => (h.date || '').slice(0, 7) === monthVal);
            }
        }
        const totalSales = filtered.reduce((s, h) => s + (Number(h.totals) || 0), 0);

        document.getElementById('rptSummaryRow').innerHTML = `
        <div class="sum-card"><div class="label">Entries Logged</div><div class="value">${filtered.length}</div></div>
        <div class="sum-card"><div class="label">Sales (Ksh)</div><div class="value">${money(totalSales)}</div></div>
      `;

        const sorted = [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date));
        const host = document.getElementById('rptTableHost');
        if (sorted.length === 0) {
            host.innerHTML = `<div style="padding:30px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--ink-soft);">No day-close history yet. Use "Close Day" on the Ledger tab to start logging.</div>`;
            return;
        }
        const rowsHtml = sorted.map(h => `
        <tr>
          <td data-label="Date">${new Date(h.date).toLocaleDateString()}</td>
          <td data-label="Brand">${escapeHtml(h.brand || '')}</td>
          <td class="num" data-label="Opening">${h.opening}</td>
          <td class="num" data-label="New">${h.newStock}</td>
          <td class="num" data-label="Sales">${h.sales}</td>
          <td class="num" data-label="Closing">${h.closing}</td>
          <td class="num" data-label="Price">${money(h.price)}</td>
          <td class="num" data-label="Totals">${money(h.totals)}</td>
        </tr>
      `).join('');
        host.innerHTML = `
        <table>
          <thead><tr>
            <th>Date</th><th>Brand</th><th class="num">Opening</th><th class="num">New</th>
            <th class="num">Sales</th><th class="num">Closing</th><th class="num">Price</th>
            <th class="num">Totals</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      `;
    };

    window.exportHistoryCSV = async function () {
        const { ok, data: hist } = await getHistory();
        if (!ok) {
            alert("Couldn't load your history right now, so nothing was exported. Please try again in a moment.");
            return;
        }
        const header = 'Date,Brand,Opening,New Stock,Sales,Closing,Price (Ksh),Totals\n';
        const lines = hist.map(h => [new Date(h.date).toLocaleString(), h.brand, h.opening, h.newStock, h.sales, h.closing, h.price, (Number(h.totals) || 0).toFixed(2)]
            .map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
        const csv = header + lines.join('\n');
        downloadBlob(csv, 'text/csv', 'stock_history_' + new Date().toISOString().slice(0, 10) + '.csv');
    };

    document.getElementById('searchBox').addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });

    window.addEventListener('beforeunload', function (e) {
        if (failedSaveKeys.size > 0) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    // ---------- LOGIN GATE ----------
    // NOTE: this is a soft access screen only. There is no server-side check, so a
    // determined person could still view the page's source. What this DOES do:
    // the password itself is never stored — only a salted SHA-256 hash of it — so
    // a casual glance at storage/source doesn't hand someone the actual password.

    window.render = render;


    // Called by login.js right after a successful login, so the ledger's bartender
    // field can be pre-filled without login.js having to touch `meta` directly.
    function prefillBartenderIfEmpty(username) {
        if (metaLoaded && (!meta.bartender || !meta.bartender.trim())) {
            meta.bartender = username;
            const nameEl = document.getElementById('bartenderName');
            if (nameEl) nameEl.value = username;
            saveMeta();
        }
    }

    window.AppInventory = { flashStatus, openFixedEditor, prefillBartenderIfEmpty };

    async function initApp() {
        // Login form first — it's the very first thing the user sees.
        await window.AppLogin.loadLoginCreds().catch(function (e) {
            console.error('Login state load crashed unexpectedly', e);
        });

        // Team Mode preference next — must resolve before loading rows/meta/history,
        // since it decides which storage pool (personal or team) those reads use.
        await initTeamMode().catch(e => console.warn('Team Mode init failed (non-critical, defaults to off)', e));

        // Load the stock rows next — this is the data that matters most,
        // and it renders the table (or the retry banner) as soon as it resolves.
        await loadRows().catch(function (e) {
            console.error('Loading crashed unexpectedly', e);
            const host = document.getElementById('tableHost');
            if (host) {
                host.innerHTML = `<div style="padding:40px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--margin-red);">
            Something went wrong while loading (${escapeHtml(e && e.message ? e.message : String(e))}).<br>
            Please try refreshing the page.
          </div>`;
            }
        });

        await loadMeta().catch(e => console.warn('Meta init failed (non-critical)', e));
        await initTheme().catch(e => console.warn('Theme init failed (non-critical)', e));
    }

    initApp();
})();