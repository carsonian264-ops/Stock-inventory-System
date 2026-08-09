(function () {
    let rows = [];
    let loaded = false;
    let currentTab = 'ledger';
    let pendingRestoreData = null;
    const ROW_COUNT_DEFAULT = 15;

    const todayLabel = () => new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
    document.getElementById('dateLabel').textContent = todayLabel();

    function uid() { return 'r_' + Math.random().toString(36).slice(2, 10); }
    function blankRow() { return { id: uid(), brand: '', opening: 0, newStock: 0, sales: 0, price: 0 }; }
    function money(n) { return (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    let storageOK = true;
    let failedSaveKeys = new Set();
    let meta = { bartender: '', date: '' };

    async function saveWithRetry(key, value, retries = 3, baseDelayMs = 600) {
        let lastErr = null;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                await window.storage.set(key, value);
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

    async function loadWithRetry(key, retries = 3, baseDelayMs = 900, timeoutMs = 8000) {
        let lastErr = null;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await withTimeout(window.storage.get(key), timeoutMs, `Loading "${key}"`);
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
            const res = await loadWithRetry('stock_meta');
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
        const ok = await saveWithRetry('stock_meta', JSON.stringify(meta));
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
            const res = await loadWithRetry('stock_rows');
            rows = res ? JSON.parse(res.value) : null;
            if (rows === null) {
                rows = Array.from({ length: ROW_COUNT_DEFAULT }, blankRow);
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
        const ok = await saveWithRetry('stock_rows', JSON.stringify(rows));
        if (ok) { failedSaveKeys.delete('stock_rows'); } else { failedSaveKeys.add('stock_rows'); }
        updateSaveBanner();
        flashStatus(ok ? ('SAVED ' + new Date().toLocaleTimeString()) : 'SAVE FAILED — SEE BANNER', !ok);
    }

    function updateSaveBanner() {
        const el = document.getElementById('saveWarning');
        if (!el) return;
        if (failedSaveKeys.size > 0) {
            const labels = { stock_rows: 'the ledger table', stock_meta: 'the bartender name / date', stock_daily_tables: 'the day-close archive', stock_history: 'the sales history' };
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
            const res = await loadWithRetry('stock_history');
            return { ok: true, data: res ? JSON.parse(res.value) : [] };
        } catch (e) {
            console.error('History read failed after retries', e);
            return { ok: false, data: [] };
        }
    }

    async function getDailyTables() {
        try {
            const res = await loadWithRetry('stock_daily_tables');
            return { ok: true, data: res ? JSON.parse(res.value) : [] };
        } catch (e) {
            console.error('Daily tables read failed after retries', e);
            return { ok: false, data: [] };
        }
    }

    async function saveDailyTables(list) {
        return await saveWithRetry('stock_daily_tables', JSON.stringify(list));
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
        const saved = await saveWithRetry('stock_history', JSON.stringify(list));
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

        const q = (document.getElementById('searchBox').value || '').toLowerCase().trim();
        const numbered = rows.map((r, i) => ({ r, no: i + 1 }));
        const filtered = q ? numbered.filter(x => (x.r.brand || '').toLowerCase().includes(q)) : numbered;

        document.getElementById('rowCountLabel').textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} total`;

        const host = document.getElementById('tableHost');
        if (filtered.length === 0) {
            host.innerHTML = `<div style="padding:30px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--ink-soft);">No brands match "${q}".</div>`;
            return;
        }

        const closeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.5-7.1"/><path d="M21 3v6h-6"/></svg>`;
        const trashIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`;

        const bodyRows = filtered.map(({ r, no }) => {
            const total = totalOf(r);
            const closing = closingOf(r);
            const totals = totalsOf(r);
            const outOfStock = closing <= 0;
            const rowCls = outOfStock ? 'row-out' : '';
            const stamp = outOfStock
                ? `<span class="stamp out">Out of Stock</span>`
                : `<span class="stamp ok">In Stock</span>`;

            return `
          <tr data-id="${r.id}" class="${rowCls}">
            <td class="center no-cell" data-label="No.">${no}</td>
            <td data-label="Brand"><input class="cell-input brand-input" type="text" placeholder="Brand name" value="${escapeHtml(r.brand)}" onchange="updateField('${r.id}','brand',this.value)"></td>
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
            <td class="num" data-label="Price (Ksh)"><input class="cell-input" type="number" min="0" step="0.01" value="${r.price}" onchange="updateField('${r.id}','price',this.value)"></td>
            <td class="num" data-label="Totals"><span class="computed-val">${money(totals)}</span><span class="computed-sub">Ksh</span></td>
            <td class="center" data-label="Status">${stamp}</td>
            <td class="center" data-label="Actions">
              <div class="row-actions">
                <button class="icon-btn" title="Close day &amp; carry forward" onclick="closeDay('${r.id}')">${closeIcon}</button>
                <button class="icon-btn danger" title="Remove row" onclick="removeRow('${r.id}')">${trashIcon}</button>
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
        if (field === 'brand') {
            r.brand = value;
        } else {
            r[field] = Math.max(0, Number(value) || 0);
        }
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

    window.addRow = function () {
        rows.push(blankRow());
        saveRows();
        render();
        flashStatus('ROW ADDED');
    };

    window.removeRow = function (id) {
        const r = rows.find(x => x.id === id);
        if (!r) return;
        const label = r.brand && r.brand.trim() !== '' ? `"${r.brand}"` : 'this blank row';
        if (!confirm(`Remove ${label} from the ledger? This can't be undone.`)) return;
        rows = rows.filter(x => x.id !== id);
        saveRows();
        render();
        flashStatus('ROW REMOVED');
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
            const histSaved = await saveWithRetry('stock_history', JSON.stringify(hist));
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
        rows = Array.from({ length: ROW_COUNT_DEFAULT }, blankRow);
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
        const payload = { exportedAt: new Date().toISOString(), rows, history: hist };
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
        const rowsOk = await saveWithRetry('stock_rows', JSON.stringify(rows));
        const histOk = await saveWithRetry('stock_history', JSON.stringify(hist));
        if (rowsOk) { failedSaveKeys.delete('stock_rows'); } else { failedSaveKeys.add('stock_rows'); }
        if (histOk) { failedSaveKeys.delete('stock_history'); } else { failedSaveKeys.add('stock_history'); }
        updateSaveBanner();
        pendingRestoreData = null;
        document.getElementById('restoreConfirmModal').classList.remove('show');
        render();
        if (rowsOk && histOk) {
            flashStatus('BACKUP RESTORED');
        } else {
            flashStatus('RESTORE INCOMPLETE — SEE BANNER', true);
        }
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
    // NOTE: this is a soft access screen only. Credentials live in plain JSON in
    // the same storage as everything else in this file — there is no encryption
    // and no server-side check. It's meant to personalize entry and discourage
    // casual access, not to provide real security.
    let loginCreds = null;

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

    function renderLoginForm() {
        const area = document.getElementById('loginFormArea');
        if (!area) return;
        if (!loginCreds) {
            area.innerHTML = `
          <div class="login-form">
            <label class="login-label" for="loginSetupUser">Choose a username</label>
            <input class="login-input" type="text" id="loginSetupUser" placeholder="e.g. your name" autocomplete="off">
            <label class="login-label" for="loginSetupPass">Choose a password</label>
            <input class="login-input" type="password" id="loginSetupPass" placeholder="Anything you'll remember" autocomplete="new-password" onkeydown="if(event.key==='Enter'){event.preventDefault();createLogin();}">
            <div id="loginError" class="login-error" style="display:none;"></div>
            <button class="login-submit-btn" onclick="createLogin()">
              Create Login &amp; Enter
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </button>
          </div>
        `;
        } else {
            area.innerHTML = `
          <div class="login-form">
            <div class="welcome-returning">Welcome back, <strong>${escapeHtml(loginCreds.username)}</strong></div>
            <label class="login-label" for="loginPass">Password</label>
            <input class="login-input" type="password" id="loginPass" placeholder="Enter your password" autocomplete="current-password" onkeydown="if(event.key==='Enter'){event.preventDefault();attemptLogin();}">
            <div id="loginError" class="login-error" style="display:none;"></div>
            <button class="login-submit-btn" onclick="attemptLogin()">
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
        const errEl = document.getElementById('loginError');
        const username = (userEl.value || '').trim();
        const password = passEl.value || '';
        if (!username || !password) {
            errEl.textContent = 'Please choose both a username and a password.';
            errEl.style.display = 'block';
            return;
        }
        const newCreds = { username, password };
        const ok = await saveWithRetry('stock_login', JSON.stringify(newCreds));
        if (!ok) {
            errEl.textContent = "Couldn't save your login right now — please try again.";
            errEl.style.display = 'block';
            return;
        }
        loginCreds = newCreds;
        afterLoginSuccess(username);
    };

    window.attemptLogin = function () {
        const passEl = document.getElementById('loginPass');
        const errEl = document.getElementById('loginError');
        const entered = passEl.value || '';
        if (!loginCreds || entered !== loginCreds.password) {
            errEl.textContent = 'Incorrect password. Please try again.';
            errEl.style.display = 'block';
            passEl.value = '';
            passEl.focus();
            return;
        }
        afterLoginSuccess(loginCreds.username);
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

    window.enterSystem = function () {
        const welcome = document.getElementById('welcomeScreen');
        const app = document.getElementById('app');
        if (welcome) welcome.classList.add('hidden');
        if (app) app.style.display = '';
    };

    window.render = render;

    async function initApp() {
        // Give the storage bridge a brief moment to finish initializing before the
        // very first call — calling immediately on mount is a plausible reason a
        // fresh page load can see every single read fail at once.
        await new Promise(r => setTimeout(r, 250));

        // Login form first — it's the very first thing the user sees.
        await loadLoginCreds().catch(function (e) {
            console.error('Login state load crashed unexpectedly', e);
            loginCreds = null;
            renderLoginForm();
        });

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

        // Then the lower-stakes reads, staggered rather than fired at the same
        // instant, so we're not bursting several concurrent requests at once.
        await new Promise(r => setTimeout(r, 200));
        await loadMeta().catch(e => console.warn('Meta init failed (non-critical)', e));

        await new Promise(r => setTimeout(r, 200));
        await initTheme().catch(e => console.warn('Theme init failed (non-critical)', e));
    }

    initApp();
})();
