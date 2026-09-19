(function () {
    // ---------- LOCAL STORAGE ADAPTER ----------
    // This app is written against a small key/value storage interface
    // (window.storage.get/set/delete/list, each returning a Promise) rather than
    // calling localStorage directly everywhere. That keeps every read/write in one
    // place, makes "shared" vs "personal" data an explicit parameter instead of a
    // scattered convention, and matches the shape a real backend would have if one
    // were ever added later.
    //
    // On a real device with only one browser, "shared" (Team Mode) storage is NOT
    // actually shared with anyone else — there is no server here. It's a second,
    // separate local data pool on THIS device, used so Team Mode can be a genuine,
    // honest feature (a second table you can flip between) without pretending to
    // sync across people or devices. Real cross-device sharing is what Sync via
    // Code and Save/Load Backup are for.
    const STORAGE_PREFIX = 'stockLedger::v1::';
    function storageKey(key, shared) {
        return STORAGE_PREFIX + (shared ? 'team::' : 'me::') + key;
    }
    window.storage = {
        get(key, shared = false) {
            return new Promise((resolve, reject) => {
                try {
                    const raw = localStorage.getItem(storageKey(key, shared));
                    if (raw === null) {
                        reject(new Error('Key not found: ' + key));
                        return;
                    }
                    resolve({ key, value: raw, shared });
                } catch (e) {
                    reject(e);
                }
            });
        },
        set(key, value, shared = false) {
            return new Promise((resolve, reject) => {
                try {
                    localStorage.setItem(storageKey(key, shared), value);
                    resolve({ key, value, shared });
                } catch (e) {
                    // Most commonly a quota-exceeded error. Surfaced to the caller so the
                    // app's existing "save failed" banners/retry logic handle it honestly
                    // instead of silently losing data.
                    reject(e);
                }
            });
        },
        delete(key, shared = false) {
            return new Promise((resolve) => {
                localStorage.removeItem(storageKey(key, shared));
                resolve({ key, deleted: true, shared });
            });
        },
        list(prefix = '', shared = false) {
            return new Promise((resolve) => {
                const base = STORAGE_PREFIX + (shared ? 'team::' : 'me::');
                const keys = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && k.startsWith(base + prefix)) keys.push(k.slice(base.length));
                }
                resolve({ keys, prefix, shared });
            });
        }
    };

    let rows = [];
    let loaded = false;
    let currentTab = 'ledger';
    let pendingRestoreData = null;

    const todayLabel = () => new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
    document.getElementById('dateLabel').textContent = todayLabel();

    const EYE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
    const EYE_OFF_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a17.6 17.6 0 0 1-3.06 3.94M6.6 6.6C3.7 8.4 1 12 1 12s4 7 11 7a10.1 10.1 0 0 0 5.4-1.6M1 1l22 22"/><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/></svg>`;

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

    async function saveWithRetry(key, value, shared = false, retries = 3, baseDelayMs = 600) {
        let lastErr = null;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                await window.storage.set(key, value, shared);
                return true;
            } catch (e) {
                lastErr = e;
                console.error(`Storage write attempt ${attempt}/${retries} failed for "${key}"`, e);
                if (attempt < retries) {
                    await new Promise(r => setTimeout(r, baseDelayMs * attempt));
                }
            }
        }
        console.error(`Storage write gave up on "${key}" after ${retries} attempts`, lastErr);
        return false;
    }

    function withTimeout(promise, ms, label) {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    function looksLikeMissingKey(e) {
        const msg = (e && e.message ? e.message : String(e || '')).toLowerCase();
        return msg.includes('not found') || msg.includes('no such key') || msg.includes('does not exist');
    }

    async function loadWithRetry(key, shared = false, retries = 3, baseDelayMs = 900, timeoutMs = 8000) {
        let lastErr = null;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await withTimeout(window.storage.get(key, shared), timeoutMs, `Loading "${key}"`);
            } catch (e) {
                lastErr = e;
                if (looksLikeMissingKey(e)) {
                    // This key has simply never been saved before — that's normal for a first-time
                    // user, not a failure. Resolve to "no data" immediately instead of burning
                    // retries and alarming the user with a banner for a completely expected case.
                    return null;
                }
                if (attempt < retries) {
                    console.warn(`Storage read attempt ${attempt}/${retries} failed for "${key}", retrying…`, e);
                    const jitter = Math.random() * 200;
                    await new Promise(r => setTimeout(r, baseDelayMs * attempt + jitter));
                }
            }
        }
        console.error(`Storage read gave up on "${key}" after ${retries} attempts`, lastErr);
        throw lastErr;
    }

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

    window.openFixedGate = function () {
        const passEl = document.getElementById('fixedGatePass');
        const errEl = document.getElementById('fixedGateError');
        if (passEl) passEl.value = '';
        if (errEl) errEl.style.display = 'none';
        document.getElementById('fixedGateModal').classList.add('show');
        setTimeout(() => { if (passEl) passEl.focus(); }, 0);
    };

    window.closeFixedGate = function () {
        document.getElementById('fixedGateModal').classList.remove('show');
    };

    window.clearFixedGateError = function () {
        const errEl = document.getElementById('fixedGateError');
        if (errEl) errEl.style.display = 'none';
    };

    window.submitFixedGate = async function () {
        const passEl = document.getElementById('fixedGatePass');
        const errEl = document.getElementById('fixedGateError');
        const btn = document.getElementById('fixedGateSubmitBtn');
        const entered = passEl.value || '';
        if (!entered) {
            errEl.textContent = 'Please enter your password.';
            errEl.style.display = 'block';
            passEl.focus();
            return;
        }
        if (!loginCreds) {
            errEl.textContent = 'No login is set up on this device yet.';
            errEl.style.display = 'block';
            return;
        }
        btn.disabled = true;
        try {
            const hash = await hashPassword(entered, loginCreds.salt);
            if (hash !== loginCreds.passwordHash) {
                errEl.textContent = 'Incorrect password. Please try again.';
                errEl.style.display = 'block';
                passEl.value = '';
                passEl.focus();
                return;
            }
            closeFixedGate();
            await openFixedEditor();
        } catch (e) {
            console.error('Fixed gate check failed', e);
            errEl.textContent = 'Something went wrong checking your password — please try again.';
            errEl.style.display = 'block';
        } finally {
            btn.disabled = false;
        }
    };

    window.openFixedEditor = async function () {
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
    let loginCreds = null;

    function randomSalt() {
        if (window.crypto && crypto.getRandomValues) {
            const arr = new Uint8Array(16);
            crypto.getRandomValues(arr);
            return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
        }
        // Fallback for the rare environment without the Web Crypto API. Still unique
        // per install, just not cryptographically strong — fine for a soft access
        // screen that was never meant to be real security anyway.
        return Math.random().toString(36).slice(2) + Date.now().toString(36);
    }

    async function hashPassword(password, salt) {
        const combined = salt + '::' + password;
        if (window.crypto && crypto.subtle && crypto.subtle.digest) {
            try {
                const enc = new TextEncoder();
                const data = enc.encode(combined);
                const hashBuffer = await crypto.subtle.digest('SHA-256', data);
                return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
            } catch (e) {
                console.warn('crypto.subtle.digest failed, falling back to a simple hash', e);
            }
        }
        // Fallback (non-cryptographic) hash for contexts without Web Crypto — e.g. some
        // very old or locked-down browsers opening this file directly. Weaker, but this
        // login was always documented as a soft access screen, not real authentication.
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < combined.length; i++) {
            const ch = combined.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + 'fallback';
    }

    async function loadLoginCreds() {
        try {
            const res = await loadWithRetry('stock_login');
            const parsed = res ? JSON.parse(res.value) : null;
            loginCreds = (parsed && typeof parsed === 'object' && parsed.username) ? parsed : null;
        } catch (e) {
            console.warn('Login state read failed, defaulting to setup screen', e);
            loginCreds = null;
        }
        renderLoginForm();
    }

    // ---------- LOGIN UX HELPERS ----------
    // Small, reusable helpers behind the friendlier login form: a show/hide toggle for
    // password fields, a Caps Lock warning (a very common reason people get "locked
    // out" of a password they typed correctly), and consistent error display/clearing.

    function pwdFieldHTML(id, labelText, placeholder, autocomplete, enterAttr) {
        return `
        <label class="login-label" for="${id}">${labelText}</label>
        <div class="pwd-field">
          <input class="login-input" type="password" id="${id}" placeholder="${placeholder}" autocomplete="${autocomplete}"
            oninput="clearLoginError(this)"
            onkeyup="watchCapsLock(event,'${id}')"
            onblur="hideCapsWarning('${id}')"
            ${enterAttr}>
          <button type="button" class="pwd-toggle-btn" id="pwdToggle_${id}" aria-label="Show password" aria-pressed="false" onclick="togglePwdVisibility('${id}')">${EYE_ICON}</button>
        </div>
        <div class="caps-warning" id="capsWarn_${id}" style="display:none;" role="status">⇪ Caps Lock is on</div>
      `;
    }

    window.togglePwdVisibility = function (id) {
        const input = document.getElementById(id);
        const btn = document.getElementById('pwdToggle_' + id);
        if (!input || !btn) return;
        const nowShown = input.type === 'password';
        input.type = nowShown ? 'text' : 'password';
        btn.innerHTML = nowShown ? EYE_OFF_ICON : EYE_ICON;
        btn.setAttribute('aria-label', nowShown ? 'Hide password' : 'Show password');
        btn.setAttribute('aria-pressed', String(nowShown));
        // Keep focus (and the cursor at the end) in the field rather than jumping to the button.
        input.focus();
        const len = input.value.length;
        try { input.setSelectionRange(len, len); } catch (e) { /* not all input types support this */ }
    };

    window.watchCapsLock = function (event, id) {
        const warn = document.getElementById('capsWarn_' + id);
        if (!warn) return;
        const isOn = typeof event.getModifierState === 'function' && event.getModifierState('CapsLock');
        warn.style.display = isOn ? 'flex' : 'none';
    };

    window.hideCapsWarning = function (id) {
        const warn = document.getElementById('capsWarn_' + id);
        if (warn) warn.style.display = 'none';
    };

    window.clearLoginError = function (fromInput) {
        const errEl = document.getElementById('loginError');
        if (errEl && errEl.style.display !== 'none') {
            errEl.style.display = 'none';
            errEl.classList.remove('shake');
        }
        document.querySelectorAll('#loginFormArea .login-input.invalid').forEach(el => el.classList.remove('invalid'));
    };

    function showLoginFormError(msg, invalidIds) {
        const errEl = document.getElementById('loginError');
        if (!errEl) return;
        errEl.innerHTML = `<span aria-hidden="true">⚠</span><span>${escapeHtml(msg)}</span>`;
        errEl.style.display = 'flex';
        errEl.setAttribute('role', 'alert');
        errEl.classList.remove('shake');
        void errEl.offsetWidth; // restart the animation if the same error fires twice in a row
        errEl.classList.add('shake');
        (invalidIds || []).forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('invalid');
        });
    }

    function setSubmitBusy(btn, busy, busyLabel, idleLabel) {
        if (!btn) return;
        btn.disabled = busy;
        const arrow = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
        btn.innerHTML = busy ? busyLabel : `${idleLabel} ${arrow}`;
    }

    function renderLoginForm() {
        const area = document.getElementById('loginFormArea');
        if (!area) return;
        if (!loginCreds) {
            area.innerHTML = `
          <div class="login-form">
            <label class="login-label" for="loginSetupUser">Choose a username</label>
            <input class="login-input" type="text" id="loginSetupUser" placeholder="e.g. your name" autocomplete="off"
              oninput="clearLoginError(this)"
              onkeydown="if(event.key==='Enter'){event.preventDefault();document.getElementById('loginSetupPass').focus();}">
            ${pwdFieldHTML('loginSetupPass', 'Choose a password', 'Anything you\u2019ll remember', 'new-password',
                "onkeydown=\"if(event.key==='Enter'){event.preventDefault();document.getElementById('loginSetupPassConfirm').focus();}\"")}
            <div class="login-hint">At least 4 characters — pick something you won't forget, since there's no email to reset it with.</div>
            ${pwdFieldHTML('loginSetupPassConfirm', 'Confirm password', 'Type it again', 'new-password',
                    "onkeydown=\"if(event.key==='Enter'){event.preventDefault();createLogin();}\"")}
            <div id="loginError" class="login-error" style="display:none;" aria-live="assertive"></div>
            <button class="login-submit-btn" id="loginSubmitBtn" onclick="createLogin()">
              Create Login &amp; Enter
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </button>
          </div>
        `;
            setTimeout(() => { const u = document.getElementById('loginSetupUser'); if (u) u.focus(); }, 0);
        } else {
            area.innerHTML = `
          <div class="login-form">
            <div class="welcome-returning">Welcome back, <strong>${escapeHtml(loginCreds.username)}</strong></div>
            ${pwdFieldHTML('loginPass', 'Password', 'Enter your password', 'current-password',
                "onkeydown=\"if(event.key==='Enter'){event.preventDefault();attemptLogin();}\"")}
            <div id="loginError" class="login-error" style="display:none;" aria-live="assertive"></div>
            <button class="login-submit-btn" id="loginSubmitBtn" onclick="attemptLogin()">
              Sign In
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </button>
            <button class="login-link-btn" onclick="showResetConfirm()">Not you, or forgot your password? Reset login</button>
          </div>
        `;
            setTimeout(() => { const p = document.getElementById('loginPass'); if (p) p.focus(); }, 0);
        }
    }

    window.createLogin = async function () {
        const userEl = document.getElementById('loginSetupUser');
        const passEl = document.getElementById('loginSetupPass');
        const confirmEl = document.getElementById('loginSetupPassConfirm');
        const btn = document.getElementById('loginSubmitBtn');
        const username = (userEl.value || '').trim();
        const password = passEl.value || '';
        const confirmPassword = confirmEl.value || '';

        if (!username) {
            showLoginFormError('Please choose a username.', ['loginSetupUser']);
            userEl.focus();
            return;
        }
        if (password.length < 4) {
            showLoginFormError('Please choose a password with at least 4 characters.', ['loginSetupPass']);
            passEl.focus();
            return;
        }
        if (password !== confirmPassword) {
            showLoginFormError("Those passwords don't match — please re-enter them.", ['loginSetupPass', 'loginSetupPassConfirm']);
            confirmEl.value = '';
            confirmEl.focus();
            return;
        }

        setSubmitBusy(btn, true, 'Creating your login…', 'Create Login &amp; Enter');
        try {
            const salt = randomSalt();
            const passwordHash = await hashPassword(password, salt);
            const newCreds = { username, passwordHash, salt };
            const ok = await saveWithRetry('stock_login', JSON.stringify(newCreds));
            if (!ok) {
                showLoginFormError("Couldn't save your login right now — please try again.", []);
                setSubmitBusy(btn, false, '', 'Create Login &amp; Enter');
                return;
            }
            loginCreds = newCreds;
            afterLoginSuccess(username);
        } catch (e) {
            console.error('Login creation failed', e);
            showLoginFormError('Something went wrong creating your login — please try again.', []);
            setSubmitBusy(btn, false, '', 'Create Login &amp; Enter');
        }
    };

    window.attemptLogin = async function () {
        const passEl = document.getElementById('loginPass');
        const btn = document.getElementById('loginSubmitBtn');
        const entered = passEl.value || '';

        if (!entered) {
            showLoginFormError('Please enter your password.', ['loginPass']);
            passEl.focus();
            return;
        }
        if (!loginCreds) {
            showLoginFormError('Incorrect password. Please try again.', ['loginPass']);
            passEl.value = '';
            passEl.focus();
            return;
        }

        setSubmitBusy(btn, true, 'Signing in…', 'Sign In');
        try {
            const enteredHash = await hashPassword(entered, loginCreds.salt);
            if (enteredHash !== loginCreds.passwordHash) {
                showLoginFormError('Incorrect password. Please try again.', ['loginPass']);
                passEl.value = '';
                passEl.focus();
                setSubmitBusy(btn, false, '', 'Sign In');
                return;
            }
            afterLoginSuccess(loginCreds.username);
        } catch (e) {
            console.error('Login attempt failed', e);
            showLoginFormError('Something went wrong signing in — please try again.', []);
            setSubmitBusy(btn, false, '', 'Sign In');
        }
    };

    function afterLoginSuccess(username) {
        // Nice-to-have: prefill the bartender name if it hasn't been set yet.
        // Guarded by metaLoaded so this can never race ahead of the real saved value.
        if (metaLoaded && (!meta.bartender || !meta.bartender.trim())) {
            meta.bartender = username;
            const nameEl = document.getElementById('bartenderName');
            if (nameEl) nameEl.value = username;
            saveMeta();
        }
        const navUserEl = document.getElementById('navUser');
        if (navUserEl) navUserEl.innerHTML = `Logged in as <strong>${escapeHtml(username)}</strong>`;
        enterSystem();
    }

    window.doLogout = function () {
        if (!confirm("Log out? You'll need to enter the password again to get back in.")) return;
        document.getElementById('app').style.display = 'none';
        document.getElementById('welcomeScreen').classList.remove('hidden');
        renderLoginForm();
    };

    window.showResetConfirm = function () {
        if (!confirm('Reset the login for this file? Anyone who opens it afterward will be able to set new credentials — only do this if you forgot yours.')) return;
        resetLogin();
    };

    async function resetLogin() {
        loginCreds = null;
        const ok = await saveWithRetry('stock_login', JSON.stringify(null));
        if (!ok) {
            alert("The reset didn't fully save due to a storage error — if you reopen this file before it resolves, your old login may still be there. Try again in a moment.");
        }
        renderLoginForm();
    }

    window.openChangePasswordModal = function () {
        document.getElementById('cpCurrent').value = '';
        document.getElementById('cpNew').value = '';
        document.getElementById('cpConfirm').value = '';
        document.getElementById('cpError').style.display = 'none';
        document.getElementById('changePasswordModal').classList.add('show');
        setTimeout(() => document.getElementById('cpCurrent').focus(), 0);
    };

    window.closeChangePasswordModal = function () {
        document.getElementById('changePasswordModal').classList.remove('show');
    };

    window.submitChangePassword = async function () {
        const curEl = document.getElementById('cpCurrent');
        const newEl = document.getElementById('cpNew');
        const confirmEl = document.getElementById('cpConfirm');
        const errEl = document.getElementById('cpError');
        const showErr = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };

        if (!loginCreds) { showErr('No login is currently set up.'); return; }
        const curHash = await hashPassword(curEl.value || '', loginCreds.salt);
        if (curHash !== loginCreds.passwordHash) { showErr('Current password is incorrect.'); return; }
        if (!newEl.value) { showErr('Please enter a new password.'); return; }
        if (newEl.value !== confirmEl.value) { showErr('New passwords do not match.'); return; }

        const newSalt = randomSalt();
        const newHash = await hashPassword(newEl.value, newSalt);
        const newCreds = { username: loginCreds.username, passwordHash: newHash, salt: newSalt };
        const ok = await saveWithRetry('stock_login', JSON.stringify(newCreds));
        if (!ok) { showErr("Couldn't save the new password right now — please try again."); return; }
        loginCreds = newCreds;
        document.getElementById('changePasswordModal').classList.remove('show');
        flashStatus('PASSWORD UPDATED');
    };

    window.enterSystem = function () {
        const welcome = document.getElementById('welcomeScreen');
        const app = document.getElementById('app');
        if (welcome) welcome.classList.add('hidden');
        if (app) app.style.display = '';
    };

    window.render = render;

    async function initApp() {
        // Login form first — it's the very first thing the user sees.
        await loadLoginCreds().catch(function (e) {
            console.error('Login state load crashed unexpectedly', e);
            loginCreds = null;
            renderLoginForm();
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