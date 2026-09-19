(function () {
    // ---------- LOCAL STORAGE ADAPTER & RETRY HELPERS ----------
    // This file owns ALL communication with localStorage. Nothing outside this file
    // touches `localStorage` directly. It exposes two things on `window`:
    //   - window.storage        the raw get/set/delete/list adapter (Promise-based)
    //   - window.AppStorage     retry-wrapped save/load helpers that the rest of the
    //                           app (login.js, inventory.js) actually calls
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

    window.AppStorage = { saveWithRetry, loadWithRetry };
})();