'use strict';
// CloudBase 云函数：场外基金净值代理
// 浏览器因 CORS 无法直接请求天天基金/东方财富的净值接口，故由云端代理获取。
//
// 入参：{ codes: ["000001", "011966", ...] }  （也可经 HTTP 触发器传 JSON body）
// 出参：{ success: true, data: { "000001": { code, name, nav, date }, ... }, count }
//
// 安全/防刷设计：
//   0) 登录鉴权：由云函数「安全规则」在平台层完成（invoke: "auth != null"，仅登录用户可调用）。
//      Web SDK 的 callFunction 不会把 userInfo 注入 event，故不在代码里判断登录态。
//   1) 入参强校验：仅接受 6 位数字基金代码，单次上限 50 个，杜绝垃圾/枚举滥用。
//   2) 净值缓存：净值每日仅更新一次，命中缓存直接返回，不再打上游，刷爆基本失效。
//   3) 实例级限流：单实例每分钟上限，超出返回 429；配合控制台「最大实例数」硬封顶。
const https = require('https');

// ---- 防护配置（可按需调整）----
const MAX_CODES = 50;                       // 单次最多查询基金数
const CACHE_TTL_MS = 60 * 60 * 1000;        // 净值缓存 1 小时（每日仅更新一次，足够）
const FAIL_CACHE_TTL_MS = 5 * 60 * 1000;    // 失败结果短缓存，避免坏代码反复打上游
const RATE_WINDOW_MS = 60 * 1000;           // 限流窗口 1 分钟
const RATE_MAX = 60;                        // 每实例每分钟最多处理请求数

// 模块级状态：在同一实例的多次调用间复用（冷启动除外）
const cache = new Map();                    // code -> { ts, value, ok }
let rateCount = 0;
let rateWindowStart = Date.now();

function isRateLimited() {
    const now = Date.now();
    if (now - rateWindowStart > RATE_WINDOW_MS) {
        rateWindowStart = now;
        rateCount = 0;
    }
    if (rateCount >= RATE_MAX) return true;
    rateCount++;
    return false;
}

function validCode(c) {
    return typeof c === 'string' && /^\d{6}$/.test(c.trim());
}

function getCached(code) {
    const hit = cache.get(code);
    if (!hit) return undefined;             // 未缓存
    const ttl = hit.ok ? CACHE_TTL_MS : FAIL_CACHE_TTL_MS;
    if (Date.now() - hit.ts < ttl) return hit.value;   // 命中（含失败缓存）
    return undefined;
}

function setCache(code, value) {
    cache.set(code, { ts: Date.now(), value: value || null, ok: !!value });
}

// 主数据源：东方财富 F10 历史净值接口（官方单位净值 DWJZ，最权威）
function fetchFundNav(code) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };

        const url = 'https://api.fund.eastmoney.com/f10/lsjz?fundCode=' +
            encodeURIComponent(code) + '&pageIndex=1&pageSize=1';
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://fundf10.eastmoney.com/'
            },
            timeout: 8000
        }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try {
                    const j = JSON.parse(body);
                    const list = j && j.Data && j.Data.LSJZList;
                    if (list && list.length && list[0].DWJZ) {
                        finish({
                            code: String(code),
                            name: '',
                            nav: parseFloat(list[0].DWJZ),
                            date: list[0].FSRQ || ''
                        });
                    } else {
                        fetchFundNavFallback(code).then(finish);
                    }
                } catch (e) {
                    fetchFundNavFallback(code).then(finish);
                }
            });
        });
        req.on('error', () => fetchFundNavFallback(code).then(finish));
        req.on('timeout', () => { req.destroy(); fetchFundNavFallback(code).then(finish); });
    });
}

// 备用数据源：新浪基金接口（不同服务商，主源不可用时兜底）
function fetchFundNavFallback(code) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };

        const url = 'https://hq.sinajs.cn/list=fu_' + encodeURIComponent(code);
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://finance.sina.com.cn/'
            },
            timeout: 8000
        }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try {
                    const m = body.match(/=\"(.*)\";/);
                    if (!m) return finish(null);
                    const parts = m[1].split(',');
                    // 新浪基金格式：名称,时间,单位净值,累计净值,估算,?,涨跌%,净值日期,...
                    const nav = parseFloat(parts[2]);
                    const date = parts[7] || '';
                    const name = parts[0] || '';
                    if (nav > 0) {
                        finish({ code: String(code), name: name, nav: nav, date: date });
                    } else {
                        finish(null);
                    }
                } catch (e) { finish(null); }
            });
        });
        req.on('error', () => finish(null));
        req.on('timeout', () => { req.destroy(); finish(null); });
    });
}

// 统一取数 + 缓存（含失败缓存）
async function resolveNav(code) {
    const cached = getCached(code);
    if (cached !== undefined) return cached;     // 命中（可能是 null=查无）
    const r = await fetchFundNav(code);
    setCache(code, r);
    return r;
}

function extractCodes(event) {
    if (event && Array.isArray(event.codes)) return event.codes;
    // 兼容 HTTP 触发器：body 为 JSON 字符串
    if (event && typeof event.body === 'string') {
        try {
            const b = JSON.parse(event.body);
            if (b && Array.isArray(b.codes)) return b.codes;
        } catch (_) { /* ignore */ }
    }
    return [];
}

exports.main = async (event, context) => {
    // 鉴权说明：登录校验已由云函数「安全规则」在平台层完成
    // （invoke: "auth != null"，仅登录用户可调用）。Web SDK 的 callFunction
    // 不会把 userInfo 注入 event，故不在代码里做身份判断，避免误拒。

    // 实例级限流
    if (isRateLimited()) {
        return { success: false, error: 'rate_limited', message: '请求过于频繁，请稍后再试' };
    }

    const rawCodes = extractCodes(event);
    const codes = rawCodes
        .map((c) => String(c).trim())
        .filter(validCode)
        .filter((c, i, arr) => arr.indexOf(c) === i)   // 去重
        .slice(0, MAX_CODES);

    const result = {};
    await Promise.all(codes.map(async (code) => {
        const r = await resolveNav(code);
        if (r && r.nav > 0) result[code] = r;
    }));

    return { success: true, data: result, count: Object.keys(result).length };
};
