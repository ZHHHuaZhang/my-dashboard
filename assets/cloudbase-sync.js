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
        singleId: '__singleton__'
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
        var t = now();
        var changed = [];
        var seen = {};
        var i, it, id, h, m;

        for (i = 0; i < items.length; i++) {
            it = items[i];
            if (!it.id || it.id === 'undefined' || it.id === 'null') continue;
            seen[it.id] = true;
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

        // 列表中已消失 -> 墓碑
        for (id in meta) {
            m = meta[id];
            if (!seen[id] && !m.d) {
                m.d = true; m.u = t; delete m.h;
                changed.push({
                    module: ad.module,
                    rec_id: id,
                    data: {},
                    updated_at: t,
                    deleted: true,
                    device_id: DEVICE_ID
                });
            }
        }

        return { meta: meta, changed: changed };
    }

    async function pushModule(ad) {
        var r = computeChanges(ad);
        if (!r.changed.length) return 0;

        for (var i = 0; i < r.changed.length; i += CONFIG.batchSize) {
            var batch = r.changed.slice(i, i + CONFIG.batchSize);
            var res = await db.from(TABLE).upsert(batch, { onConflict: 'uid,module,rec_id' });
            if (res && res.error) throw res.error;
        }
        saveMeta(ad.module, r.meta);
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
            '#__cbsync_stat{font-size:11px;color:#64748b;border-top:1px solid #f1f5f9;padding-top:8px;margin-top:2px;}';
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
        } else {
            html += '<h4>云同步</h4>' +
                '<div id="__cbsync_msg"></div>' +
                '<button id="__cbsync_now">立即同步</button>' +
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
        start: start,
        sync: function (m) { return m ? syncModule(m) : syncAll(); },
        sendCode: sendCode,
        verifyCode: verifyCode,
        signOut: signOut,
        status: snapshot,
        onStatusChange: function (fn) { statusListeners.push(fn); return function () { statusListeners = statusListeners.filter(function (f) { return f !== fn; }); }; },
        config: CONFIG
    };
})(window);
