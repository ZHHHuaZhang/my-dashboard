/**
 * CloudBase 统一数据同步层
 * ------------------------------------------------------------
 * 为 my-dashboard 各模块提供「手机 <-> 电脑」的自动云同步。
 *
 * 设计要点：
 * 1. 零业务侵入：通过快照哈希自动发现增删改，业务代码无需埋点。
 * 2. 记录级合并：每条记录独立带 updated_at，按 LWW 合并，不整包覆盖。
 * 3. 墓碑删除：删除不同步为"消失"，而是同步为墓碑，避免删除被回灌。
 * 4. 增量传输：只拉 updated_at > since 的记录，只推哈希变化的记录。
 * 5. 归属安全：uid 由服务端根据 JWT 自动填充，前端永远不传 uid。
 *
 * 依赖：assets/cloudbase-sdk.js（提供全局 window.cloudbase）
 */
(function (global) {
    'use strict';

    var CONFIG = {
        env: 'mycloudbase-d2g3grx15f32df45e',
        table: 'sync_records',
        scanInterval: 5000,      // 本地变更扫描间隔（纯本地计算，不产生网络请求）
        pushDelay: 1200,         // 检测到变更后的防抖推送延迟
        // 网络拉取策略：按次计费，必须严格克制。
        // checkInterval 只是"检查"定时器，本身不发包；
        // 仅当页面可见且距上次同步超过 idlePullInterval 时才真正请求。
        checkInterval: 60000,    // 检查间隔
        idlePullInterval: 900000,// 空闲时最小拉取间隔（15 分钟）
        maxDailyCalls: 200,      // 每日网络请求熔断上限（约 2 点/天），防止异常循环烧穿额度
        batchSize: 500,          // 单批 upsert 条数
        tombstoneTTL: 90 * 24 * 3600 * 1000,
        singleId: '__singleton__',
        deleteGuardCount: 10,    // 单次删除达到该条数需二次确认（防批量误删）
        deleteGuardRatio: 0.5,   // 或达到存量该比例需二次确认（防全量误删）
        backupVersion: 2         // 外部备份文件格式版本（Gitee / 导出 JSON）
    };

    var SINGLE = CONFIG.singleId;
    var TABLE = CONFIG.table;

    // ---------- 运行时状态 ----------
    var app = null, auth = null, db = null;
    var session = null, userEmail = '';
    var started = false, syncing = false, online = true;
    var adapters = {};          // module -> adapter
    var moduleOrder = [];
    var pushTimers = {};
    var scanTimer = null, pullTimer = null;
    var statusListeners = [];
    var lastSyncAt = 0, lastError = null;
    var verifyOtpFn = null;     // signInWithOtp 返回的校验回调

    // ---------- 服务端时钟基准 ----------
    // 各设备本地时钟可能相差数分钟甚至数小时。若直接拿本地 Date.now() 写 updated_at，
    // 时钟偏快的设备会用"更旧的内容 + 更大的时间戳"在 LWW 中覆盖掉其他设备的新数据。
    // 这里通过云函数取服务端时间，算出本机与服务器的偏差，写库时间戳统一走 serverNow()。
    var clockOffset = 0;        // 服务端时间 - 本机时间（毫秒）
    var clockTs = 0;            // 上次校准时的本机时刻
    var CLOCK_TTL_MS = 30 * 60 * 1000;
    var CLOCK_FN = 'serverTime';

    // ---------- 误删恢复面板状态 ----------
    var uiDeleted = null;       // null = 未打开恢复面板；数组 = 已加载的墓碑列表
    var uiDeletedBusy = false;

    // ---------- 基础工具 ----------
    function now() { return Date.now(); }

    function hashStr(s) {
        var h = 5381, i;
        for (i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
        return h.toString(36);
    }

    function stableStringify(v) {
        return JSON.stringify(v === undefined ? null : v);
    }

    var DEVICE_ID = (function () {
        try {
            var id = localStorage.getItem('__cbsync_device_id');
            if (!id) {
                id = 'dev-' + Math.random().toString(36).slice(2, 10);
                localStorage.setItem('__cbsync_device_id', id);
            }
            return id;
        } catch (e) { return 'dev-unknown'; }
    })();

    function metaKey(m) { return '__cbsync_meta_' + m; }
    function sinceKey(m) { return '__cbsync_since_' + m; }

    function loadMeta(m) {
        try { return JSON.parse(localStorage.getItem(metaKey(m)) || '{}') || {}; }
        catch (e) { return {}; }
    }

    function saveMeta(m, meta) {
        var t = now(), k;
        for (k in meta) {
            if (meta[k] && meta[k].d && (t - meta[k].u > CONFIG.tombstoneTTL)) delete meta[k];
        }
        try { localStorage.setItem(metaKey(m), JSON.stringify(meta)); } catch (e) { }
    }

    function getSince(m) {
        var v = parseInt(localStorage.getItem(sinceKey(m)) || '0', 10);
        return isNaN(v) ? 0 : v;
    }

    function setSince(m, v) {
        try { localStorage.setItem(sinceKey(m), String(v)); } catch (e) { }
    }

    // ---------- 显式删除队列 ----------
    // 删除是唯一不可逆的操作，绝不能靠"列表里消失了"来推断：
    // 一旦本地数据加载失败/为空，推断式删除会把所有记录打成墓碑并抹掉云端，造成全端数据丢失。
    // 因此删除必须由业务代码显式登记，且持久化到 localStorage，确保同步成功前不丢。
    function delKey(m) { return '__cbsync_del_' + m; }

    function loadPendingDeletes(m) {
        try {
            var o = JSON.parse(localStorage.getItem(delKey(m)) || '{}');
            return (o && typeof o === 'object') ? o : {};
        } catch (e) { return {}; }
    }

    function savePendingDeletes(m, obj) {
        try {
            if (!obj || !Object.keys(obj).length) localStorage.removeItem(delKey(m));
            else localStorage.setItem(delKey(m), JSON.stringify(obj));
        } catch (e) { }
    }

    /**
     * 业务代码在删除一条记录时必须调用：登记一次显式删除。
     * @param {string} m    模块名（与 attach 时的 module 一致）
     * @param {string} id   记录主键
     * @param {*}      data 可选：被删记录的原始数据，用于墓碑保留、便于后续恢复
     * @returns {boolean} 是否登记成功
     */
    function markDeleted(m, id, data) {
        id = String(id);
        if (!id || id === 'undefined' || id === 'null') return false;

        // 调用时若记录仍在列表中，自动抓取原始数据，避免墓碑把数据清成 {}
        if (data === undefined) {
            var ad = adapters[m];
            if (ad && ad.mode !== 'single') {
                try {
                    var items = currentItems(ad);
                    for (var i = 0; i < items.length; i++) {
                        if (items[i].id === id) { data = items[i].value; break; }
                    }
                } catch (e) { /* 忽略取数异常，退化为无原始数据 */ }
            }
        }

        var pending = loadPendingDeletes(m);
        pending[id] = { ts: now(), data: data === undefined ? {} : data };
        savePendingDeletes(m, pending);

        // 已登录则尽快推送（防抖），未登录时记录留存，登录后首次同步时生效
        if (session) {
            clearTimeout(pushTimers[m]);
            pushTimers[m] = setTimeout(function () { syncModule(m); }, CONFIG.pushDelay);
        }
        return true;
    }

    /**
     * 全量覆盖场景（导入 / 重置）专用：把当前列表中"未出现在新数据里"的记录登记为显式删除。
     * 必须在替换数组【之前】调用，否则被覆盖掉的旧记录会残留在云端，下次拉取时被"复活"。
     * @param {string} m       模块名
     * @param {Array}  keepIds 新数据中保留下来的 id 列表
     * @returns {number} 登记为删除的条数
     */
    function markReplaced(m, keepIds) {
        var ad = adapters[m];
        if (!ad || ad.mode === 'single') return 0;

        var keep = {}, validKeep = 0;
        (keepIds || []).forEach(function (id) {
            var k = String(id);
            if (!k || k === 'undefined' || k === 'null') return;
            keep[k] = true; validKeep++;
        });

        var items;
        try { items = currentItems(ad); } catch (e) { return 0; }

        // 先算出待删清单，过完保护再落盘，避免保护未生效就已经写进队列
        var toDelete = [];
        for (var i = 0; i < items.length; i++) {
            var id = items[i].id;
            if (!id || id === 'undefined' || id === 'null') continue;
            if (keep[id]) continue;
            toDelete.push({ id: id, data: items[i].value });
        }
        var count = toDelete.length;
        if (!count) return 0;

        // ---- 批量删除保护（熔断）----
        var total = items.length;
        var noValidKeep = validKeep === 0;
        var overCount = count >= CONFIG.deleteGuardCount;
        var overRatio = count >= total * CONFIG.deleteGuardRatio;
        if (noValidKeep || overCount || overRatio) {
            var tip = noValidKeep
                ? '新数据中没有有效 id，本次覆盖会把全部 ' + count + ' 条云端记录标记为删除。确定继续吗？\n（选"取消"将只覆盖本地，云端记录保持不变）'
                : '本次覆盖会把 ' + count + ' 条云端记录标记为删除（当前共 ' + total + ' 条）。确定继续吗？';
            if (typeof global.confirm === 'function' && !global.confirm(tip)) {
                console.warn('[CloudSync] 已取消批量删除，云端记录保持不变');
                return false;   // 业务代码应据此中止覆盖
            }
        }

        // 一次性写入，避免逐条 markDeleted 造成大量 localStorage 写操作
        var pending = loadPendingDeletes(m);
        var t = now();
        for (var j = 0; j < toDelete.length; j++) {
            pending[toDelete[j].id] = { ts: t, data: toDelete[j].data };
        }
        savePendingDeletes(m, pending);
        if (session) {
            clearTimeout(pushTimers[m]);
            pushTimers[m] = setTimeout(function () { syncModule(m); }, CONFIG.pushDelay);
        }
        return count;
    }

    // ---------- 外部数据合并（备份恢复 / 示例数据）----------
    // 全量覆盖是数据丢失的主要来源：用一份较旧的备份覆盖本地后，因为增量位点 since 只增不减，
    // 被覆盖掉的记录既不在本地、又因 updated_at < since 永远拉不回来，表现为"永久丢失"。
    // 这里改为按 id 合并：本地独有的保留、双方都有则取较新的一方、备份独有的补进来。
    function toNum(v) {
        var n = Number(v);
        return (v === undefined || v === null || v === '' || isNaN(n)) ? null : n;
    }

    function mergeExternal(m, incoming) {
        if (!Array.isArray(incoming)) return incoming;
        var ad = adapters[m];
        if (!ad || ad.mode === 'single') return incoming;

        var local = [];
        try { local = (ad.getList && ad.getList()) || []; } catch (e) { local = []; }

        var byId = {}, order = [];
        local.forEach(function (it) {
            var id = String(ad.idOf(it));
            if (!id || id === 'undefined' || id === 'null') return;
            byId[id] = it; order.push(id);
        });

        var added = 0, updated = 0;
        incoming.forEach(function (it) {
            var id = String(ad.idOf(it));
            if (!id || id === 'undefined' || id === 'null') return;
            if (!Object.prototype.hasOwnProperty.call(byId, id)) {
                byId[id] = it; order.push(id); added++; return;
            }
            // 冲突取 updated_at 较大的一方；只有一方有时取有的；都没有则保留本地
            var ta = toNum(byId[id] && byId[id].updated_at);
            var tb = toNum(it && it.updated_at);
            if (tb !== null && (ta === null || tb > ta)) { byId[id] = it; updated++; }
        });

        var out = order.map(function (id) { return byId[id]; });
        console.info('[CloudSync] 合并外部数据（' + m + '）：新增 ' + added +
            ' 条，更新 ' + updated + ' 条，保留本地 ' + (out.length - added - updated) + ' 条');
        return out;
    }

    // 外部数据落地后重置增量位点，让下次同步做一次全量重拉，与云端重新对齐
    function resetSince(m) { setSince(m, 0); }

    // 外部备份文件的统一元信息，便于跨版本兼容与回滚时判断新旧
    function backupStamp(m) {
        return {
            version: CONFIG.backupVersion,
            exportedAt: new Date().toISOString(),
            module: m || ''
        };
    }

    // ---------- 服务端时钟基准 ----------
    // serverNow()：估算的"服务端当前时间"。所有写库的 updated_at 都用它，
    // 让各设备的时间戳落在同一条时间轴上，消除时钟漂移导致的 LWW 误判。
    function serverNow() { return Date.now() + clockOffset; }

    async function syncClock(force) {
        if (!force && clockTs && (Date.now() - clockTs < CLOCK_TTL_MS)) return clockOffset;
        if (!app) return clockOffset;
        try {
            var t0 = Date.now();
            var r = await app.callFunction({ name: CLOCK_FN, data: {} });
            var t1 = Date.now();
            var t = r && r.result && r.result.t;
            if (typeof t === 'number' && t > 0) {
                // 服务端时刻落在 [t0, t1] 内，取中点估计并扣掉一半往返时延
                clockOffset = Math.round(t + (t1 - t0) / 2 - t1);
                clockTs = t1;
                applyClockOffset();
            }
        } catch (e) {
            // 校准失败不阻断同步，退化为本机时间（与改动前行为一致）
            console.warn('[CloudSync] 服务端时钟校准失败，回退本机时间', e && e.message);
        }
        return clockOffset;
    }

    // 时钟基准发生显著变化时重置增量拉取位点，避免时间轴错位导致漏拉
    function applyClockOffset() {
        var raw = 0;
        try { raw = parseInt(localStorage.getItem('__cbsync_clock_offset') || '0', 10); } catch (e) { }
        if (isNaN(raw)) raw = 0;
        if (Math.abs(clockOffset - raw) <= 60000) return;   // 1 分钟以内视为无变化
        moduleOrder.forEach(function (m) { setSince(m, 0); });
        try { localStorage.setItem('__cbsync_clock_offset', String(clockOffset)); } catch (e) { }
    }

    function emitStatus() { statusListeners.forEach(function (fn) { try { fn(snapshot()); } catch (e) { } }); }

    function snapshot() {
        return {
            started: started,
            signedIn: !!session,
            email: userEmail,
            syncing: syncing,
            online: online,
            lastSyncAt: lastSyncAt,
            lastError: lastError ? String(lastError.message || lastError) : null,
            modules: moduleOrder.slice()
        };
    }

    // ---------- 初始化 ----------
    function initSdk() {
        if (app) return true;
        if (!global.cloudbase) {
            lastError = new Error('cloudbase-sdk.js 未加载');
            return false;
        }
        app = global.cloudbase.init({ env: CONFIG.env });
        auth = app.auth({ persistence: 'local' });
        db = app.rdb();
        return true;
    }

    async function start() {
        if (started) return;
        if (!initSdk()) { emitStatus(); renderUI(); return; }

        try {
            var res = await auth.getSession();
            if (res && res.data && res.data.session) {
                session = res.data.session;
                userEmail = (session.user && (session.user.email || session.user.phone)) || '';
            }
        } catch (e) { /* 未登录 */ }

        auth.onAuthStateChange(function (event, s) {
            if (event === 'SIGNED_OUT') { session = null; userEmail = ''; }
            else if (s) {
                session = s;
                userEmail = (s.user && (s.user.email || s.user.phone)) || '';
            }
            emitStatus(); renderUI();
        });

        started = true;
        lastError = null;

        // 首次登录后立即同步一次
        var firstRun = true;

        scheduleScan();
        clearInterval(pullTimer);
        // 注意：这里只是"检查"定时器，绝不无条件发包。
        // 后台标签页 + 空闲退避双重拦截，避免空耗按次计费的网关额度。
        pullTimer = setInterval(function () {
            if (document.hidden) return;
            if (now() - lastSyncAt < CONFIG.idlePullInterval) return;
            syncAll(true);
        }, CONFIG.checkInterval);

        document.addEventListener('visibilitychange', function () {
            if (!document.hidden && session) syncAll();
        });
        global.addEventListener('online', function () { online = true; syncAll(); });
        global.addEventListener('offline', function () { online = false; emitStatus(); renderUI(); });

        if (session) {
            syncAll().then(function () { if (firstRun) firstRun = false; });
        }
        emitStatus(); renderUI();
    }

    // ---------- 适配器注册 ----------
    /**
     * CloudSync.attach({
     *   module: 'ledger',
     *   label: '日常记账',
     *   mode: 'list' | 'single',
     *   getList: () => arr,          // list 模式：返回数组引用（会被就地修改）
     *   setList: (arr) => {...},     // list 模式：写回并持久化
     *   idOf: (item) => item.id,     // list 模式：记录主键
     *   getSingle: () => obj,        // single 模式
     *   setSingle: (obj) => {...},   // single 模式
     *   onRemoteChange: () => {}     // 可选：远端合并后重绘
     * });
     */
    function attach(opts) {
        if (!opts || !opts.module) throw new Error('attach 需要 module');
        var m = opts.module;
        if (!adapters[m]) moduleOrder.push(m);

        var ad = {
            module: m,
            label: opts.label || m,
            mode: opts.mode === 'single' ? 'single' : 'list',
            getList: opts.getList,
            setList: opts.setList,
            idOf: opts.idOf || function (x) { return x && x.id; },
            getSingle: opts.getSingle,
            setSingle: opts.setSingle,
            onRemoteChange: opts.onRemoteChange
        };
        adapters[m] = ad;
        emitStatus();
        return ad;
    }

    // ---------- 变更检测与推送 ----------
    function currentItems(ad) {
        if (ad.mode === 'single') {
            return [{ id: SINGLE, value: ad.getSingle ? ad.getSingle() : null }];
        }
        var arr = (ad.getList && ad.getList()) || [];
        return arr.map(function (it) { return { id: String(ad.idOf(it)), value: it }; });
    }

    function computeChanges(ad) {
        var meta = loadMeta(ad.module);
        var items = currentItems(ad);
        // 用服务端时间基准，保证各设备的时间戳可比，避免时钟漂移导致的 LWW 误覆盖
        var t = serverNow();
        var changed = [];
        var i, it, id, h, m;

        for (i = 0; i < items.length; i++) {
            it = items[i];
            if (!it.id || it.id === 'undefined' || it.id === 'null') continue;
            h = hashStr(stableStringify(it.value));
            m = meta[it.id];
            if (!m || m.d || m.h !== h) {
                meta[it.id] = { u: t, d: false, h: h };
                changed.push({
                    module: ad.module,
                    rec_id: it.id,
                    data: it.value,
                    updated_at: t,
                    deleted: false,
                    device_id: DEVICE_ID
                });
            }
        }

        // 删除：只认业务代码通过 markDeleted 显式登记的 id。
        // 严禁再依据"列表中消失"推断删除——本地数据为空/加载失败时会误判为全量删除，
        // 进而把云端 data 抹成 {} 并扩散到所有设备，造成不可逆的全端数据丢失。
        if (items.length === 0 && Object.keys(meta).length > 0) {
            console.warn('[CloudSync] 模块 ' + ad.module +
                ' 当前无数据但存在历史同步记录，已跳过删除推断，防止误删');
        }

        var pending = loadPendingDeletes(ad.module);
        for (id in pending) {
            if (meta[id] && meta[id].d) continue;   // 已经是墓碑，无需重复推送
            m = meta[id] || {};
            m.d = true; m.u = t; delete m.h;
            meta[id] = m;
            changed.push({
                module: ad.module,
                rec_id: id,
                // 保留被删记录的原始数据，而非清成 {}，便于误删后恢复
                data: (pending[id] && pending[id].data) || {},
                updated_at: t,
                deleted: true,
                device_id: DEVICE_ID
            });
        }

        return { meta: meta, changed: changed };
    }

    async function pushModule(ad) {
        var r = computeChanges(ad);
        var pending = loadPendingDeletes(ad.module);
        var hasPending = Object.keys(pending).length > 0;

        if (!r.changed.length) {
            // 删除队列中的内容已全部转为墓碑（或本就为空），清理以免重复处理
            if (hasPending) savePendingDeletes(ad.module, {});
            return 0;
        }

        for (var i = 0; i < r.changed.length; i += CONFIG.batchSize) {
            var batch = r.changed.slice(i, i + CONFIG.batchSize);
            var res = await db.from(TABLE).upsert(batch, { onConflict: 'uid,module,rec_id' });
            if (res && res.error) throw res.error;
        }
        saveMeta(ad.module, r.meta);
        // 仅在推送成功后清理显式删除队列；失败会抛错走不到这里，下次同步自动重试
        if (hasPending) savePendingDeletes(ad.module, {});
        return r.changed.length;
    }

    // ---------- 拉取与合并 ----------
    function applyRemote(ad, id, row) {
        if (ad.mode === 'single') {
            if (row.deleted) return false;
            ad._pending = row.data;
            return true;
        }
        var arr = ad.getList();
        var idx = -1, i;
        for (i = 0; i < arr.length; i++) {
            if (String(ad.idOf(arr[i])) === id) { idx = i; break; }
        }
        if (row.deleted) {
            if (idx >= 0) { arr.splice(idx, 1); return true; }
            return false;
        }
        if (idx >= 0) {
            if (hashStr(stableStringify(arr[idx])) === hashStr(stableStringify(row.data))) return false;
            arr[idx] = row.data;
        } else {
            arr.push(row.data);
        }
        return true;
    }

    function commitAdapter(ad) {
        if (ad.mode === 'single') {
            if (ad._pending !== undefined && ad.setSingle) {
                var v = ad._pending; ad._pending = undefined;
                ad.setSingle(v);
            }
        } else if (ad.setList) {
            ad.setList(ad.getList());
        }
        if (ad.onRemoteChange) { try { ad.onRemoteChange(); } catch (e) { } }
    }

    async function pullModule(ad) {
        var since = getSince(ad.module);
        var meta = loadMeta(ad.module);
        var maxU = since, dirty = false, count = 0;

        var res = await db.from(TABLE)
            .select('rec_id,data,updated_at,deleted')
            .eq('module', ad.module)
            .gt('updated_at', since)
            .order('updated_at', { ascending: true })
            .limit(CONFIG.batchSize);

        if (res && res.error) throw res.error;
        var rows = (res && res.data) || [];

        rows.forEach(function (row) {
            var id = String(row.rec_id);
            if (row.updated_at > maxU) maxU = row.updated_at;
            var m = meta[id];
            // LWW：远端更新则采纳（本地未同步的更新 updated_at 更大，会在 push 时胜出）
            if (!m || row.updated_at > (m.u || 0)) {
                meta[id] = row.deleted
                    ? { u: row.updated_at, d: true }
                    : { u: row.updated_at, d: false, h: hashStr(stableStringify(row.data)) };
                if (applyRemote(ad, id, row)) dirty = true;
            }
            count++;
        });

        if (dirty) commitAdapter(ad);
        saveMeta(ad.module, meta);
        setSince(ad.module, maxU);
        return count;
    }

    // ---------- 误删恢复 ----------
    // 墓碑行（deleted=true）现在会保留原始 data，因此可列出并一键还原。
    async function listDeleted(m) {
        if (!session) throw new Error('请先登录');
        var res = await db.from(TABLE)
            .select('rec_id,data,updated_at,deleted')
            .eq('module', m)
            .eq('deleted', true)
            .order('updated_at', { ascending: false })
            .limit(200);
        if (res && res.error) throw res.error;
        // 只保留仍带原始数据的墓碑；旧版墓碑 data 已被清成 {}，无内容可恢复
        return (res.data || []).filter(function (r) {
            return r.data && typeof r.data === 'object' && Object.keys(r.data).length > 0;
        });
    }

    async function restoreDeleted(m, rec_id) {
        var ad = adapters[m];
        if (!ad) throw new Error('模块未注册：' + m);
        if (!session) throw new Error('请先登录');
        rec_id = String(rec_id);

        var res = await db.from(TABLE)
            .select('rec_id,data,updated_at,deleted')
            .eq('module', m)
            .eq('rec_id', rec_id)
            .limit(1);
        if (res && res.error) throw res.error;

        var row = res && res.data && res.data[0];
        if (!row) throw new Error('未找到该记录');
        if (!row.data || typeof row.data !== 'object' || !Object.keys(row.data).length) {
            throw new Error('该记录没有可恢复的数据（旧版墓碑未保留内容）');
        }

        // 写回 deleted=false，并用最新服务端时间，确保大于本地 since，下次 pull 能拉回
        var t = serverNow();
        var up = await db.from(TABLE).upsert([{
            module: m,
            rec_id: rec_id,
            data: row.data,
            updated_at: t,
            deleted: false,
            device_id: DEVICE_ID
        }], { onConflict: 'uid,module,rec_id' });
        if (up && up.error) throw up.error;

        // 清掉本地墓碑标记，避免本地仍把该记录视为已删除
        var meta = loadMeta(m);
        if (meta[rec_id]) { delete meta[rec_id]; saveMeta(m, meta); }
        var pending = loadPendingDeletes(m);
        if (pending[rec_id]) { delete pending[rec_id]; savePendingDeletes(m, pending); }

        // 立即拉回本地，触发各模块重绘
        await syncModule(m);
        return row.data;
    }

    // ---------- 同步编排 ----------
    async function syncModule(m) {
        var ad = adapters[m];
        if (!ad || !session) return;
        var pulled = await pullModule(ad);
        var pushed = await pushModule(ad);
        return { pulled: pulled, pushed: pushed };
    }

    // 每日请求熔断：按次计费，一旦异常循环必须止损
    var dailyCalls = 0, dailyCallsDate = '';
    function allowCall() {
        var d = new Date().toDateString();
        if (d !== dailyCallsDate) { dailyCallsDate = d; dailyCalls = 0; }
        if (dailyCalls >= CONFIG.maxDailyCalls) {
            if (!lastError) { lastError = new Error('已达每日同步上限'); emitStatus(); renderUI(); }
            return false;
        }
        dailyCalls++;
        return true;
    }

    async function syncAll(pullOnly, force) {
        if (!started || !session) return;
        if (syncing) return;
        if (!allowCall()) return;
        // 后台标签页默认不发网络请求（按次计费，必须拦截）。
        // 手动点击等显式操作传 force=true 才放行。
        if (!force && document.hidden) return;
        if (!global.navigator.onLine) { online = false; emitStatus(); renderUI(); return; }

        // 同步前校准时钟（30 分钟内只校准一次），确保写库时间戳落在服务端时间轴上
        await syncClock();

        syncing = true; lastError = null; emitStatus(); renderUI();
        try {
            for (var i = 0; i < moduleOrder.length; i++) {
                var m = moduleOrder[i];
                if (pullOnly) await pullModule(adapters[m]);
                else await syncModule(m);
            }
            lastSyncAt = now();
        } catch (e) {
            lastError = e;
            console.error('[CloudSync] 同步失败', e);
        } finally {
            syncing = false; emitStatus(); renderUI();
        }
    }

    function scheduleScan() {
        clearInterval(scanTimer);
        scanTimer = setInterval(function () {
            if (!session || document.hidden || syncing) return;
            moduleOrder.forEach(function (m) {
                var ad = adapters[m];
                if (!ad) return;
                try {
                    if (computeChanges(ad).changed.length > 0) {
                        clearTimeout(pushTimers[m]);
                        pushTimers[m] = setTimeout(function () { syncModule(m); }, CONFIG.pushDelay);
                    }
                } catch (e) { /* 忽略单模块扫描异常 */ }
            });
        }, CONFIG.scanInterval);
    }

    // ---------- 登录 ----------
    async function sendCode(email) {
        if (!initSdk()) throw new Error('SDK 未加载');
        var res = await auth.signInWithOtp({ email: email });
        if (res.error) throw res.error;
        verifyOtpFn = res.data && res.data.verifyOtp;
        if (!verifyOtpFn) throw new Error('验证码发送失败：未返回校验回调');
        return true;
    }

    async function verifyCode(token) {
        if (!verifyOtpFn) throw new Error('请先发送验证码');
        var res = await verifyOtpFn({ token: String(token).trim() });
        if (res.error) throw res.error;
        session = (res.data && res.data.session) || session;
        userEmail = (session && session.user && (session.user.email || session.user.phone)) || userEmail;
        verifyOtpFn = null;
        emitStatus(); renderUI();
        await syncAll();
        return true;
    }

    async function signOut() {
        try { if (auth) await auth.signOut(); } catch (e) { }
        session = null; userEmail = '';
        uiDeleted = null; uiDeletedBusy = false;
        emitStatus(); renderUI();
    }

    // ---------- UI ----------
    var uiBuilt = false, uiRoot = null, uiBadge = null, uiPanel = null;

    function statusMeta() {
        if (!started || !global.cloudbase) return { color: '#94a3b8', text: '未就绪' };
        if (!session) return { color: '#f59e0b', text: '未登录' };
        if (!online) return { color: '#94a3b8', text: '离线' };
        if (syncing) return { color: '#3b82f6', text: '同步中' };
        if (lastError) return { color: '#ef4444', text: '同步失败' };
        return { color: '#10b981', text: '已同步' };
    }

    function injectCss() {
        if (document.getElementById('__cbsync_css')) return;
        var style = document.createElement('style');
        style.id = '__cbsync_css';
        style.textContent =
            '#__cbsync_root{position:fixed;right:14px;bottom:14px;z-index:2147483000;' +
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
            'font-size:12px;line-height:1.5;}' +
            '#__cbsync_badge{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;' +
            'background:rgba(255,255,255,.96);border:1px solid rgba(15,23,42,.10);border-radius:999px;' +
            'padding:6px 11px;box-shadow:0 4px 16px rgba(15,23,42,.14);color:#1e293b;font-weight:600;}' +
            '#__cbsync_badge:hover{box-shadow:0 6px 20px rgba(15,23,42,.2);}' +
            '#__cbsync_dot{width:8px;height:8px;border-radius:50%;flex:none;transition:background .2s;}' +
            '#__cbsync_badge.busy #__cbsync_dot{animation:__cbsync_pulse 1s infinite;}' +
            '@keyframes __cbsync_pulse{0%,100%{opacity:1}50%{opacity:.3}}' +
            '#__cbsync_panel{display:none;width:268px;margin-bottom:8px;background:#fff;' +
            'border:1px solid rgba(15,23,42,.10);border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.18);' +
            'padding:14px;color:#1e293b;}' +
            '#__cbsync_panel.open{display:block;}' +
            '#__cbsync_panel h4{margin:0 0 10px;font-size:13px;font-weight:700;color:#0f172a;}' +
            '#__cbsync_panel input{width:100%;box-sizing:border-box;padding:7px 9px;margin-bottom:8px;' +
            'border:1px solid #cbd5e1;border-radius:7px;font-size:12px;outline:none;}' +
            '#__cbsync_panel input:focus{border-color:#3b82f6;}' +
            '#__cbsync_panel button{width:100%;padding:8px;border:none;border-radius:7px;font-size:12px;' +
            'font-weight:600;cursor:pointer;background:#2563eb;color:#fff;margin-bottom:6px;}' +
            '#__cbsync_panel button:hover{background:#1d4ed8;}' +
            '#__cbsync_panel button.link{background:transparent;color:#64748b;padding:5px;font-weight:500;}' +
            '#__cbsync_panel button.link:hover{background:#f1f5f9;}' +
            '#__cbsync_msg{font-size:11px;margin-bottom:8px;min-height:14px;color:#64748b;}' +
            '#__cbsync_msg.err{color:#ef4444;}#__cbsync_msg.ok{color:#059669;}' +
            '#__cbsync_stat{font-size:11px;color:#64748b;border-top:1px solid #f1f5f9;padding-top:8px;margin-top:2px;}' +
            '.__cbsync_hint{font-size:11px;color:#64748b;margin-bottom:8px;}' +
            '.__cbsync_list{max-height:220px;overflow:auto;margin-bottom:8px;border-top:1px solid #f1f5f9;}' +
            '.__cbsync_item{padding:8px 0;border-bottom:1px solid #f1f5f9;}' +
            '.__cbsync_item_m{font-size:10px;color:#94a3b8;}' +
            '.__cbsync_item_t{font-size:12px;color:#1e293b;margin:2px 0 4px;word-break:break-all;}' +
            '.__cbsync_item button{margin-bottom:0;padding:4px;}';
        document.head.appendChild(style);
    }

    function buildUI() {
        if (uiBuilt) return;
        if (!document.body) return;
        uiBuilt = true;
        injectCss();

        uiRoot = document.createElement('div');
        uiRoot.id = '__cbsync_root';

        uiPanel = document.createElement('div');
        uiPanel.id = '__cbsync_panel';

        uiBadge = document.createElement('div');
        uiBadge.id = '__cbsync_badge';
        uiBadge.innerHTML = '<span id="__cbsync_dot"></span><span id="__cbsync_text">…</span>';
        uiBadge.onclick = function () {
            uiPanel.classList.toggle('open');
            if (uiPanel.classList.contains('open')) renderPanel();
        };

        uiRoot.appendChild(uiPanel);
        uiRoot.appendChild(uiBadge);
        document.body.appendChild(uiRoot);
    }

    var step = 'signin';   // signin | code

    function escapeHtml(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // 墓碑记录的一句话摘要，优先取常见业务字段，兜底截取 JSON
    function summarizeData(d) {
        if (!d || typeof d !== 'object') return '(无内容)';
        var parts = [];
        ['name', 'title', 'note', 'remark', 'desc', 'description'].forEach(function (k) {
            if (d[k]) parts.push(String(d[k]));
        });
        if (d.date) parts.push(String(d.date));
        if (d.amount !== undefined && d.amount !== null) parts.push(String(d.amount));
        if (!parts.length) {
            try { parts.push(JSON.stringify(d).slice(0, 60)); } catch (e) { parts.push('(无摘要)'); }
        }
        return parts.join(' · ');
    }

    function renderPanel() {
        if (!uiPanel) return;
        var s = snapshot();
        var html = '';

        if (!s.signedIn) {
            if (step === 'signin') {
                html += '<h4>云同步登录</h4>' +
                    '<input id="__cbsync_email" type="email" placeholder="you@example.com" autocomplete="email">' +
                    '<button id="__cbsync_send">发送验证码</button>' +
                    '<div id="__cbsync_msg"></div>' +
                    '<div id="__cbsync_stat">同一邮箱在手机与电脑各登录一次，即可自动同步。</div>';
            } else {
                html += '<h4>输入验证码</h4>' +
                    '<input id="__cbsync_token" type="text" inputmode="numeric" placeholder="6 位验证码" maxlength="6">' +
                    '<button id="__cbsync_verify">登录并同步</button>' +
                    '<button class="link" id="__cbsync_back">换个邮箱</button>' +
                    '<div id="__cbsync_msg"></div>';
            }
        } else if (uiDeleted) {
            html += '<h4>误删恢复</h4>' +
                '<div id="__cbsync_msg"></div>';
            if (uiDeletedBusy) {
                html += '<div class="__cbsync_hint">正在读取云端删除记录…</div>';
            } else if (!uiDeleted.length) {
                html += '<div class="__cbsync_hint">没有可恢复的删除记录</div>';
            } else {
                html += '<div class="__cbsync_list">';
                uiDeleted.forEach(function (it, idx) {
                    html += '<div class="__cbsync_item">' +
                        '<div class="__cbsync_item_m">' + escapeHtml(it.label) + '</div>' +
                        '<div class="__cbsync_item_t">' + escapeHtml(summarizeData(it.data)) + '</div>' +
                        '<button class="link" data-restore="' + idx + '">恢复</button>' +
                        '</div>';
                });
                html += '</div>';
            }
            html += '<button class="link" id="__cbsync_back_list">返回</button>';
        } else {
            html += '<h4>云同步</h4>' +
                '<div id="__cbsync_msg"></div>' +
                '<button id="__cbsync_now">立即同步</button>' +
                '<button class="link" id="__cbsync_restore">误删恢复</button>' +
                '<button class="link" id="__cbsync_out">退出登录（保留本地数据）</button>' +
                '<div id="__cbsync_stat"></div>';
        }

        uiPanel.innerHTML = html;
        bindPanel();
        updateStat();
    }

    function msg(text, kind) {
        var el = document.getElementById('__cbsync_msg');
        if (!el) return;
        el.textContent = text || '';
        el.className = kind || '';
    }

    function bindPanel() {
        // 注意：每个按钮必须用独立的块级绑定。
        // 若复用同一个 var，闭包捕获的是变量本身，会被后续赋值覆盖成 null。
        const val = function (id) {
            var el = document.getElementById(id);
            return el ? String(el.value || '').trim() : '';
        };

        const btnSend = document.getElementById('__cbsync_send');
        if (btnSend) btnSend.onclick = async function () {
            var email = val('__cbsync_email');
            if (!email) return msg('请输入邮箱', 'err');
            btnSend.disabled = true; btnSend.textContent = '发送中…';
            try {
                await sendCode(email);
                step = 'code'; renderPanel();
                msg('验证码已发送，请查收邮件（注意垃圾箱）', 'ok');
            } catch (e) {
                btnSend.disabled = false; btnSend.textContent = '发送验证码';
                msg('发送失败：' + (e.message || e), 'err');
            }
        };

        const btnVerify = document.getElementById('__cbsync_verify');
        if (btnVerify) btnVerify.onclick = async function () {
            var token = val('__cbsync_token');
            if (!token) return msg('请输入验证码', 'err');
            btnVerify.disabled = true; btnVerify.textContent = '登录中…';
            try {
                await verifyCode(token);
                step = 'signin'; renderPanel();
                msg('登录成功，正在同步…', 'ok');
            } catch (e) {
                btnVerify.disabled = false; btnVerify.textContent = '登录并同步';
                msg('验证码错误或已过期：' + (e.message || e), 'err');
            }
        };

        const btnBack = document.getElementById('__cbsync_back');
        if (btnBack) btnBack.onclick = function () { step = 'signin'; renderPanel(); };

        const btnNow = document.getElementById('__cbsync_now');
        if (btnNow) btnNow.onclick = async function () {
            btnNow.disabled = true; btnNow.textContent = '同步中…';
            await syncAll(false, true);
            renderPanel();
            msg('同步完成', 'ok');
        };

        const btnOut = document.getElementById('__cbsync_out');
        if (btnOut) btnOut.onclick = async function () { await signOut(); renderPanel(); };

        const btnRestore = document.getElementById('__cbsync_restore');
        if (btnRestore) btnRestore.onclick = async function () {
            uiDeleted = []; uiDeletedBusy = true;
            renderPanel();

            var out = [];
            try {
                for (var i = 0; i < moduleOrder.length; i++) {
                    var m = moduleOrder[i];
                    var rows = await listDeleted(m);
                    for (var j = 0; j < rows.length; j++) {
                        out.push({
                            module: m,
                            label: (adapters[m] && adapters[m].label) || m,
                            rec_id: rows[j].rec_id,
                            data: rows[j].data,
                            updated_at: rows[j].updated_at
                        });
                    }
                }
                lastError = null;
            } catch (e) {
                lastError = e;
                msg('读取失败：' + (e.message || e), 'err');
            }
            uiDeleted = out; uiDeletedBusy = false;
            renderPanel();
        };

        const btnBackList = document.getElementById('__cbsync_back_list');
        if (btnBackList) btnBackList.onclick = function () { uiDeleted = null; renderPanel(); };

        // 逐条恢复：用 module+rec_id 定位，不能依赖下标（列表会变化）
        var restoreBtns = uiPanel ? uiPanel.querySelectorAll('[data-restore]') : [];
        Array.prototype.forEach.call(restoreBtns, function (btn) {
            btn.onclick = async function () {
                var it = uiDeleted[parseInt(btn.getAttribute('data-restore'), 10)];
                if (!it) return;
                btn.disabled = true; btn.textContent = '恢复中…';
                try {
                    await restoreDeleted(it.module, it.rec_id);
                    uiDeleted = uiDeleted.filter(function (x) {
                        return !(x.module === it.module && String(x.rec_id) === String(it.rec_id));
                    });
                    renderPanel();
                    msg('已恢复：' + summarizeData(it.data), 'ok');
                } catch (e) {
                    btn.disabled = false; btn.textContent = '恢复';
                    msg('恢复失败：' + (e.message || e), 'err');
                }
            };
        });
    }

    function updateStat() {
        var el = document.getElementById('__cbsync_stat');
        if (!el) return;
        var s = snapshot();
        var lines = [];
        if (s.email) lines.push('账号：' + s.email);
        if (s.lastSyncAt) {
            var d = new Date(s.lastSyncAt);
            lines.push('上次同步：' + d.toLocaleTimeString('zh-CN', { hour12: false }));
        }
        if (s.lastError) lines.push('错误：' + s.lastError);
        if (s.modules.length) lines.push('模块：' + s.modules.map(function (m) {
            return (adapters[m] && adapters[m].label) || m;
        }).join('、'));
        el.innerHTML = lines.map(function (l) { return '<div>' + l + '</div>'; }).join('');
    }

    function renderUI() {
        buildUI();
        if (!uiBadge) return;
        var st = statusMeta();
        var dot = document.getElementById('__cbsync_dot');
        var txt = document.getElementById('__cbsync_text');
        if (dot) dot.style.background = st.color;
        if (txt) txt.textContent = st.text;
        uiBadge.classList.toggle('busy', st.text === '同步中');
        if (uiPanel && uiPanel.classList.contains('open')) updateStat();
    }

    // ---------- 启动 ----------
    function boot() {
        start();
        renderUI();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    global.CloudSync = {
        attach: attach,
        markDeleted: markDeleted,
        markReplaced: markReplaced,
        listDeleted: listDeleted,
        restoreDeleted: restoreDeleted,
        mergeExternal: mergeExternal,
        resetSince: resetSince,
        backupStamp: backupStamp,
        serverNow: serverNow,
        start: start,
        sync: function (m) { return m ? syncModule(m) : syncAll(); },
        // 云端函数代理：供业务模块调用 CloudBase 云函数（如场外基金净值代理）。
        // 复用本模块已初始化的 app 实例，无需业务代码自行 init。
        callFunction: function (name, data) {
            if (!initSdk()) throw new Error('cloudbase-sdk.js 未加载');
            return app.callFunction({ name: name, data: data || {} });
        },
        sendCode: sendCode,
        verifyCode: verifyCode,
        signOut: signOut,
        status: snapshot,
        onStatusChange: function (fn) { statusListeners.push(fn); return function () { statusListeners = statusListeners.filter(function (f) { return f !== fn; }); }; },
        config: CONFIG
    };
})(window);
