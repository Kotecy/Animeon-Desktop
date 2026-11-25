// ==UserScript==
// @name         AON Followback
// @namespace    https://animeon.co/
// @version      1.4.0
// @description  Взаимная автоподписка для AnimeOn
// @match        https://animeon.cc/*
// @match        https://www.animeon.cc/*
// @match        https://v1.animeon.co/*
// @match        https://v2.animeon.co/*
// @match        https://*.animeon.co/*
// @match        https://*.animeon.cloud/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    if (window.__AON_FOLLOWBACK_LOADED__) return;
    try {
        Object.defineProperty(window, '__AON_FOLLOWBACK_LOADED__', {
            value: true,
            writable: true,
            enumerable: false,
            configurable: true
        });
    } catch (e) {
        window.__AON_FOLLOWBACK_LOADED__ = true;
    }

    const SCRIPT_VERSION = '1.4.0';
    let fbStopped = false;
    const fbIntervals = new Set();
    const fbTimeouts = new Set();
    const fbListeners = [];
    const setInterval = (fn, ms, ...args) => {
        const id = window.setInterval(() => { if (!fbStopped) fn(...args); }, ms);
        fbIntervals.add(id);
        return id;
    };
    const clearInterval = (id) => { fbIntervals.delete(id); window.clearInterval(id); };
    const setTimeout = (fn, ms, ...args) => {
        const id = window.setTimeout(() => { fbTimeouts.delete(id); if (!fbStopped) fn(...args); }, ms);
        fbTimeouts.add(id);
        return id;
    };
    const clearTimeout = (id) => { fbTimeouts.delete(id); window.clearTimeout(id); };
    function on(target, type, fn, opts) {
        target.addEventListener(type, fn, opts);
        fbListeners.push([target, type, fn, opts]);
    }

    const DEBUG = (function () {
        try { return localStorage.getItem('__aon_fb_debug') === '1'; } catch (e) { return false; }
    })();
    function logDebug(...args) {
        if (DEBUG) console.log('[AON Followback]', ...args);
    }

    function esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ─────────────────────────────────────────────────────────────
    // 1. ХРАНИЛИЩЕ И КОНСТАНТЫ
    // ─────────────────────────────────────────────────────────────
    const SETTINGS_KEY = '__aon_fb_settings_v1';
    const DONE_KEY = '__aon_fb_done_v1';
    const WHITELIST_KEY = '__aon_fb_whitelist_v1';
    const BLACKLIST_KEY = '__aon_fb_blacklist_v1';
    const JOURNAL_KEY = '__aon_fb_journal_v1';
    const STATS_KEY = '__aon_fb_stats_v1';
    const LOCK_KEY = '__aon_fb_lock_v1';
    const NAMEMAP_KEY = '__aon_fb_namemap_v1';
    const COOLDOWN_KEY = '__aon_fb_cooldown_v1';
    const BTN_POS_KEY = '__aon_fb_btn_pos_v1';
    const MODAL_POS_KEY = '__aon_fb_modal_pos_v1';

    const TAB_ID = 'fb_tab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

    const FOLLOWBACK_PAGE_SIZE = 50;
    const FOLLOWBACK_MAX_PAGES = 10;
    const CHECK_INTERVAL_SEC = 300; // 5 минут
    const MAX_ACTIONS_PER_RUN = 5;  // Не более 5 действий за цикл
    const MAX_NAMEMAP_ENTRIES = 1000;

    const store = (() => {
        const cache = new Map();
        return {
            read(key, fallback) {
                if (cache.has(key)) return cache.get(key);
                let val = fallback;
                try {
                    const raw = localStorage.getItem(key);
                    val = raw === null ? fallback : JSON.parse(raw);
                } catch (e) {
                    val = fallback;
                }
                cache.set(key, val);
                return val;
            },
            write(key, value) {
                cache.set(key, value);
                try {
                    if (value === null || value === undefined) localStorage.removeItem(key);
                    else localStorage.setItem(key, JSON.stringify(value));
                } catch (e) {}
            },
            invalidate(key) { cache.delete(key); },
            invalidateAll() { cache.clear(); }
        };
    })();

    // ─────────────────────────────────────────────────────────────
    // 2. НАСТРОЙКИ
    // ─────────────────────────────────────────────────────────────
    function defaultSettings() {
        return {
            enabled: false,
            unfollowEnabled: true,
            activeTab: 'main'
        };
    }

    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            const saved = raw ? JSON.parse(raw) : {};
            return {
                ...defaultSettings(),
                enabled: Boolean(saved.enabled),
                unfollowEnabled: saved.unfollowEnabled !== undefined ? Boolean(saved.unfollowEnabled) : true,
                activeTab: saved.activeTab || 'main'
            };
        } catch (e) {
            return defaultSettings();
        }
    }

    let settings = loadSettings();

    function saveSettings(patch) {
        settings = { ...settings, ...patch };
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify({
                enabled: settings.enabled,
                unfollowEnabled: settings.unfollowEnabled,
                activeTab: settings.activeTab
            }));
        } catch (e) {}
    }

    // ─────────────────────────────────────────────────────────────
    // 3. БЕЛЫЙ И ЧЁРНЫЙ СПИСКИ
    // ─────────────────────────────────────────────────────────────
    function getWhitelist() {
        const v = store.read(WHITELIST_KEY, []);
        return Array.isArray(v) ? v : [];
    }

    function saveWhitelist(list) {
        store.write(WHITELIST_KEY, list);
    }

    function normalizeName(input) {
        if (!input) return '';
        let clean = String(input).trim();
        clean = clean.split('#')[0].split('?')[0].trim();
        if (clean.includes('/')) {
            const parts = clean.split('/').filter(Boolean);
            clean = parts[parts.length - 1] || clean;
        }
        if (clean.startsWith('@')) {
            clean = clean.slice(1).trim();
        }
        return clean;
    }

    function getUserSlug(u) {
        if (!u) return null;
        const s = u.username_slug || u.slug || u.username;
        return s ? String(s).trim() : null;
    }

    function getUserDisplayName(u) {
        if (!u) return '';
        return String(u.username || u.name || u.slug || u.username_slug || '').trim();
    }

    function isInListSet(slug, dispName, set) {
        if (!set || set.size === 0) return false;
        const s = slug ? String(slug).toLowerCase().trim() : '';
        const d = dispName ? String(dispName).toLowerCase().trim() : '';
        return (s && set.has(s)) || (d && set.has(d));
    }

    function extractUsersList(data) {
        if (!data) return [];
        if (Array.isArray(data)) return data;
        if (Array.isArray(data.users)) return data.users;
        if (Array.isArray(data.data)) return data.data;
        if (Array.isArray(data.items)) return data.items;
        return [];
    }

    // Возвращает явный total от сервера, либо null — чтобы отсутствие total
    // не обрывало пагинацию на 1-й странице и не ломало полноту списка.
    function extractExplicitTotal(data) {
        if (!data) return null;
        const candidates = [
            data.total,
            data.count,
            data.pagination?.total,
            data.pagination?.count,
            data.meta?.total,
            data.meta?.count
        ];
        for (const v of candidates) {
            if (typeof v === 'number' && isFinite(v)) return v;
            if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
        }
        return null;
    }

    function addNamesToList(rawInput, isWhite) {
        const tokens = String(rawInput || '')
            .split(/[\r\n,;]+/)
            .map(normalizeName)
            .filter(Boolean);
        if (!tokens.length) return 0;

        const list = (isWhite ? getWhitelist() : getBlacklist()).slice();
        const existing = new Set(list.map(s => normalizeName(s).toLowerCase()));
        const added = [];

        for (const clean of tokens) {
            const lower = clean.toLowerCase();
            if (!existing.has(lower)) {
                existing.add(lower);
                list.push(clean);
                added.push(clean);
            }
        }
        if (!added.length) return 0;

        if (isWhite) {
            saveWhitelist(list);
            addJournalEntry(`Белый список (+${added.length}): ${added.join(', ')}`, 'info', 'system');
        } else {
            saveBlacklist(list);
            addJournalEntry(`Чёрный список (+${added.length}): ${added.join(', ')}`, 'warn', 'system');
        }
        return added.length;
    }

    function removeFromWhitelist(name) {
        const lower = normalizeName(name).toLowerCase();
        const list = getWhitelist().filter(s => normalizeName(s).toLowerCase() !== lower);
        saveWhitelist(list);
        addJournalEntry(`Удалён из белого списка: ${normalizeName(name)}`, 'info', 'system');
    }

    function getBlacklist() {
        const v = store.read(BLACKLIST_KEY, []);
        return Array.isArray(v) ? v : [];
    }

    function saveBlacklist(list) {
        store.write(BLACKLIST_KEY, list);
    }

    function removeFromBlacklist(name) {
        const lower = normalizeName(name).toLowerCase();
        const list = getBlacklist().filter(s => normalizeName(s).toLowerCase() !== lower);
        saveBlacklist(list);
        addJournalEntry(`Удалён из чёрного списка: ${normalizeName(name)}`, 'info', 'system');
    }

    // ─────────────────────────────────────────────────────────────
    // 4. ЖУРНАЛ И СТАТИСТИКА
    // ─────────────────────────────────────────────────────────────
    function getJournal() {
        const v = store.read(JOURNAL_KEY, []);
        return Array.isArray(v) ? v : [];
    }

    function addJournalEntry(text, type = 'info', kind = 'system') {
        try {
            const items = getJournal().slice();
            const now = new Date();
            const timeStr = [
                String(now.getHours()).padStart(2, '0'),
                String(now.getMinutes()).padStart(2, '0'),
                String(now.getSeconds()).padStart(2, '0')
            ].join(':');

            if (items.length > 0 && items[0].text === text) return;
            if (items.slice(0, 5).some(it => it.text === text && Date.now() - (Number(it.id) || 0) < 30000)) return;

            const entry = {
                id: Date.now() + Math.random(),
                time: timeStr,
                text,
                type,
                kind // 'follow' | 'unfollow' | 'system'
            };

            items.unshift(entry);
            if (items.length > 80) items.length = 80;
            store.write(JOURNAL_KEY, items);

            if (shadow && isModalOpen && (settings.activeTab || 'main') === 'journal') {
                const list = shadow.querySelector('.fb-journal-list');
                const countEl = shadow.querySelector('#fb-journal-count');
                if (countEl) countEl.textContent = String(items.length);
                const matches = journalFilter === 'all' || entry.kind === journalFilter;
                if (list && matches) {
                    const emptyEl = list.querySelector('.fb-empty-hint');
                    if (emptyEl) emptyEl.remove();
                    const el = document.createElement('div');
                    el.className = `fb-journal-item ${entry.type || 'info'}`;
                    el.innerHTML = `
                        <span class="fb-journal-dot"></span>
                        <span class="fb-journal-time">${esc(entry.time)}</span>
                        <span class="fb-journal-text">${esc(entry.text)}</span>
                    `;
                    list.insertBefore(el, list.firstChild);
                }
            }
        } catch (e) {}
    }

    function clearJournal() {
        store.write(JOURNAL_KEY, []);
    }

    function getFbStats() {
        const v = store.read(STATS_KEY, null);
        return v && typeof v === 'object' ? v : { followedTotal: 0, unfollowedTotal: 0, lastCheckTs: 0, lastCheckText: '' };
    }

    function updateFbStats(patch) {
        try {
            const cur = getFbStats();
            const keys = Object.keys(patch || {});
            if (!keys.some(k => cur[k] !== patch[k])) return;
            store.write(STATS_KEY, { ...cur, ...patch });
            updateUI();
        } catch (e) {}
    }

    // ─────────────────────────────────────────────────────────────
    // 5. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ХУМАНАЙЗЕРА
    // ─────────────────────────────────────────────────────────────
    function humanDelay(minMs = 1500, maxMs = 3500) {
        const ms = Math.floor(minMs + Math.random() * (maxMs - minMs));
        return new Promise(r => setTimeout(r, ms));
    }

    function formatSecsToHuman(sec) {
        if (sec == null || isNaN(sec) || sec <= 0) return '0с';
        const s = Math.round(sec);
        const mins = Math.floor(s / 60);
        const remS = s % 60;
        if (mins > 0 && remS > 0) return `${mins}м ${remS}с`;
        if (mins > 0) return `${mins} мин`;
        return `${remS} сек`;
    }

    // ─────────────────────────────────────────────────────────────
    // 6. ОПРЕДЕЛЕНИЕ СВОЕГО АККАУНТА
    // ─────────────────────────────────────────────────────────────
    let cachedOwnSlug = null;
    async function resolveOwnUsernameSlug() {
        if (cachedOwnSlug) return cachedOwnSlug;

        for (const endpoint of ['/api/users/me', '/api/auth/me']) {
            try {
                const res = await fetch(endpoint, { credentials: 'include' });
                if (res.ok) {
                    const j = await res.json().catch(() => null);
                    const u = j && (j.user || j.data || j);
                    const slug = u && (u.username_slug || u.slug || u.username);
                    if (slug && slug !== 'me') {
                        cachedOwnSlug = String(slug);
                        return cachedOwnSlug;
                    }
                }
            } catch (e) {}
        }

        try {
            const keyRe = /user|auth|session|account|profile|persist|pinia/i;
            const slugRe = /"username_slug"\s*:\s*"([^"]+)"/;
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k || !keyRe.test(k)) continue;
                const raw = localStorage.getItem(k);
                if (!raw) continue;
                const m = raw.match(slugRe);
                if (m && m[1] && m[1] !== 'me') {
                    cachedOwnSlug = m[1];
                    return cachedOwnSlug;
                }
            }
        } catch (e) {}

        try {
            const slugRe = /"username_slug"\s*:\s*"([^"]+)"/;
            for (const s of document.querySelectorAll('script')) {
                const text = s.textContent || '';
                if (!text.includes('username_slug')) continue;
                const m = text.match(slugRe);
                if (m && m[1] && m[1] !== 'me') {
                    cachedOwnSlug = m[1];
                    return cachedOwnSlug;
                }
            }
        } catch (e) {}

        try {
            const profileLink = document.querySelector('header a[href^="/user/"], nav a[href^="/user/"], a[href^="/user/"], a[href^="/profile/"]');
            if (profileLink) {
                const href = profileLink.getAttribute('href') || '';
                const parts = href.split('#')[0].split('?')[0].split('/').filter(Boolean);
                if (parts.length >= 2 && parts[1] !== 'me') {
                    cachedOwnSlug = parts[1];
                    return cachedOwnSlug;
                }
            }
        } catch (e) {}

        return null;
    }

    // ─────────────────────────────────────────────────────────────
    // 7. СБОР ПОДПИСЧИКОВ И ПОДПИСОК
    // ─────────────────────────────────────────────────────────────
    function getFbDoneSet(ownSlug) {
        try {
            const raw = localStorage.getItem(DONE_KEY);
            const byOwner = raw ? JSON.parse(raw) : {};
            return new Set(Array.isArray(byOwner[ownSlug]) ? byOwner[ownSlug] : []);
        } catch (e) { return new Set(); }
    }

    function saveFbDoneSet(ownSlug, set) {
        try {
            const raw = localStorage.getItem(DONE_KEY);
            const byOwner = raw ? JSON.parse(raw) : {};
            byOwner[ownSlug] = Array.from(set);
            localStorage.setItem(DONE_KEY, JSON.stringify(byOwner));
        } catch (e) {}
    }

    async function fetchPaginatedUsers(ownSlug, kind) {
        const all = [];
        let explicitTotal = null;
        let isComplete = false;

        for (let page = 1; page <= FOLLOWBACK_MAX_PAGES; page++) {
            if (explicitTotal !== null && (page - 1) * FOLLOWBACK_PAGE_SIZE >= explicitTotal) {
                isComplete = true;
                break;
            }
            if (page > 1) await humanDelay(180, 360);

            let resp;
            try {
                resp = await fetch(`/api/users/${encodeURIComponent(ownSlug)}/${kind}?page=${page}&per_page=${FOLLOWBACK_PAGE_SIZE}`, {
                    credentials: 'include'
                });
            } catch (e) {
                return { all, total: explicitTotal ?? all.length, complete: false, error: true };
            }

            if (!resp || !resp.ok) {
                if (resp && resp.status === 429) throw new Error('RATE_LIMIT');
                if (resp && (resp.status === 401 || resp.status === 403)) cachedOwnSlug = null;
                return { all, total: explicitTotal ?? all.length, complete: false, error: true };
            }

            const data = await resp.json().catch(() => null);
            if (!data) return { all, total: explicitTotal ?? all.length, complete: false, error: true };

            const users = extractUsersList(data);
            if (explicitTotal === null) {
                explicitTotal = extractExplicitTotal(data);
            }
            all.push(...users);

            if (users.length < FOLLOWBACK_PAGE_SIZE) {
                isComplete = true;
                break;
            }
            if (explicitTotal !== null && page * FOLLOWBACK_PAGE_SIZE >= explicitTotal) {
                isComplete = true;
                break;
            }
        }

        return {
            all,
            total: explicitTotal !== null ? explicitTotal : all.length,
            complete: isComplete,
            error: false
        };
    }

    async function fetchFollowersList(ownSlug) {
        const res = await fetchPaginatedUsers(ownSlug, 'followers');
        return { all: res.all, total: res.total, complete: res.complete, error: res.error };
    }

    async function fetchFollowingData(ownSlug) {
        const res = await fetchPaginatedUsers(ownSlug, 'following');
        if (res.error && res.all.length === 0) return null;

        const slugs = [];
        const caseMap = new Map();
        const namesMap = {};

        for (const u of res.all) {
            const orig = getUserSlug(u);
            if (orig) {
                const s = orig.toLowerCase();
                slugs.push(s);
                if (!caseMap.has(s)) caseMap.set(s, orig);
                const disp = getUserDisplayName(u);
                if (disp) namesMap[s] = disp;
            }
        }

        return {
            slugs,
            caseMap,
            namesMap,
            total: res.total,
            complete: res.complete
        };
    }

    function claimFollowbackLock() {
        const now = Date.now();
        try {
            const raw = localStorage.getItem(LOCK_KEY);
            if (raw) {
                const lock = JSON.parse(raw);
                if (lock && lock.tabId && lock.tabId !== TAB_ID && (now - lock.ts) < 55000) {
                    return false;
                }
            }
            localStorage.setItem(LOCK_KEY, JSON.stringify({ tabId: TAB_ID, ts: now }));
            return true;
        } catch (e) { return true; }
    }

    function refreshFollowbackLock() {
        try {
            const raw = localStorage.getItem(LOCK_KEY);
            const lock = raw ? JSON.parse(raw) : null;
            if (!lock || lock.tabId === TAB_ID) {
                localStorage.setItem(LOCK_KEY, JSON.stringify({ tabId: TAB_ID, ts: Date.now() }));
            }
        } catch (e) {}
    }

    function releaseFollowbackLock() {
        try {
            const raw = localStorage.getItem(LOCK_KEY);
            const lock = raw ? JSON.parse(raw) : null;
            if (lock && lock.tabId === TAB_ID) localStorage.removeItem(LOCK_KEY);
        } catch (e) {}
    }

    // ─────────────────────────────────────────────────────────────
    // 8. ЦИКЛ АВТОПОДПИСКИ (МАКС 5 ДЕЙСТВИЙ РАЗ В 5 МИНУТ)
    // ─────────────────────────────────────────────────────────────
    let fbIsChecking = false;
    let fbTimer = null;
    let fbNextCheckTs = 0;

    async function performFollowbackCheck(isManual = false) {
        if (fbStopped || fbIsChecking) return;
        if (!settings.enabled && !isManual) return;

        const now = Date.now();
        let cooldownUntil = 0;
        try { cooldownUntil = Number(localStorage.getItem(COOLDOWN_KEY)) || 0; } catch (e) {}
        if (!isManual && cooldownUntil && now < cooldownUntil) {
            logDebug('Автоподписка: активен кулдаун до', new Date(cooldownUntil).toLocaleTimeString());
            scheduleNextCheck(Math.ceil((cooldownUntil - now) / 1000) + 10);
            return;
        }

        if (!isManual && !claimFollowbackLock()) {
            logDebug('Автоподписка: проверку уже ведёт другая вкладка');
            scheduleNextCheck();
            return;
        }

        fbIsChecking = true;
        updateUI();

        try {
            const ownSlug = await resolveOwnUsernameSlug();
            if (!ownSlug) {
                if (isManual) addJournalEntry('Ошибка: не удалось определить аккаунт (войдите на сайт)', 'warn', 'system');
                return;
            }

            await humanDelay(600, 1200);
            if (fbStopped) return;

            const followersData = await fetchFollowersList(ownSlug);
            if (followersData.error) {
                if (isManual) addJournalEntry('Ошибка загрузки списка подписчиков', 'warn', 'system');
                return;
            }
            const allFollowers = followersData.all || [];
            const totalFollowers = followersData.total || 0;

            await humanDelay(800, 1500);
            if (fbStopped) return;

            const followingData = await fetchFollowingData(ownSlug);
            if (!followingData) {
                if (isManual) addJournalEntry('Ошибка загрузки списка подписок', 'warn', 'system');
                return;
            }

            const followingSet = new Set(followingData.slugs || []);
            const doneSet = getFbDoneSet(ownSlug);
            const listsComplete = Boolean(followingData.complete && followersData.complete);

            const whitelist = new Set(getWhitelist().map(s => normalizeName(s).toLowerCase().trim()));
            const blacklist = new Set(getBlacklist().map(s => normalizeName(s).toLowerCase().trim()));

            let nameMap = {};
            try {
                const raw = localStorage.getItem(NAMEMAP_KEY);
                nameMap = raw ? JSON.parse(raw) : {};
            } catch (e) {}

            for (const u of allFollowers) {
                const s = getUserSlug(u);
                const d = getUserDisplayName(u);
                if (s && d) nameMap[s.toLowerCase()] = d;
            }
            if (followingData.namesMap) {
                Object.assign(nameMap, followingData.namesMap);
            }
            const nameKeys = Object.keys(nameMap);
            if (nameKeys.length > MAX_NAMEMAP_ENTRIES) {
                const trimmed = {};
                for (const k of nameKeys.slice(nameKeys.length - MAX_NAMEMAP_ENTRIES)) {
                    trimmed[k] = nameMap[k];
                }
                nameMap = trimmed;
            }
            try { localStorage.setItem(NAMEMAP_KEY, JSON.stringify(nameMap)); } catch (e) {}

            if (followingData.complete) {
                for (const s of Array.from(doneSet)) {
                    if (!followingSet.has(s)) doneSet.delete(s);
                }
            }

            let actionsDone = 0;

            // Зеркальная отписка (с иммунитетом для белого списка)
            let unfollowedCount = 0;
            if (settings.unfollowEnabled && actionsDone < MAX_ACTIONS_PER_RUN) {
                const suspiciousEmpty = allFollowers.length === 0 && totalFollowers > 0;
                if (!listsComplete || suspiciousEmpty) {
                    addJournalEntry('Зеркальная отписка пропущена: неполный ответ списка читателей/подписок', 'warn', 'system');
                } else {
                    const followerSlugs = new Set();
                    for (const u of allFollowers) {
                        const s = getUserSlug(u);
                        if (s) followerSlugs.add(s.toLowerCase());
                    }

                    const toUnfollow = Array.from(followingSet).filter(slug => {
                        const disp = nameMap[slug] || slug;
                        if (isInListSet(slug, disp, whitelist)) return false;
                        return !followerSlugs.has(slug);
                    }).slice(0, MAX_ACTIONS_PER_RUN - actionsDone);

                    for (const slug of toUnfollow) {
                        if (fbStopped || actionsDone >= MAX_ACTIONS_PER_RUN) break;
                        await humanDelay(1500, 3200);
                        refreshFollowbackLock();
                        try {
                            const origCase = followingData.caseMap?.get(slug) || slug;
                            let res = await fetch(`/api/users/${encodeURIComponent(origCase)}/follow`, {
                                method: 'DELETE',
                                headers: { 'Content-Type': 'application/json' },
                                credentials: 'include'
                            });
                            if (!res.ok && (res.status === 404 || res.status === 405)) {
                                res = await fetch(`/api/users/${encodeURIComponent(origCase)}/unfollow`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    credentials: 'include'
                                });
                            }
                            if (res.ok) {
                                doneSet.delete(slug);
                                followingSet.delete(slug);
                                unfollowedCount++;
                                actionsDone++;
                                const dispName = nameMap[slug] || origCase;
                                addJournalEntry(`Зеркальная отписка: ${dispName}`, 'warn', 'unfollow');
                            } else if (res.status === 429) {
                                throw new Error('RATE_LIMIT');
                            } else {
                                addJournalEntry(`Ошибка отписки от ${origCase} (HTTP ${res.status})`, 'warn', 'system');
                            }
                        } catch (err) {
                            if (err.message === 'RATE_LIMIT') throw err;
                        }
                    }
                }
            }

            // Взаимная подписка (с фильтром чёрного списка)
            const toFollow = [];
            for (const u of allFollowers) {
                const slugRaw = getUserSlug(u);
                if (!slugRaw) continue;
                const slug = slugRaw.toLowerCase();
                const disp = getUserDisplayName(u) || slug;
                if (isInListSet(slug, disp, blacklist)) continue;
                if (u.is_following || followingSet.has(slug) || doneSet.has(slug)) continue;
                toFollow.push({ ...u, _slug: slug, _orig: slugRaw, _disp: disp });
            }

            let followedCount = 0;
            if (toFollow.length > 0 && actionsDone < MAX_ACTIONS_PER_RUN) {
                const batch = toFollow.slice(0, MAX_ACTIONS_PER_RUN - actionsDone);

                for (const u of batch) {
                    if (fbStopped || actionsDone >= MAX_ACTIONS_PER_RUN) break;
                    await humanDelay(1600, 3400);
                    refreshFollowbackLock();
                    const slug = u._slug;
                    const origCase = u._orig;
                    try {
                        const res = await fetch(`/api/users/${encodeURIComponent(origCase)}/follow`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            credentials: 'include'
                        });
                        if (res.ok) {
                            doneSet.add(slug);
                            followingSet.add(slug);
                            followedCount++;
                            actionsDone++;
                            const dispName = u._disp || origCase;
                            nameMap[slug] = dispName;
                            showToast(`Подписался на ${dispName}`);
                            addJournalEntry(`Подписка: ${dispName}`, 'success', 'follow');
                        } else if (res.status === 429) {
                            throw new Error('RATE_LIMIT');
                        }
                    } catch (err) {
                        if (err.message === 'RATE_LIMIT') throw err;
                    }
                }
            }

            saveFbDoneSet(ownSlug, doneSet);

            const curStats = getFbStats();
            const timeStr = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            updateFbStats({
                followedTotal: (curStats.followedTotal || 0) + followedCount,
                unfollowedTotal: (curStats.unfollowedTotal || 0) + unfollowedCount,
                lastCheckTs: Date.now(),
                lastCheckText: timeStr
            });

            if (isManual && followedCount === 0 && unfollowedCount === 0) {
                addJournalEntry('Проверка: всё синхронно, новых подписчиков нет', 'info', 'system');
            }

        } catch (err) {
            if (err.message === 'RATE_LIMIT') {
                const cool = Date.now() + 15 * 60 * 1000;
                try { localStorage.setItem(COOLDOWN_KEY, String(cool)); } catch (e) {}
                addJournalEntry('Лимит API (429). Пауза 15 минут.', 'warn', 'system');
            }
        } finally {
            releaseFollowbackLock();
            fbIsChecking = false;
            updateUI();
            scheduleNextCheck();
        }
    }

    function scheduleNextCheck(delaySec) {
        if (fbTimer) { clearTimeout(fbTimer); fbTimer = null; }
        if (!settings.enabled || fbStopped) {
            fbNextCheckTs = 0;
            return;
        }

        const sec = delaySec || Math.floor(285 + Math.random() * 30); // ~5 минут
        fbNextCheckTs = Date.now() + sec * 1000;
        updateUI();
        fbTimer = setTimeout(() => {
            performFollowbackCheck(false);
        }, sec * 1000);
    }

    on(window, 'storage', (ev) => {
        if (ev.key) store.invalidate(ev.key);
        else store.invalidateAll();

        if (ev.key === SETTINGS_KEY && ev.newValue) {
            try {
                const s = JSON.parse(ev.newValue);
                const prevEnabled = settings.enabled;
                settings = { ...settings, ...s };
                if (!prevEnabled && settings.enabled) scheduleNextCheck(15);
                else if (prevEnabled && !settings.enabled) scheduleNextCheck();
                if (isModalOpen) renderTabContent();
                else updateUI();
            } catch (e) {}
        } else if (ev.key === STATS_KEY || ev.key === COOLDOWN_KEY) {
            updateUI();
        } else if ((ev.key === WHITELIST_KEY || ev.key === BLACKLIST_KEY || ev.key === JOURNAL_KEY) && isModalOpen) {
            renderTabContent();
        }
    });

    on(window, 'pagehide', releaseFollowbackLock);

    // ─────────────────────────────────────────────────────────────
    // 9. ИНТЕРФЕЙС (OBSIDIAN STUDIO COMMAND DECK)
    // ─────────────────────────────────────────────────────────────
    let widgetRoot = null;
    let shadow = null;
    let isModalOpen = false;
    let activeListTab = 'white'; // 'white' | 'black'
    let journalFilter = 'all';   // 'all' | 'follow' | 'unfollow'
    let lastToggleTime = 0;

    function safeToggleModal(forceState) {
        const now = Date.now();
        if (typeof forceState !== 'boolean' && (now - lastToggleTime < 250)) {
            return;
        }
        lastToggleTime = now;
        toggleModal(forceState);
    }

    function clampToViewport(el) {
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        let left = rect.left, top = rect.top, changed = false;
        const maxLeft = Math.max(10, window.innerWidth - rect.width - 10);
        const maxTop = Math.max(10, window.innerHeight - rect.height - 10);
        if (left > maxLeft) { left = maxLeft; changed = true; }
        if (left < 10) { left = 10; changed = true; }
        if (top > maxTop) { top = maxTop; changed = true; }
        if (top < 10) { top = 10; changed = true; }
        if (changed) {
            el.style.left = Math.round(left) + 'px';
            el.style.top = Math.round(top) + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        }
    }

    function ensureWidget() {
        const hostParent = document.body || document.documentElement;
        if (!hostParent) {
            if (document.readyState === 'loading') {
                on(document, 'DOMContentLoaded', ensureWidget, { once: true });
            }
            return;
        }

        if (widgetRoot && shadow && shadow.querySelector('.fb-window')) {
            if (!widgetRoot.isConnected) hostParent.appendChild(widgetRoot);
            return;
        }

        const existing = document.getElementById('aon-followback-root');
        if (existing) {
            if (existing.shadowRoot && existing.shadowRoot.querySelector('.fb-window')) {
                widgetRoot = existing;
                shadow = existing.shadowRoot;
                if (!widgetRoot.isConnected) hostParent.appendChild(widgetRoot);
                return;
            }
            try { existing.remove(); } catch (e) {}
        }

        widgetRoot = document.createElement('div');
        widgetRoot.id = 'aon-followback-root';
        shadow = widgetRoot.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = `
            :host {
                all: initial;
                --bg-base: #0b0c13;
                --bg-surface: rgba(255, 255, 255, 0.03);
                --bg-surface-hover: rgba(255, 255, 255, 0.05);
                --bg-input: rgba(6, 7, 12, 0.72);
                --border-hair: rgba(255, 255, 255, 0.08);
                --border-focus: rgba(155, 123, 247, 0.55);
                --text-primary: #f2f3f8;
                --text-muted: #9397ab;
                --text-dim: #5d6176;
                --accent: #9b7bf7;
                --accent-bright: #c4b5fd;
                --accent-soft: rgba(155, 123, 247, 0.14);
                --ok: #34d399;
                --ok-soft: rgba(52, 211, 153, 0.13);
                --warn: #fbbf24;
                --danger: #f87171;
                --danger-soft: rgba(248, 113, 113, 0.13);
                font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                color: var(--text-primary);
            }
            *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; scrollbar-width: none !important; -ms-overflow-style: none !important; }
            ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
            button:focus-visible, input:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }

            /* ── Плавающая кнопка-триггер ── */
            .fb-btn {
                position: fixed; bottom: 88px; right: 24px;
                width: 38px; height: 38px; border-radius: 11px;
                background: linear-gradient(160deg, rgba(22, 23, 36, 0.96), rgba(11, 12, 19, 0.98));
                border: 1px solid rgba(255, 255, 255, 0.12);
                color: var(--text-primary);
                box-shadow: 0 10px 26px rgba(0, 0, 0, 0.62), 0 0 0 1px rgba(155, 123, 247, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.11);
                backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
                display: grid; place-items: center;
                cursor: grab; user-select: none; touch-action: none;
                z-index: 2147483644;
                transition: transform .18s cubic-bezier(0.16, 1, 0.3, 1), border-color .18s ease, box-shadow .18s ease;
            }
            .fb-btn:hover { border-color: var(--border-focus); transform: translateY(-2px) scale(1.05); box-shadow: 0 14px 32px rgba(0, 0, 0, 0.72), 0 0 18px rgba(155, 123, 247, 0.28); }
            .fb-btn:active { transform: scale(0.94); }
            .fb-btn.dragging { cursor: grabbing; transform: scale(0.94); }
            .fb-btn svg { width: 17px; height: 17px; stroke: var(--accent-bright); stroke-width: 2; fill: none; }
            .fb-btn-dot {
                position: absolute; top: -3px; right: -3px;
                width: 9px; height: 9px; border-radius: 50%;
                background: #4b4e63; border: 2px solid var(--bg-base);
                pointer-events: none; transition: background .2s ease, box-shadow .2s ease;
            }
            .fb-btn-dot.active { background: var(--ok); box-shadow: 0 0 8px rgba(52, 211, 153, 0.8); }
            .fb-btn-dot.checking { background: var(--accent); box-shadow: 0 0 8px rgba(155, 123, 247, 0.85); }

            /* ── Окно панели (Obsidian Studio Command Deck) ── */
            .fb-window {
                position: fixed; bottom: 136px; right: 24px;
                width: 416px; max-width: calc(100vw - 24px);
                background: var(--bg-base);
                border: 1px solid rgba(255, 255, 255, 0.09);
                border-radius: 16px;
                box-shadow: 0 28px 72px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(155, 123, 247, 0.14), inset 0 1px 0 rgba(255, 255, 255, 0.1);
                z-index: 2147483645;
                overflow: hidden;
                display: none; flex-direction: column;
                background-image: radial-gradient(circle at 85% -20%, rgba(155, 123, 247, 0.1), transparent 55%);
                animation: fbPopIn .18s cubic-bezier(0.16, 1, 0.3, 1) forwards;
            }
            @keyframes fbPopIn {
                from { opacity: 0; transform: scale(0.97) translateY(8px); }
                to { opacity: 1; transform: scale(1) translateY(0); }
            }

            /* ── Шапка ── */
            .fb-head {
                display: flex; align-items: center; justify-content: space-between;
                height: 50px; padding: 0 16px;
                border-bottom: 1px solid var(--border-hair);
                background: rgba(255, 255, 255, 0.015);
                cursor: grab; user-select: none;
            }
            .fb-head.dragging { cursor: grabbing; }
            .fb-head-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
            .fb-brand-icon {
                width: 28px; height: 28px; border-radius: 8px;
                background: var(--accent-soft); border: 1px solid rgba(155, 123, 247, 0.32);
                display: grid; place-items: center; color: var(--accent-bright); flex-shrink: 0;
            }
            .fb-brand-icon svg { width: 15px; height: 15px; stroke: currentColor; stroke-width: 2; fill: none; }
            .fb-title-group { display: flex; flex-direction: column; }
            .fb-title { font-size: 13.5px; font-weight: 650; color: var(--text-primary); letter-spacing: -0.01em; line-height: 1.2; }
            .fb-ver { font-size: 10px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
            .fb-head-right { display: flex; align-items: center; gap: 8px; }
            .fb-status-pill {
                display: inline-flex; align-items: center; gap: 6px;
                font-size: 11px; font-weight: 600; color: var(--text-muted);
                background: rgba(255, 255, 255, 0.04); border: 1px solid var(--border-hair);
                padding: 3px 9px; border-radius: 999px; font-variant-numeric: tabular-nums;
            }
            .fb-title-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-dim); transition: background .2s ease; }
            .fb-title-dot.active { background: var(--ok); box-shadow: 0 0 8px rgba(52, 211, 153, 0.75); }
            .fb-title-dot.checking { background: var(--accent); box-shadow: 0 0 8px rgba(155, 123, 247, 0.85); }
            .fb-title-dot.cooldown { background: var(--warn); box-shadow: 0 0 8px rgba(251, 191, 36, 0.75); }
            .fb-close {
                width: 26px; height: 26px; border-radius: 8px;
                background: rgba(255, 255, 255, 0.04); border: 1px solid var(--border-hair);
                color: var(--text-muted); cursor: pointer; display: grid; place-items: center;
                transition: background .15s ease, color .15s ease, border-color .15s ease;
            }
            .fb-close:hover { background: rgba(255, 255, 255, 0.1); color: #ffffff; border-color: rgba(255, 255, 255, 0.18); }

            /* ── Верхние вкладки (Segmented Control) ── */
            .fb-tabs-wrap { padding: 10px 14px 0; }
            .fb-top-tabs {
                display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px;
                padding: 3px; border-radius: 10px;
                background: rgba(255, 255, 255, 0.025);
                border: 1px solid var(--border-hair);
                user-select: none;
            }
            .fb-top-tab {
                display: flex; align-items: center; justify-content: center; gap: 6px;
                padding: 7px 8px; border-radius: 7px; border: 1px solid transparent;
                background: transparent; color: var(--text-muted);
                font-size: 12px; font-weight: 550; cursor: pointer;
                transition: color .15s ease, background .15s ease, border-color .15s ease;
            }
            .fb-top-tab:hover { color: var(--text-primary); background: rgba(255, 255, 255, 0.03); }
            .fb-top-tab.active {
                color: var(--text-primary); font-weight: 600;
                background: var(--accent-soft);
                border-color: rgba(155, 123, 247, 0.28);
            }
            .fb-top-tab svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2; opacity: 0.85; }
            .fb-top-tab.active svg { color: var(--accent-bright); opacity: 1; }

            /* ── Тело окна ── */
            .fb-body { padding: 14px 14px 16px; display: flex; flex-direction: column; gap: 11px; }

            /* ── Телеметрия (2 метрики) ── */
            .fb-metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 9px; }
            .fb-metric {
                background: var(--bg-surface); border: 1px solid var(--border-hair);
                border-radius: 12px; padding: 11px 13px;
                display: flex; flex-direction: column; gap: 2px;
                box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
            }
            .fb-metric-label { font-size: 11px; color: var(--text-muted); font-weight: 550; }
            .fb-metric-val { font-size: 21px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; line-height: 1.2; margin-top: 2px; }
            .fb-metric-val.ok { color: var(--ok); }
            .fb-metric-val.warn { color: var(--warn); }

            /* ── Панель запуска ── */
            .fb-run-bar {
                display: flex; align-items: center; justify-content: space-between; gap: 10px;
                padding: 10px 12px; border-radius: 12px;
                background: linear-gradient(135deg, rgba(155, 123, 247, 0.09), rgba(255, 255, 255, 0.02));
                border: 1px solid rgba(155, 123, 247, 0.22);
            }
            .fb-run-info { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
            .fb-run-title { font-size: 12px; font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; }
            .fb-run-sub { font-size: 10.5px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
            .fb-action-btn {
                background: linear-gradient(180deg, #a78bfa 0%, #8b5cf6 100%);
                border: 1px solid rgba(255, 255, 255, 0.22);
                border-radius: 9px; color: #ffffff;
                font-size: 11.5px; font-weight: 600;
                padding: 7px 12px; cursor: pointer;
                display: inline-flex; align-items: center; gap: 6px;
                white-space: nowrap; flex-shrink: 0;
                transition: transform .15s ease, filter .15s ease, box-shadow .15s ease;
            }
            .fb-action-btn:hover { filter: brightness(1.06); transform: translateY(-1px); box-shadow: 0 6px 16px rgba(139, 92, 246, 0.35); }
            .fb-action-btn:disabled { opacity: 0.55; cursor: not-allowed; transform: none; box-shadow: none; }

            /* ── Карточки настроек ── */
            .fb-card {
                background: var(--bg-surface); border: 1px solid var(--border-hair);
                border-radius: 12px; padding: 12px 13px;
                display: flex; flex-direction: column; gap: 10px;
            }
            .fb-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
            .fb-divider { border-top: 1px solid rgba(255, 255, 255, 0.055); padding-top: 10px; }
            .fb-label { font-size: 12.5px; font-weight: 600; color: var(--text-primary); }
            .fb-sub { font-size: 11px; color: var(--text-muted); margin-top: 2px; line-height: 1.35; }

            .fb-switch { position: relative; display: inline-block; width: 38px; height: 22px; flex-shrink: 0; }
            .fb-switch input { opacity: 0; width: 0; height: 0; }
            .fb-slider { position: absolute; cursor: pointer; inset: 0; background: #222434; transition: .18s ease; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.12); }
            .fb-slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 2px; top: 2px; background: #b4b7c9; transition: .18s cubic-bezier(0.16, 1, 0.3, 1); border-radius: 50%; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45); }
            .fb-switch input:checked + .fb-slider { background: var(--accent); border-color: rgba(196, 181, 253, 0.55); box-shadow: 0 0 12px rgba(155, 123, 247, 0.35); }
            .fb-switch input:checked + .fb-slider:before { transform: translateX(16px); background: #ffffff; }

            .fb-foot-note {
                display: flex; align-items: center; justify-content: center; gap: 6px;
                font-size: 10.5px; color: var(--text-dim); text-align: center; padding-top: 2px;
            }

            /* ── Списки (белый / чёрный) ── */
            .fb-list-pills {
                display: grid; grid-template-columns: repeat(2, 1fr); gap: 5px;
                background: rgba(255, 255, 255, 0.025); border: 1px solid var(--border-hair);
                padding: 3px; border-radius: 10px;
            }
            .fb-pill {
                padding: 6px 8px; border: 1px solid transparent; border-radius: 7px;
                background: transparent; font-size: 11.5px; font-weight: 600;
                color: var(--text-muted); cursor: pointer; text-align: center;
                transition: all .15s ease;
            }
            .fb-pill:hover { color: var(--text-primary); }
            .fb-pill.active.white { background: var(--ok-soft); border-color: rgba(52, 211, 153, 0.28); color: #6ee7b7; }
            .fb-pill.active.black { background: var(--danger-soft); border-color: rgba(248, 113, 113, 0.28); color: #fca5a5; }

            .fb-add-row { display: flex; gap: 6px; }
            .fb-input {
                flex: 1; background: var(--bg-input);
                border: 1px solid var(--border-hair); border-radius: 9px;
                padding: 8px 11px; color: var(--text-primary); font-size: 12px; outline: none;
                transition: border-color .15s ease, box-shadow .15s ease;
            }
            .fb-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(155, 123, 247, 0.15); }
            .fb-input::placeholder { color: var(--text-dim); }
            .fb-add-btn {
                background: linear-gradient(180deg, #a78bfa 0%, #8b5cf6 100%);
                border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 9px;
                padding: 0 13px; color: #ffffff; font-size: 12px; font-weight: 600;
                cursor: pointer; transition: filter .15s ease; white-space: nowrap;
            }
            .fb-add-btn:hover { filter: brightness(1.08); }

            .fb-tags-card {
                background: var(--bg-surface); border: 1px solid var(--border-hair);
                border-radius: 12px; padding: 11px 12px; min-height: 126px;
                display: flex; flex-direction: column; justify-content: space-between; gap: 8px;
            }
            .fb-tags-wrap { display: flex; flex-wrap: wrap; gap: 6px; max-height: 130px; overflow-y: auto; align-content: flex-start; }
            .fb-tag {
                display: inline-flex; align-items: center; gap: 6px;
                padding: 4px 8px; border-radius: 7px; font-size: 11.5px; font-weight: 550;
            }
            .fb-tag.whitelist { background: var(--ok-soft); border: 1px solid rgba(52, 211, 153, 0.28); color: #6ee7b7; }
            .fb-tag.blacklist { background: var(--danger-soft); border: 1px solid rgba(248, 113, 113, 0.28); color: #fca5a5; }
            .fb-tag button {
                background: transparent; border: none; color: inherit; cursor: pointer;
                font-size: 13px; line-height: 1; opacity: 0.65; padding: 0 1px;
                transition: opacity .12s ease;
            }
            .fb-tag button:hover { opacity: 1; }
            .fb-empty-hint { font-size: 11.5px; color: var(--text-dim); line-height: 1.45; padding: 14px 4px; text-align: center; width: 100%; }
            .fb-list-foot { display: flex; justify-content: flex-end; border-top: 1px solid rgba(255, 255, 255, 0.05); padding-top: 7px; }
            .fb-link-btn { background: transparent; border: none; color: var(--text-muted); font-size: 11px; cursor: pointer; transition: color .14s ease; }
            .fb-link-btn:hover { color: var(--danger); }

            /* ── Журнал (таймлайн) ── */
            .fb-j-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
            .fb-j-filters { display: inline-flex; gap: 3px; background: rgba(255, 255, 255, 0.025); border: 1px solid var(--border-hair); border-radius: 8px; padding: 2px; }
            .fb-j-filter { border: none; background: transparent; color: var(--text-muted); font-size: 11px; font-weight: 600; padding: 4px 8px; border-radius: 6px; cursor: pointer; }
            .fb-j-filter.active { background: var(--accent-soft); color: var(--accent-bright); }
            .fb-j-clear {
                background: rgba(255, 255, 255, 0.04); border: 1px solid var(--border-hair);
                color: var(--text-muted); border-radius: 7px; padding: 4px 9px; font-size: 11px;
                cursor: pointer; transition: background .14s ease, color .14s ease;
            }
            .fb-j-clear:hover { background: rgba(255, 255, 255, 0.09); color: var(--text-primary); }
            .fb-journal-list {
                display: flex; flex-direction: column;
                max-height: 205px; overflow-y: auto;
                background: var(--bg-surface); border: 1px solid var(--border-hair);
                border-radius: 11px;
            }
            .fb-journal-item {
                display: flex; align-items: flex-start; gap: 8px;
                padding: 8px 11px; font-size: 11.5px; line-height: 1.4;
                border-bottom: 1px solid rgba(255, 255, 255, 0.045);
            }
            .fb-journal-item:last-child { border-bottom: none; }
            .fb-journal-dot { width: 6px; height: 6px; border-radius: 50%; margin-top: 5px; flex-shrink: 0; background: var(--accent); }
            .fb-journal-item.success .fb-journal-dot { background: var(--ok); }
            .fb-journal-item.warn .fb-journal-dot { background: var(--warn); }
            .fb-journal-time { color: var(--text-dim); font-variant-numeric: tabular-nums; font-size: 10.5px; width: 48px; flex-shrink: 0; margin-top: 1px; }
            .fb-journal-text { color: #e2e4ef; flex: 1; min-width: 0; word-break: break-word; }

            /* ── Тост ── */
            .fb-toast {
                position: fixed; bottom: 20px; left: 20px; z-index: 2147483647;
                background: linear-gradient(145deg, rgba(20, 21, 33, 0.96), rgba(11, 12, 19, 0.98));
                backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
                border: 1px solid rgba(52, 211, 153, 0.35);
                border-radius: 12px; padding: 9px 13px;
                color: #ffffff; box-shadow: 0 16px 38px rgba(0, 0, 0, 0.65);
                font-size: 12px; font-weight: 550;
                display: flex; align-items: center; gap: 9px; cursor: pointer;
                animation: fbPopIn .18s ease forwards;
            }
            @media (prefers-reduced-motion: reduce) {
                *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
            }
        `;
        shadow.appendChild(style);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fb-btn';
        btn.setAttribute('title', 'AON Followback');
        btn.setAttribute('aria-label', 'Открыть AON Followback');
        btn.innerHTML = `
            <svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>
            <span class="fb-btn-dot ${settings.enabled ? 'active' : ''}"></span>
        `;
        shadow.appendChild(btn);

        const win = document.createElement('div');
        win.className = 'fb-window';
        win.innerHTML = `
            <div class="fb-head" id="fb-win-head">
                <div class="fb-head-left">
                    <div class="fb-brand-icon">
                        <svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>
                    </div>
                    <div class="fb-title-group">
                        <span class="fb-title">AON Followback</span>
                        <span class="fb-ver">v${SCRIPT_VERSION} · безопасный режим</span>
                    </div>
                </div>
                <div class="fb-head-right">
                    <span class="fb-status-pill">
                        <span class="fb-title-dot ${settings.enabled ? 'active' : ''}" id="fb-title-dot"></span>
                        <span id="fb-head-status">${settings.enabled ? 'Активно' : 'Выкл'}</span>
                    </span>
                    <button class="fb-close" id="fb-win-close" title="Закрыть">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
            </div>

            <div class="fb-tabs-wrap">
                <div class="fb-top-tabs">
                    <button class="fb-top-tab active" data-tab="main">
                        <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg>
                        <span>Управление</span>
                    </button>
                    <button class="fb-top-tab" data-tab="lists">
                        <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
                        <span>Списки</span>
                    </button>
                    <button class="fb-top-tab" data-tab="journal">
                        <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                        <span>Журнал</span>
                    </button>
                </div>
            </div>

            <div class="fb-body" id="fb-win-body"></div>
        `;
        shadow.appendChild(win);

        hostParent.appendChild(widgetRoot);

        let btnJustDragged = false;
        setupDraggable(btn, BTN_POS_KEY, null, () => {
            btnJustDragged = true;
            setTimeout(() => { btnJustDragged = false; }, 160);
        });
        setupDraggable(win, MODAL_POS_KEY, win.querySelector('#fb-win-head'));

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (btnJustDragged) return;
            safeToggleModal();
        });

        win.querySelector('#fb-win-close').addEventListener('click', () => safeToggleModal(false));

        on(window, 'keydown', (e) => {
            if (e.key === 'Escape' && isModalOpen) safeToggleModal(false);
        });

        on(window, 'resize', () => {
            clampToViewport(btn);
            clampToViewport(win);
        });

        win.querySelectorAll('.fb-top-tab').forEach(tBtn => {
            tBtn.addEventListener('click', () => {
                win.querySelectorAll('.fb-top-tab').forEach(b => b.classList.remove('active'));
                tBtn.classList.add('active');
                settings.activeTab = tBtn.dataset.tab;
                saveSettings({ activeTab: settings.activeTab });
                renderTabContent();
            });
        });

        renderTabContent();
        updateUI();

        if (settings.enabled) {
            scheduleNextCheck(15);
        }
    }

    function toggleModal(open) {
        ensureWidget();
        const win = shadow ? shadow.querySelector('.fb-window') : null;
        if (!win) return;
        isModalOpen = typeof open === 'boolean' ? open : win.style.display !== 'flex';
        win.style.display = isModalOpen ? 'flex' : 'none';
        if (isModalOpen) {
            clampToViewport(win);
            renderTabContent();
        }
        updateUI();
    }

    function renderTabContent() {
        if (!shadow) return;
        const body = shadow.querySelector('#fb-win-body');
        if (!body) return;

        const curTab = settings.activeTab || 'main';
        shadow.querySelectorAll('.fb-top-tab').forEach(b => {
            b.classList.toggle('active', b.dataset.tab === curTab);
        });

        if (curTab === 'main') {
            const stats = getFbStats();

            body.innerHTML = `
                <div class="fb-metrics">
                    <div class="fb-metric">
                        <span class="fb-metric-label">Взаимных подписок</span>
                        <span class="fb-metric-val ok" id="fb-stat-followed">+${stats.followedTotal || 0}</span>
                    </div>
                    <div class="fb-metric">
                        <span class="fb-metric-label">Зеркальных отписок</span>
                        <span class="fb-metric-val warn" id="fb-stat-unfollowed">-${stats.unfollowedTotal || 0}</span>
                    </div>
                </div>

                <div class="fb-run-bar">
                    <div class="fb-run-info">
                        <span class="fb-run-title" id="fb-status-text">${esc(getStatusText())}</span>
                        <span class="fb-run-sub" id="fb-last-check">${stats.lastCheckText ? `Последняя проверка в ${esc(stats.lastCheckText)}` : 'Ещё не проверялось'}</span>
                    </div>
                    <button class="fb-action-btn" id="fb-btn-check-now"${fbIsChecking ? ' disabled' : ''}>
                        ${fbIsChecking ? '⏳ Проверка…' : '▶ Проверить'}
                    </button>
                </div>

                <div class="fb-card">
                    <div class="fb-row">
                        <div>
                            <div class="fb-label">Автоподписка в ответ</div>
                            <div class="fb-sub">Подписываться на новых читателей</div>
                        </div>
                        <label class="fb-switch">
                            <input type="checkbox" id="fb-toggle-enabled" ${settings.enabled ? 'checked' : ''}>
                            <span class="fb-slider"></span>
                        </label>
                    </div>

                    <div class="fb-row fb-divider">
                        <div>
                            <div class="fb-label">Зеркальная отписка</div>
                            <div class="fb-sub">Отписываться от отписавшихся (кроме белого списка)</div>
                        </div>
                        <label class="fb-switch">
                            <input type="checkbox" id="fb-toggle-unfollow" ${settings.unfollowEnabled ? 'checked' : ''}>
                            <span class="fb-slider"></span>
                        </label>
                    </div>
                </div>

                <div class="fb-foot-note">
                    <span>До 5 действий каждые 5 минут · Паузы 1.5–3.5с между запросами</span>
                </div>
            `;

            body.querySelector('#fb-toggle-enabled').addEventListener('change', (e) => {
                settings.enabled = e.target.checked;
                saveSettings({ enabled: e.target.checked });
                if (settings.enabled) scheduleNextCheck(10);
                else scheduleNextCheck();
                updateUI();
            });

            body.querySelector('#fb-toggle-unfollow').addEventListener('change', (e) => {
                settings.unfollowEnabled = e.target.checked;
                saveSettings({ unfollowEnabled: e.target.checked });
                updateUI();
            });

            body.querySelector('#fb-btn-check-now').addEventListener('click', async () => {
                await performFollowbackCheck(true);
                if (isModalOpen && (settings.activeTab || 'main') === 'main') renderTabContent();
            });

        } else if (curTab === 'lists') {
            const whitelist = getWhitelist();
            const blacklist = getBlacklist();
            const currentList = activeListTab === 'white' ? whitelist : blacklist;

            body.innerHTML = `
                <div class="fb-list-pills">
                    <button class="fb-pill ${activeListTab === 'white' ? 'active white' : ''}" id="fb-tab-white">
                        Белый список (${whitelist.length})
                    </button>
                    <button class="fb-pill ${activeListTab === 'black' ? 'active black' : ''}" id="fb-tab-black">
                        Чёрный список (${blacklist.length})
                    </button>
                </div>

                <div class="fb-add-row">
                    <input type="text" class="fb-input" id="fb-input-nick" placeholder="${activeListTab === 'white' ? 'Ник, @username или ссылка (можно через запятую)…' : 'Ник или ссылка для игнора (можно через запятую)…'}">
                    <button class="fb-add-btn" id="fb-btn-add">Добавить</button>
                </div>

                <div class="fb-tags-card">
                    <div class="fb-tags-wrap" id="fb-tags-container">
                        ${currentList.length ? currentList.map(name => `
                            <div class="fb-tag ${activeListTab === 'white' ? 'whitelist' : 'blacklist'}">
                                <span>${esc(name)}</span>
                                <button data-del="${esc(name)}" title="Удалить">&times;</button>
                            </div>
                        `).join('') : `<div class="fb-empty-hint">${activeListTab === 'white' ? 'Белый список пуст. Этих пользователей скрипт никогда не удалит при зеркальной отписке.' : 'Чёрный список пуст. На этих пользователей скрипт не будет подписываться в ответ.'}</div>`}
                    </div>
                    ${currentList.length ? `<div class="fb-list-foot"><button class="fb-link-btn" id="fb-btn-clear-list">Очистить список</button></div>` : ''}
                </div>
            `;

            body.querySelector('#fb-tab-white').addEventListener('click', () => {
                activeListTab = 'white';
                renderTabContent();
            });
            body.querySelector('#fb-tab-black').addEventListener('click', () => {
                activeListTab = 'black';
                renderTabContent();
            });

            const inEl = body.querySelector('#fb-input-nick');
            const doAdd = () => {
                if (!inEl || !inEl.value.trim()) return;
                addNamesToList(inEl.value, activeListTab === 'white');
                inEl.value = '';
                renderTabContent();
            };
            body.querySelector('#fb-btn-add').addEventListener('click', doAdd);
            inEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });

            body.querySelectorAll('[data-del]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const name = btn.dataset.del;
                    if (activeListTab === 'white') removeFromWhitelist(name);
                    else removeFromBlacklist(name);
                    renderTabContent();
                });
            });

            body.querySelector('#fb-btn-clear-list')?.addEventListener('click', () => {
                if (activeListTab === 'white') saveWhitelist([]);
                else saveBlacklist([]);
                addJournalEntry(`Очищен ${activeListTab === 'white' ? 'белый' : 'чёрный'} список`, 'info', 'system');
                renderTabContent();
            });

        } else if (curTab === 'journal') {
            const allItems = getJournal();
            const items = journalFilter === 'all'
                ? allItems
                : allItems.filter(it => (it.kind || 'system') === journalFilter);

            body.innerHTML = `
                <div class="fb-j-toolbar">
                    <div class="fb-j-filters">
                        <button class="fb-j-filter${journalFilter === 'all' ? ' active' : ''}" data-jf="all">Все (<span id="fb-journal-count">${allItems.length}</span>)</button>
                        <button class="fb-j-filter${journalFilter === 'follow' ? ' active' : ''}" data-jf="follow">Подписки</button>
                        <button class="fb-j-filter${journalFilter === 'unfollow' ? ' active' : ''}" data-jf="unfollow">Отписки</button>
                    </div>
                    <button class="fb-j-clear" id="fb-btn-clear-j">Очистить</button>
                </div>

                <div class="fb-journal-list">
                    ${items.length ? items.map(it => `
                        <div class="fb-journal-item ${esc(it.type || 'info')}">
                            <span class="fb-journal-dot"></span>
                            <span class="fb-journal-time">${esc(it.time)}</span>
                            <span class="fb-journal-text">${esc(it.text)}</span>
                        </div>
                    `).join('') : '<div class="fb-empty-hint">Пока нет записей в этой категории</div>'}
                </div>
            `;

            body.querySelectorAll('.fb-j-filter').forEach(btn => {
                btn.addEventListener('click', () => {
                    journalFilter = btn.dataset.jf || 'all';
                    renderTabContent();
                });
            });

            body.querySelector('#fb-btn-clear-j').addEventListener('click', () => {
                clearJournal();
                renderTabContent();
            });
        }
    }

    function showToast(text) {
        if (!shadow) ensureWidget();
        if (!shadow) return;
        const old = shadow.querySelector('.fb-toast');
        if (old) {
            try { old.remove(); } catch (e) {}
        }
        const toast = document.createElement('div');
        toast.className = 'fb-toast';
        toast.innerHTML = `
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>
            <span>${esc(text)}</span>
        `;
        toast.addEventListener('click', () => toast.remove());
        shadow.appendChild(toast);
        setTimeout(() => { try { toast.remove(); } catch (e) {} }, 4500);
    }

    // ─────────────────────────────────────────────────────────────
    // 10. ПЕРЕТАСКИВАНИЕ (DRAGGABLE)
    // ─────────────────────────────────────────────────────────────
    function setupDraggable(el, storageKey, handleEl, onDragEnd) {
        let isDown = false, startX, startY, origX, origY, hasMoved = false;
        const dragHandle = handleEl || el;

        try {
            const saved = localStorage.getItem(storageKey);
            if (saved) {
                const { x, y } = JSON.parse(saved);
                const width = el.offsetWidth || (el.classList.contains('fb-window') ? 416 : 38);
                const height = el.offsetHeight || (el.classList.contains('fb-window') ? 320 : 38);
                const safeX = Math.max(10, Math.min(window.innerWidth - width - 10, x));
                const safeY = Math.max(10, Math.min(window.innerHeight - height - 10, y));
                el.style.left = safeX + 'px';
                el.style.top = safeY + 'px';
                el.style.right = 'auto';
                el.style.bottom = 'auto';
            }
        } catch (e) {}

        dragHandle.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            if (handleEl && e.target.closest('button, input')) return;
            isDown = true;
            hasMoved = false;
            startX = e.clientX;
            startY = e.clientY;
            const rect = el.getBoundingClientRect();
            origX = rect.left;
            origY = rect.top;
            dragHandle.classList.add('dragging');
            try { dragHandle.setPointerCapture(e.pointerId); } catch (err) {}
        });

        dragHandle.addEventListener('pointermove', (e) => {
            if (!isDown) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (Math.abs(dx) > 6 || Math.abs(dy) > 6) hasMoved = true;
            if (hasMoved) {
                const newX = Math.max(10, Math.min(window.innerWidth - el.offsetWidth - 10, origX + dx));
                const newY = Math.max(10, Math.min(window.innerHeight - el.offsetHeight - 10, origY + dy));
                el.style.left = newX + 'px';
                el.style.top = newY + 'px';
                el.style.right = 'auto';
                el.style.bottom = 'auto';
            }
        });

        const onUp = (e) => {
            if (!isDown) return;
            isDown = false;
            dragHandle.classList.remove('dragging');
            try { dragHandle.releasePointerCapture(e.pointerId); } catch (err) {}
            if (hasMoved) {
                try {
                    const rect = el.getBoundingClientRect();
                    localStorage.setItem(storageKey, JSON.stringify({ x: rect.left, y: rect.top }));
                } catch (err) {}
                if (typeof onDragEnd === 'function') onDragEnd();
            }
        };

        dragHandle.addEventListener('pointerup', onUp);
        dragHandle.addEventListener('pointercancel', onUp);
    }

    function getCooldownUntil() {
        try { return Number(localStorage.getItem(COOLDOWN_KEY)) || 0; } catch (e) { return 0; }
    }

    function getStatusText() {
        if (!settings.enabled) return 'Автопроверка выключена';
        if (fbIsChecking) return 'Идёт проверка…';

        const now = Date.now();
        const cooldownUntil = getCooldownUntil();
        if (cooldownUntil && now < cooldownUntil) {
            return `Пауза API (429): ${formatSecsToHuman(Math.ceil((cooldownUntil - now) / 1000))}`;
        }

        if (fbNextCheckTs && fbNextCheckTs > now) {
            const rem = Math.max(0, Math.round((fbNextCheckTs - now) / 1000));
            return `Следующая проверка через ${formatSecsToHuman(rem)}`;
        }
        return 'Ожидание цикла…';
    }

    function setTextIfChanged(el, val) {
        const s = String(val);
        if (el && el.textContent !== s) el.textContent = s;
    }

    function updateUI() {
        if (fbStopped || !shadow) return;

        const now = Date.now();
        const cooldownActive = getCooldownUntil() > now;

        const dot = shadow.querySelector('.fb-btn-dot');
        if (dot) {
            dot.classList.toggle('active', settings.enabled && !fbIsChecking);
            dot.classList.toggle('checking', fbIsChecking);
        }

        const titleDot = shadow.querySelector('#fb-title-dot');
        if (titleDot) {
            titleDot.classList.toggle('active', settings.enabled && !fbIsChecking && !cooldownActive);
            titleDot.classList.toggle('checking', fbIsChecking);
            titleDot.classList.toggle('cooldown', cooldownActive && !fbIsChecking);
        }

        const headStatus = shadow.querySelector('#fb-head-status');
        if (headStatus) {
            const label = fbIsChecking ? 'Проверка' : (cooldownActive ? 'Пауза 429' : (settings.enabled ? 'Активно' : 'Выкл'));
            setTextIfChanged(headStatus, label);
        }

        if (isModalOpen && (settings.activeTab || 'main') === 'main') {
            setTextIfChanged(shadow.querySelector('#fb-status-text'), getStatusText());

            const stats = getFbStats();
            setTextIfChanged(shadow.querySelector('#fb-stat-followed'), `+${stats.followedTotal || 0}`);
            setTextIfChanged(shadow.querySelector('#fb-stat-unfollowed'), `-${stats.unfollowedTotal || 0}`);
            setTextIfChanged(
                shadow.querySelector('#fb-last-check'),
                stats.lastCheckText ? `Последняя проверка в ${stats.lastCheckText}` : 'Ещё не проверялось'
            );

            const btnNow = shadow.querySelector('#fb-btn-check-now');
            if (btnNow) {
                btnNow.disabled = fbIsChecking;
                const label = fbIsChecking ? '⏳ Проверка…' : '▶ Проверить';
                setTextIfChanged(btnNow, label);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    // 11. СТАРТ И ИНИЦИАЛИЗАЦИЯ
    // ─────────────────────────────────────────────────────────────
    if (document.readyState === 'loading') {
        on(document, 'DOMContentLoaded', ensureWidget, { once: true });
    } else {
        ensureWidget();
    }

    setInterval(() => {
        const hostParent = document.body || document.documentElement;
        if (hostParent && widgetRoot && !widgetRoot.isConnected) {
            hostParent.appendChild(widgetRoot);
        }
        updateUI();
    }, 1000);

    function stop() {
        if (fbStopped) return;
        fbStopped = true;
        releaseFollowbackLock();
        for (const id of fbIntervals) window.clearInterval(id);
        for (const id of fbTimeouts) window.clearTimeout(id);
        fbIntervals.clear();
        fbTimeouts.clear();
        for (const [target, type, fn, opts] of fbListeners) {
            try { target.removeEventListener(type, fn, opts); } catch (e) {}
        }
        fbListeners.length = 0;
        try { if (widgetRoot) widgetRoot.remove(); } catch (e) {}
        widgetRoot = null;
        shadow = null;
        try { delete window.__AON_FOLLOWBACK_LOADED__; } catch (e) {}
    }

    try {
        window.__AON_FOLLOWBACK__ = {
            toggle: () => safeToggleModal(),
            open: () => safeToggleModal(true),
            close: () => safeToggleModal(false),
            checkNow: () => performFollowbackCheck(true),
            stop
        };
    } catch (e) {}

})();
