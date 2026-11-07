// ==UserScript==
// @name         AON Followback
// @namespace    https://animeon.co/
// @version      1.3.0
// @description  Безопасная взаимная автоподписка для AnimeOn с верхними вкладками, хуманайзером и белым/чёрным списками
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
            writable: false,
            enumerable: false,
            configurable: false
        });
    } catch (e) {
        window.__AON_FOLLOWBACK_LOADED__ = true;
    }

    const DEBUG = false;
    function logDebug(...args) {
        if (DEBUG) console.log('[AON Followback]', ...args);
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
        try {
            const raw = localStorage.getItem(WHITELIST_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (e) { return []; }
    }

    function saveWhitelist(list) {
        try {
            localStorage.setItem(WHITELIST_KEY, JSON.stringify(list));
        } catch (e) {}
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

    function isWhitelisted(slug, dispName, whitelistSet) {
        if (!whitelistSet || whitelistSet.size === 0) return false;
        const s = slug ? String(slug).toLowerCase().trim() : '';
        const d = dispName ? String(dispName).toLowerCase().trim() : '';
        if (s && whitelistSet.has(s)) return true;
        if (d && whitelistSet.has(d)) return true;
        return false;
    }

    function isBlacklisted(slug, dispName, blacklistSet) {
        if (!blacklistSet || blacklistSet.size === 0) return false;
        const s = slug ? String(slug).toLowerCase().trim() : '';
        const d = dispName ? String(dispName).toLowerCase().trim() : '';
        if (s && blacklistSet.has(s)) return true;
        if (d && blacklistSet.has(d)) return true;
        return false;
    }

    function extractUsersList(data) {
        if (!data) return [];
        if (Array.isArray(data)) return data;
        if (Array.isArray(data.users)) return data.users;
        if (Array.isArray(data.data)) return data.data;
        if (Array.isArray(data.items)) return data.items;
        return [];
    }

    function extractTotal(data, fallbackCount) {
        if (!data) return fallbackCount;
        if (typeof data.total === 'number') return data.total;
        if (typeof data.total === 'string' && !isNaN(Number(data.total))) return Number(data.total);
        if (data.pagination) {
            if (typeof data.pagination.total === 'number') return data.pagination.total;
            if (typeof data.pagination.total === 'string' && !isNaN(Number(data.pagination.total))) return Number(data.pagination.total);
            if (typeof data.pagination.count === 'number') return data.pagination.count;
        }
        if (data.meta) {
            if (typeof data.meta.total === 'number') return data.meta.total;
            if (typeof data.meta.total === 'string' && !isNaN(Number(data.meta.total))) return Number(data.meta.total);
        }
        if (typeof data.count === 'number') return data.count;
        return fallbackCount;
    }

    function addToWhitelist(name) {
        const clean = normalizeName(name);
        if (!clean) return false;
        const lower = clean.toLowerCase();
        const list = getWhitelist();
        if (!list.map(s => normalizeName(s).toLowerCase()).includes(lower)) {
            list.push(clean);
            saveWhitelist(list);
            addJournalEntry(`Добавлен в белый список: ${clean}`, 'info');
            return true;
        }
        return false;
    }

    function removeFromWhitelist(name) {
        const lower = normalizeName(name).toLowerCase();
        const list = getWhitelist().filter(s => normalizeName(s).toLowerCase() !== lower);
        saveWhitelist(list);
        addJournalEntry(`Удалён из белого списка: ${normalizeName(name)}`, 'info');
    }

    function getBlacklist() {
        try {
            const raw = localStorage.getItem(BLACKLIST_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (e) { return []; }
    }

    function saveBlacklist(list) {
        try {
            localStorage.setItem(BLACKLIST_KEY, JSON.stringify(list));
        } catch (e) {}
    }

    function addToBlacklist(name) {
        const clean = normalizeName(name);
        if (!clean) return false;
        const lower = clean.toLowerCase();
        const list = getBlacklist();
        if (!list.map(s => normalizeName(s).toLowerCase()).includes(lower)) {
            list.push(clean);
            saveBlacklist(list);
            addJournalEntry(`Добавлен в чёрный список: ${clean}`, 'warn');
            return true;
        }
        return false;
    }

    function removeFromBlacklist(name) {
        const lower = normalizeName(name).toLowerCase();
        const list = getBlacklist().filter(s => normalizeName(s).toLowerCase() !== lower);
        saveBlacklist(list);
        addJournalEntry(`Удалён из чёрного списка: ${normalizeName(name)}`, 'info');
    }

    // ─────────────────────────────────────────────────────────────
    // 4. ЖУРНАЛ И СТАТИСТИКА
    // ─────────────────────────────────────────────────────────────
    function getJournal() {
        try {
            const raw = localStorage.getItem(JOURNAL_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (e) { return []; }
    }

    function addJournalEntry(text, type = 'info') {
        try {
            const items = getJournal();
            const now = new Date();
            const timeStr = [
                String(now.getHours()).padStart(2, '0'),
                String(now.getMinutes()).padStart(2, '0'),
                String(now.getSeconds()).padStart(2, '0')
            ].join(':');

            if (items.length > 0 && items[0].text === text) return;

            const entry = {
                id: Date.now() + Math.random(),
                time: timeStr,
                text,
                type // 'info', 'success', 'warn'
            };

            items.unshift(entry);
            if (items.length > 60) items.length = 60;
            localStorage.setItem(JOURNAL_KEY, JSON.stringify(items));

            if (shadow && isModalOpen && (settings.activeTab || 'main') === 'journal') {
                renderTabContent();
            }
        } catch (e) {}
    }

    function clearJournal() {
        try {
            localStorage.setItem(JOURNAL_KEY, JSON.stringify([]));
        } catch (e) {}
    }

    function getFbStats() {
        try {
            const raw = localStorage.getItem(STATS_KEY);
            return raw ? JSON.parse(raw) : { followedTotal: 0, unfollowedTotal: 0, lastCheckTs: 0, lastCheckText: '' };
        } catch (e) {
            return { followedTotal: 0, unfollowedTotal: 0, lastCheckTs: 0, lastCheckText: '' };
        }
    }

    function updateFbStats(patch) {
        try {
            const cur = getFbStats();
            const updated = { ...cur, ...patch };
            localStorage.setItem(STATS_KEY, JSON.stringify(updated));
        } catch (e) {}
    }

    // ─────────────────────────────────────────────────────────────
    // 5. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ХУМАНАЙЗЕРА
    // ─────────────────────────────────────────────────────────────
    function humanDelay(minMs = 1500, maxMs = 3500) {
        const ms = Math.floor(minMs + Math.random() * (maxMs - minMs));
        return new Promise(r => setTimeout(r, ms));
    }

    function escapeHtml(str) {
        if (!str) return '';
        const d = document.createElement('div');
        d.textContent = String(str);
        return d.innerHTML;
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

        try {
            const res = await fetch('/api/users/me', { credentials: 'include' });
            if (res.ok) {
                const j = await res.json().catch(() => null);
                const slug = j && (j.username_slug || j.slug || j.username);
                if (slug && slug !== 'me') {
                    cachedOwnSlug = String(slug);
                    return cachedOwnSlug;
                }
            }
        } catch (e) {}

        try {
            const res = await fetch('/api/auth/me', { credentials: 'include' });
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
            for (const s of Array.from(document.querySelectorAll('script'))) {
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

    async function fetchFollowersList(ownSlug) {
        const all = [];
        let total = Infinity;
        let isComplete = false;
        for (let page = 1; page <= FOLLOWBACK_MAX_PAGES && (page - 1) * FOLLOWBACK_PAGE_SIZE < total; page++) {
            let resp;
            try {
                resp = await fetch(`/api/users/${encodeURIComponent(ownSlug)}/followers?page=${page}&per_page=${FOLLOWBACK_PAGE_SIZE}`, {
                    credentials: 'include'
                });
            } catch (e) { break; }

            if (!resp || !resp.ok) {
                if (resp && resp.status === 429) throw new Error('RATE_LIMIT');
                break;
            }
            const data = await resp.json().catch(() => null);
            if (!data) break;
            const users = extractUsersList(data);
            total = extractTotal(data, (page - 1) * FOLLOWBACK_PAGE_SIZE + users.length);
            all.push(...users);
            if (users.length < FOLLOWBACK_PAGE_SIZE || (page * FOLLOWBACK_PAGE_SIZE >= total)) {
                isComplete = true;
                break;
            }
        }
        return { all, total: isFinite(total) ? total : all.length, complete: isComplete };
    }

    async function fetchFollowingData(ownSlug) {
        const slugs = [];
        const caseMap = new Map();
        const namesMap = {};
        let total = Infinity;
        let isComplete = false;
        for (let page = 1; page <= FOLLOWBACK_MAX_PAGES && (page - 1) * FOLLOWBACK_PAGE_SIZE < total; page++) {
            let resp;
            try {
                resp = await fetch(`/api/users/${encodeURIComponent(ownSlug)}/following?page=${page}&per_page=${FOLLOWBACK_PAGE_SIZE}`, {
                    credentials: 'include'
                });
            } catch (e) { return null; }

            if (!resp || !resp.ok) {
                if (resp && resp.status === 429) throw new Error('RATE_LIMIT');
                return null;
            }
            const data = await resp.json().catch(() => null);
            if (!data) return null;
            const users = extractUsersList(data);
            total = extractTotal(data, (page - 1) * FOLLOWBACK_PAGE_SIZE + users.length);
            for (const u of users) {
                const orig = getUserSlug(u);
                if (orig) {
                    const s = orig.toLowerCase();
                    slugs.push(s);
                    if (!caseMap.has(s)) caseMap.set(s, orig);
                    const disp = getUserDisplayName(u);
                    if (disp) namesMap[s] = disp;
                }
            }
            if (users.length < FOLLOWBACK_PAGE_SIZE || (page * FOLLOWBACK_PAGE_SIZE >= total)) {
                isComplete = true;
                break;
            }
        }
        return {
            slugs,
            caseMap,
            namesMap,
            total: isFinite(total) ? total : slugs.length,
            complete: isComplete
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

    // ─────────────────────────────────────────────────────────────
    // 8. ЦИКЛ АВТОПОДПИСКИ (МАКС 5 ДЕЙСТВИЙ РАЗ В 5 МИНУТ)
    // ─────────────────────────────────────────────────────────────
    let fbIsChecking = false;
    let fbTimer = null;
    let fbNextCheckTs = 0;

    async function performFollowbackCheck(isManual = false) {
        if (fbIsChecking) return;
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
                if (isManual) addJournalEntry('Ошибка: не удалось определить аккаунт (войдите на сайт)', 'warn');
                return;
            }

            await humanDelay(600, 1200);

            const followersData = await fetchFollowersList(ownSlug);
            const allFollowers = followersData.all || [];
            const totalFollowers = followersData.total || 0;

            await humanDelay(800, 1500);

            const followingData = await fetchFollowingData(ownSlug);
            if (!followingData) return;

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
                if (!listsComplete) {
                    addJournalEntry('Зеркальная отписка приостановлена: список подписок/читателей слишком велик для безопасного сравнения', 'warn');
                } else {
                    const followerSlugs = new Set();
                    for (const u of allFollowers) {
                        const s = getUserSlug(u);
                        if (s) followerSlugs.add(s.toLowerCase());
                    }

                    // Зеркальная отписка от всех, кто не подписан на нас (кроме белого списка)
                    const toUnfollow = Array.from(followingSet).filter(slug => {
                        const disp = nameMap[slug] || slug;
                        if (isWhitelisted(slug, disp, whitelist)) return false; // Иммунитет белого списка
                        return !followerSlugs.has(slug);                       // Человек не подписан на нас
                    }).slice(0, MAX_ACTIONS_PER_RUN - actionsDone);

                    for (const slug of toUnfollow) {
                        if (actionsDone >= MAX_ACTIONS_PER_RUN) break;
                        await humanDelay(1500, 3200);
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
                                addJournalEntry(`Зеркальная отписка: ${dispName}`, 'warn');
                            } else if (res.status === 429) {
                                throw new Error('RATE_LIMIT');
                            } else {
                                addJournalEntry(`Ошибка отписки от ${origCase} (HTTP ${res.status})`, 'warn');
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
                if (isBlacklisted(slug, disp, blacklist)) continue;
                if (u.is_following || followingSet.has(slug) || doneSet.has(slug)) continue;
                toFollow.push({ ...u, _slug: slug, _orig: slugRaw, _disp: disp });
            }

            let followedCount = 0;
            if (toFollow.length > 0 && actionsDone < MAX_ACTIONS_PER_RUN) {
                const batch = toFollow.slice(0, MAX_ACTIONS_PER_RUN - actionsDone);

                for (const u of batch) {
                    if (actionsDone >= MAX_ACTIONS_PER_RUN) break;
                    await humanDelay(1600, 3400);
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
                            addJournalEntry(`Подписка: ${dispName}`, 'success');
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
            const timeStr = new Date().toLocaleTimeString();
            updateFbStats({
                followedTotal: (curStats.followedTotal || 0) + followedCount,
                unfollowedTotal: (curStats.unfollowedTotal || 0) + unfollowedCount,
                lastCheckTs: Date.now(),
                lastCheckText: timeStr
            });

            if (isManual && followedCount === 0 && unfollowedCount === 0) {
                addJournalEntry('Проверка: всё синхронно, новых подписчиков нет', 'info');
            }

        } catch (err) {
            if (err.message === 'RATE_LIMIT') {
                const cool = Date.now() + 15 * 60 * 1000;
                try { localStorage.setItem(COOLDOWN_KEY, String(cool)); } catch (e) {}
                addJournalEntry('Лимит API (429). Пауза 15 минут.', 'warn');
            }
        } finally {
            fbIsChecking = false;
            updateUI();
            scheduleNextCheck();
        }
    }

    function scheduleNextCheck(delaySec) {
        if (fbTimer) { clearTimeout(fbTimer); fbTimer = null; }
        if (!settings.enabled) return;

        let sec = delaySec;
        if (!sec) {
            sec = Math.floor(285 + Math.random() * 30); // ~5 минут
        }

        fbNextCheckTs = Date.now() + sec * 1000;
        updateUI();
        fbTimer = setTimeout(() => {
            performFollowbackCheck(false);
        }, sec * 1000);
    }

    // ─────────────────────────────────────────────────────────────
    // 9. ИНТЕРФЕЙС С ВЕРХНИМИ ВКЛАДКАМИ (TOP TABS)
    // ─────────────────────────────────────────────────────────────
    let widgetRoot = null;
    let shadow = null;
    let isModalOpen = false;
    let activeListTab = 'white'; // 'white' | 'black' для вкладки Списки
    let lastToggleTime = 0;

    function safeToggleModal(forceState) {
        const now = Date.now();
        if (typeof forceState !== 'boolean' && (now - lastToggleTime < 250)) {
            return;
        }
        lastToggleTime = now;
        toggleModal(forceState);
    }

    function ensureWidget() {
        if (!document.body) {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', ensureWidget, { once: true });
            }
            return;
        }

        if (widgetRoot && shadow && shadow.querySelector('.fb-window')) {
            if (!document.body.contains(widgetRoot)) {
                document.body.appendChild(widgetRoot);
            }
            return;
        }

        const existing = document.getElementById('aon-followback-root');
        if (existing) {
            if (existing.shadowRoot && existing.shadowRoot.querySelector('.fb-window')) {
                widgetRoot = existing;
                shadow = existing.shadowRoot;
                if (!document.body.contains(widgetRoot)) {
                    document.body.appendChild(widgetRoot);
                }
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
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;
                color: #ffffff;
            }

            *, *::before, *::after {
                box-sizing: border-box;
                margin: 0;
                padding: 0;
                scrollbar-width: none !important;
                -ms-overflow-style: none !important;
            }

            ::-webkit-scrollbar {
                display: none !important;
                width: 0 !important;
                height: 0 !important;
            }

            /* ── Плавающая мини-кнопка (уменьшена в 2-3 раза) ── */
            .fb-btn {
                position: fixed;
                bottom: 96px;
                right: 24px;
                width: 28px;
                height: 28px;
                border-radius: 9px;
                background: rgba(24, 24, 27, 0.92);
                border: 1px solid rgba(255, 255, 255, 0.12);
                color: #ffffff;
                box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.08);
                backdrop-filter: blur(14px);
                -webkit-backdrop-filter: blur(14px);
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: grab;
                user-select: none;
                touch-action: none;
                z-index: 2147483644;
                transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
            }
            .fb-btn:hover {
                border-color: rgba(139, 92, 246, 0.5);
                transform: translateY(-1.5px) scale(1.06);
                box-shadow: 0 6px 18px rgba(0, 0, 0, 0.65), 0 0 12px rgba(139, 92, 246, 0.3);
            }
            .fb-btn:active {
                transform: scale(0.92);
            }
            .fb-btn.dragging {
                cursor: grabbing;
                transform: scale(0.94);
            }
            .fb-btn svg {
                width: 15px;
                height: 15px;
                stroke: #c4b5fd;
                stroke-width: 2.2;
                fill: none;
                transition: stroke 0.18s ease;
            }
            .fb-btn:hover svg {
                stroke: #ddd6fe;
            }

            .fb-btn-dot {
                position: absolute;
                top: -2px;
                right: -2px;
                width: 7px;
                height: 7px;
                border-radius: 50%;
                background: #52525b;
                border: 1.5px solid #09090b;
                pointer-events: none;
                transition: background 0.2s ease, box-shadow 0.2s ease;
            }
            .fb-btn-dot.active {
                background: #8b5cf6;
                box-shadow: 0 0 8px rgba(124, 77, 255, 0.85);
            }

            /* ── Компактное окно меню с верхними кнопками ── */
            .fb-window {
                position: fixed;
                bottom: 134px;
                right: 24px;
                width: 380px;
                max-width: calc(100vw - 32px);
                background: rgba(18, 18, 26, 0.97);
                backdrop-filter: blur(24px);
                -webkit-backdrop-filter: blur(24px);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 18px;
                box-shadow: 0 20px 50px rgba(0, 0, 0, 0.7), 0 0 30px rgba(139, 92, 246, 0.18);
                z-index: 2147483645;
                overflow: hidden;
                display: none;
                flex-direction: column;
                animation: fbPopIn .18s cubic-bezier(0.16, 1, 0.3, 1) forwards;
            }
            @keyframes fbPopIn {
                from { opacity: 0; transform: scale(0.95) translateY(8px); }
                to { opacity: 1; transform: scale(1) translateY(0); }
            }

            /* ── Шапка ── */
            .fb-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 12px 16px;
                background: rgba(255, 255, 255, 0.02);
                border-bottom: 1px solid rgba(255, 255, 255, 0.06);
                cursor: grab;
                user-select: none;
            }
            .fb-head.dragging { cursor: grabbing; }

            .fb-title-wrap {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .fb-title-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #52525b;
                transition: background .2s ease;
            }
            .fb-title-dot.active {
                background: #34d399;
                box-shadow: 0 0 8px #34d399;
            }
            .fb-title {
                font-size: 13.5px;
                font-weight: 700;
                color: #ffffff;
            }

            .fb-close {
                width: 24px;
                height: 24px;
                border-radius: 7px;
                background: rgba(255, 255, 255, 0.05);
                border: none;
                color: #a49fb5;
                cursor: pointer;
                display: grid;
                place-items: center;
                font-size: 14px;
                line-height: 1;
                transition: all .14s ease;
            }
            .fb-close:hover {
                background: rgba(255, 255, 255, 0.12);
                color: #ffffff;
            }

            /* ── ВЕРХНИЕ ВКЛАДКИ (TOP TABS) ── */
            .fb-top-tabs {
                display: flex;
                gap: 4px;
                padding: 6px 12px;
                background: rgba(0, 0, 0, 0.25);
                border-bottom: 1px solid rgba(255, 255, 255, 0.06);
                user-select: none;
            }
            .fb-top-tab {
                flex: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                padding: 7px 10px;
                border-radius: 8px;
                border: 1px solid transparent;
                background: transparent;
                color: #9490a5;
                font-size: 11.5px;
                font-weight: 600;
                cursor: pointer;
                transition: all .15s ease;
            }
            .fb-top-tab:hover {
                color: #ffffff;
                background: rgba(255, 255, 255, 0.04);
            }
            .fb-top-tab.active {
                color: #ffffff;
                background: rgba(139, 92, 246, 0.22);
                border-color: rgba(139, 92, 246, 0.4);
                box-shadow: 0 0 12px rgba(139, 92, 246, 0.2);
            }
            .fb-top-tab svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2; }

            /* ── Тело окна ── */
            .fb-body {
                padding: 14px 16px;
                display: flex;
                flex-direction: column;
                gap: 12px;
                min-height: 220px;
            }

            /* ── Карточки ── */
            .fb-card {
                background: rgba(255, 255, 255, 0.025);
                border: 1px solid rgba(255, 255, 255, 0.06);
                border-radius: 12px;
                padding: 10px 12px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            .fb-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
            }
            .fb-label {
                font-size: 12.5px;
                font-weight: 600;
                color: #ffffff;
            }
            .fb-sub {
                font-size: 10.5px;
                color: #837e96;
                margin-top: 1px;
            }

            /* ── Тумблер ── */
            .fb-switch {
                position: relative;
                display: inline-block;
                width: 38px;
                height: 20px;
                flex-shrink: 0;
            }
            .fb-switch input { opacity: 0; width: 0; height: 0; }
            .fb-slider {
                position: absolute;
                cursor: pointer;
                inset: 0;
                background-color: rgba(255, 255, 255, 0.12);
                transition: .2s;
                border-radius: 20px;
                border: 1px solid rgba(255, 255, 255, 0.08);
            }
            .fb-slider:before {
                position: absolute;
                content: "";
                height: 14px;
                width: 14px;
                left: 2px;
                bottom: 2px;
                background-color: #ffffff;
                transition: .2s;
                border-radius: 50%;
            }
            .fb-switch input:checked + .fb-slider {
                background: linear-gradient(135deg, #8b5cf6, #7c3aed);
                border-color: #a78bfa;
            }
            .fb-switch input:checked + .fb-slider:before {
                transform: translateX(18px);
            }

            /* ── Блок списков ── */
            .fb-list-pills {
                display: flex;
                gap: 6px;
                background: rgba(0, 0, 0, 0.25);
                padding: 3px;
                border-radius: 9px;
            }
            .fb-pill {
                flex: 1;
                padding: 6px 8px;
                border: none;
                border-radius: 7px;
                background: transparent;
                font-size: 11.5px;
                font-weight: 600;
                color: #8c879d;
                cursor: pointer;
                transition: all .16s ease;
                text-align: center;
            }
            .fb-pill:hover { color: #ffffff; }
            .fb-pill.active.white {
                background: rgba(52, 211, 153, 0.2);
                color: #6ee7b7;
            }
            .fb-pill.active.black {
                background: rgba(239, 68, 68, 0.2);
                color: #fca5a5;
            }

            .fb-add-row {
                display: flex;
                gap: 6px;
            }
            .fb-input {
                flex: 1;
                background: rgba(0, 0, 0, 0.35);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 7px;
                padding: 6px 10px;
                color: #ffffff;
                font-size: 11.5px;
                outline: none;
                transition: border-color .14s ease;
            }
            .fb-input:focus { border-color: #8b5cf6; }

            .fb-add-btn {
                background: #8b5cf6;
                border: none;
                border-radius: 7px;
                padding: 0 12px;
                color: #ffffff;
                font-size: 14px;
                font-weight: 700;
                cursor: pointer;
                transition: opacity .14s ease;
            }
            .fb-add-btn:hover { opacity: 0.9; }

            .fb-tags-wrap {
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
                max-height: 110px;
                overflow-y: auto;
                padding-top: 2px;
            }
            .fb-tag {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                padding: 3px 8px;
                border-radius: 6px;
                font-size: 11px;
                font-weight: 500;
            }
            .fb-tag.whitelist {
                background: rgba(52, 211, 153, 0.12);
                border: 1px solid rgba(52, 211, 153, 0.3);
                color: #6ee7b7;
            }
            .fb-tag.blacklist {
                background: rgba(239, 68, 68, 0.12);
                border: 1px solid rgba(239, 68, 68, 0.3);
                color: #fca5a5;
            }
            .fb-tag button {
                background: transparent;
                border: none;
                color: inherit;
                cursor: pointer;
                font-size: 12px;
                line-height: 1;
                opacity: 0.6;
            }
            .fb-tag button:hover { opacity: 1; }
            .fb-empty-hint {
                font-size: 11px;
                color: #69657b;
                font-style: italic;
                padding: 4px 0;
            }

            /* ── Кнопки и действия ── */
            .fb-action-btn {
                background: linear-gradient(135deg, #8b5cf6, #7c3aed);
                border: none;
                border-radius: 8px;
                color: #ffffff;
                font-size: 11.5px;
                font-weight: 600;
                padding: 8px 12px;
                cursor: pointer;
                transition: transform .14s ease, opacity .14s ease;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                width: 100%;
            }
            .fb-action-btn:hover { opacity: 0.92; transform: translateY(-1px); }
            .fb-action-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

            /* ── Журнал ── */
            .fb-journal-list {
                display: flex;
                flex-direction: column;
                gap: 5px;
                max-height: 170px;
                overflow-y: auto;
            }
            .fb-journal-item {
                background: rgba(0, 0, 0, 0.25);
                border-radius: 7px;
                padding: 6px 8px;
                font-size: 11px;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .fb-journal-item.success { border-left: 2px solid #34d399; }
            .fb-journal-item.warn { border-left: 2px solid #f87171; }
            .fb-journal-item.info { border-left: 2px solid #8b5cf6; }
            .fb-journal-time { color: #69647d; font-family: monospace; font-size: 10px; }
            .fb-journal-text { color: #ded9ec; flex: 1; word-break: break-word; }

            /* ── Тост ── */
            .fb-toast {
                position: fixed;
                bottom: 24px;
                left: 24px;
                z-index: 2147483647;
                background: rgba(24, 24, 32, 0.96);
                border: 1px solid rgba(139, 92, 246, 0.4);
                border-left: 3px solid #8b5cf6;
                border-radius: 10px;
                padding: 8px 12px;
                color: #ffffff;
                box-shadow: 0 10px 30px rgba(0,0,0,0.5);
                font-size: 11.5px;
                display: flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;
                animation: fbPopIn .18s ease forwards;
            }
        `;
        shadow.appendChild(style);

        // Кнопка (дизайн идентичен кнопке чата AnimeOn)
        const btn = document.createElement('div');
        btn.className = 'fb-btn';
        btn.setAttribute('title', 'Взаимная автоподписка');
        btn.innerHTML = `
            <svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>
            <span class="fb-btn-dot ${settings.enabled ? 'active' : ''}"></span>
        `;
        shadow.appendChild(btn);

        // Окно с верхними кнопками
        const win = document.createElement('div');
        win.className = 'fb-window';
        win.innerHTML = `
            <div class="fb-head" id="fb-win-head">
                <div class="fb-title-wrap">
                    <span class="fb-title-dot ${settings.enabled ? 'active' : ''}" id="fb-title-dot"></span>
                    <span class="fb-title">Автоподписка</span>
                </div>
                <button class="fb-close" id="fb-win-close" title="Закрыть">&times;</button>
            </div>

            <!-- ВЕРХНИЕ ВКЛАДКИ -->
            <div class="fb-top-tabs">
                <button class="fb-top-tab active" data-tab="main">
                    <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                    <span>Настройки</span>
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

            <div class="fb-body" id="fb-win-body"></div>
        `;
        shadow.appendChild(win);

        document.body.appendChild(widgetRoot);

        let btnJustDragged = false;
        setupDraggable(btn, BTN_POS_KEY, null, () => {
            btnJustDragged = true;
            setTimeout(() => { btnJustDragged = false; }, 150);
        });
        setupDraggable(win, MODAL_POS_KEY, win.querySelector('#fb-win-head'));

        // Клик по плавающей кнопке (с защитой от случайного открытия при перетаскивании)
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (btnJustDragged) return;
            safeToggleModal();
        });

        win.querySelector('#fb-win-close').addEventListener('click', () => safeToggleModal(false));

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && isModalOpen) safeToggleModal(false);
        });

        // Переключение верхних вкладок
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
                <!-- Тумблер 1: Взаимная подписка -->
                <div class="fb-card">
                    <div class="fb-row">
                        <div>
                            <div class="fb-label">Взаимная подписка</div>
                            <div class="fb-sub">Подписываться в ответ на читателей</div>
                        </div>
                        <label class="fb-switch">
                            <input type="checkbox" id="fb-toggle-enabled" ${settings.enabled ? 'checked' : ''}>
                            <span class="fb-slider"></span>
                        </label>
                    </div>

                    <div style="border-top: 1px solid rgba(255,255,255,0.06); padding-top: 8px;">
                        <div class="fb-row">
                            <div>
                                <div class="fb-label">Зеркальная отписка</div>
                                <div class="fb-sub">Отписываться, если читатель отписался</div>
                            </div>
                            <label class="fb-switch">
                                <input type="checkbox" id="fb-toggle-unfollow" ${settings.unfollowEnabled ? 'checked' : ''}>
                                <span class="fb-slider"></span>
                            </label>
                        </div>
                    </div>
                </div>

                <!-- Статус и счетчик -->
                <div class="fb-card">
                    <div class="fb-row">
                        <span style="font-size: 11px; color: #a49fb5;" id="fb-status-text">${getStatusText()}</span>
                        <span style="font-size: 11px; font-weight: 600; color: #6ee7b7; font-family: monospace;" id="fb-stats-mini">
                            +${stats.followedTotal || 0} / -${stats.unfollowedTotal || 0}
                        </span>
                    </div>
                    <button class="fb-action-btn" id="fb-btn-check-now" style="margin-top: 2px;">
                        <span>▶</span> Проверить сейчас (до 5)
                    </button>
                </div>

                <div style="font-size: 10.5px; color: #726d83; line-height: 1.4; text-align: center;">
                    Безопасный режим: проверка раз в 5 минут, не более 5 действий за раз, человеческие паузы 1.5–3.5с.
                </div>
            `;

            body.querySelector('#fb-toggle-enabled').addEventListener('change', (e) => {
                settings.enabled = e.target.checked;
                saveSettings({ enabled: e.target.checked });
                if (settings.enabled) scheduleNextCheck(10);
                else if (fbTimer) { clearTimeout(fbTimer); fbTimer = null; fbNextCheckTs = 0; }
                updateUI();
            });

            body.querySelector('#fb-toggle-unfollow').addEventListener('change', (e) => {
                settings.unfollowEnabled = e.target.checked;
                saveSettings({ unfollowEnabled: e.target.checked });
                updateUI();
            });

            body.querySelector('#fb-btn-check-now').addEventListener('click', async () => {
                const btnEl = body.querySelector('#fb-btn-check-now');
                if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⏳ Проверка…'; }
                try {
                    await performFollowbackCheck(true);
                } finally {
                    if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = '<span>▶</span> Проверить сейчас (до 5)'; }
                    renderTabContent();
                }
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
                    <input type="text" class="fb-input" id="fb-input-nick" placeholder="${activeListTab === 'white' ? 'Иммунитет от отписки...' : 'Игнор (без взаимки)...'}">
                    <button class="fb-add-btn" id="fb-btn-add" title="Добавить">+</button>
                </div>

                <div class="fb-card" style="min-height: 120px;">
                    <div class="fb-tags-wrap" id="fb-tags-container">
                        ${currentList.length ? currentList.map(name => `
                            <div class="fb-tag ${activeListTab === 'white' ? 'whitelist' : 'blacklist'}">
                                <span>${escapeHtml(name)}</span>
                                <button data-del="${escapeHtml(name)}" title="Удалить">&times;</button>
                            </div>
                        `).join('') : `<div class="fb-empty-hint">${activeListTab === 'white' ? 'Белый список пуст. Скрипт никогда не отпишется от этих пользователей.' : 'Чёрный список пуст. Скрипт никогда не подпишется на них в ответ.'}</div>`}
                    </div>
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
            const addBtn = body.querySelector('#fb-btn-add');
            const doAdd = () => {
                if (!inEl || !inEl.value.trim()) return;
                const val = inEl.value.trim();
                if (activeListTab === 'white') addToWhitelist(val);
                else addToBlacklist(val);
                inEl.value = '';
                renderTabContent();
            };
            addBtn.addEventListener('click', doAdd);
            inEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });

            body.querySelectorAll('[data-del]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const name = btn.dataset.del;
                    if (activeListTab === 'white') removeFromWhitelist(name);
                    else removeFromBlacklist(name);
                    renderTabContent();
                });
            });

        } else if (curTab === 'journal') {
            const items = getJournal();

            body.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: space-between;">
                    <span style="font-size: 11.5px; color: #a49fb5; font-weight: 600;">Записей: ${items.length}</span>
                    <button id="fb-btn-clear-j" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #ded9ec; border-radius: 6px; padding: 4px 8px; font-size: 10.5px; cursor: pointer;">Очистить</button>
                </div>

                <div class="fb-journal-list">
                    ${items.length ? items.map(it => `
                        <div class="fb-journal-item ${it.type || 'info'}">
                            <span class="fb-journal-time">${it.time}</span>
                            <span class="fb-journal-text">${escapeHtml(it.text)}</span>
                        </div>
                    `).join('') : '<div class="fb-empty-hint" style="text-align:center; padding: 20px 0;">Журнал пуст</div>'}
                </div>
            `;

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
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>
            <span>${escapeHtml(text)}</span>
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
                const width = el.offsetWidth || (el.classList.contains('fb-window') ? 380 : 28);
                const height = el.offsetHeight || (el.classList.contains('fb-window') ? 300 : 28);
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
            if (Math.abs(dx) > 7 || Math.abs(dy) > 7) hasMoved = true;
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

    function getStatusText() {
        if (!settings.enabled) return 'Выключено';
        if (fbIsChecking) return 'Проверка…';

        const now = Date.now();
        let cooldownUntil = 0;
        try { cooldownUntil = Number(localStorage.getItem(COOLDOWN_KEY)) || 0; } catch (e) {}
        if (cooldownUntil && now < cooldownUntil) {
            return `Лимит (429): ${formatSecsToHuman(Math.ceil((cooldownUntil - now) / 1000))}`;
        }

        if (fbNextCheckTs && fbNextCheckTs > now) {
            const rem = Math.max(0, Math.round((fbNextCheckTs - now) / 1000));
            return `Через ${formatSecsToHuman(rem)}`;
        }
        return 'Ожидание…';
    }

    function updateUI() {
        if (!shadow) return;

        const dot = shadow.querySelector('.fb-btn-dot');
        if (dot) dot.classList.toggle('active', settings.enabled);

        const titleDot = shadow.querySelector('#fb-title-dot');
        if (titleDot) titleDot.classList.toggle('active', settings.enabled);

        if (isModalOpen && (settings.activeTab || 'main') === 'main') {
            const statusEl = shadow.querySelector('#fb-status-text');
            if (statusEl) statusEl.textContent = getStatusText();

            const statsEl = shadow.querySelector('#fb-stats-mini');
            if (statsEl) {
                const stats = getFbStats();
                statsEl.textContent = `+${stats.followedTotal || 0} / -${stats.unfollowedTotal || 0}`;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    // 11. СТАРТ И ИНИЦИАЛИЗАЦИЯ
    // ─────────────────────────────────────────────────────────────
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureWidget, { once: true });
    } else {
        ensureWidget();
    }

    setInterval(() => {
        if (document.body && widgetRoot && !document.body.contains(widgetRoot)) {
            document.body.appendChild(widgetRoot);
        }
        updateUI();
    }, 1000);

    try {
        window.__AON_FOLLOWBACK__ = {
            toggle: () => safeToggleModal(),
            open: () => safeToggleModal(true),
            close: () => safeToggleModal(false),
            checkNow: () => performFollowbackCheck(true)
        };
    } catch (e) {}

})();
