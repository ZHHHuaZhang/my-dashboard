# 场外基金净值实时刷新方案（fundNavProxy）

> 本方案解决智投精算看板中「场外基金」因浏览器 CORS 限制无法直接抓取净值的问题，
> 通过 CloudBase 云函数代理抓取，并以平台级安全规则要求仅登录用户可调用。

## 1. 背景与目标

- **场内基金 / 股票**：走原有腾讯行情接口，浏览器可直接请求，不受影响。
- **场外基金**：净值源（东方财富 / 新浪）未开启 CORS，浏览器 `fetch` 被跨域拦截。
- **目标**：在不改动场内逻辑的前提下，用云端函数代理场外净值抓取，并合并回看板，
  同时保证该代理不会被匿名滥用。

两条路径完全独立：场内/股票走腾讯接口，场外走云端代理，互不干扰。

## 2. 架构

```
浏览器(已登录, 邮箱验证码登录)
   │  CloudSync.callFunction('fundNavProxy', { codes: [...] })
   ▼
CloudBase 云函数 fundNavProxy
   │  安全规则拦截匿名调用 → 仅登录用户可进入
   │  主源: api.fund.eastmoney.com (F10 历史净值, 单位净值 DWJZ)
   │  备源: hq.sinajs.cn (主源失败时兜底)
   ▼
返回 { success:true, data:{ "000001":{code,name,nav,date} }, count }
   │
   ▼
investmentManagement.html 把 nav 写回对应场外基金的 latestPrice
```

## 3. 关键组件

| 文件 | 作用 |
|---|---|
| `functions/fundNavProxy/index.js` | 净值代理：双数据源 + 缓存 + 限流 + 入参强校验 |
| `cloudbaserc.json` | 声明函数（runtime `Nodejs20.19` / 内存 `128MB` / 超时 `10s`），CI 据此部署 |
| `.github/workflows/deploy.yml` | CI：静态托管部署后自动 `tcb fn deploy fundNavProxy` |
| `deploy.ps1` | 本地一键部署（托管 + 函数） |
| `assets/cloudbase-sync.js` | `CloudSync.callFunction` 封装，复用已初始化的 SDK（`signInWithOtp` 邮箱登录） |
| `investmentManagement.html` | 调函数并把净值合并进场外基金条目 |

函数入参 / 出参：

```js
// 入参
{ codes: ["000001", "011966", /* ... 最多 50 个 6 位数字代码 */] }
// 出参
{ success: true, data: { "000001": { code, name, nav, date } }, count }
```

## 4. 安全 / 防刷（四层）

1. **平台层登录闸（核心）**
   云函数「安全规则」：
   ```json
   {
     "*": { "invoke": true },
     "fundNavProxy": { "invoke": "auth.loginType != 'ANONYMOUS' && auth != null" }
   }
   ```
   Web SDK 的 `callFunction` **不会把 `userInfo` 注入 `event`**，因此**不能**在函数代码里读
   `event.userInfo` 判登录态。登录校验必须放到平台安全规则，由网关在请求到达函数前拦截匿名调用。

2. **入参强校验**
   仅接受 `^\d{6}$` 的基金代码，单次上限 50 个、自动去重，杜绝枚举 / 垃圾参数。

3. **净值缓存（成本与防刷的真正杀手）**
   - 成功结果缓存 1 小时（`CACHE_TTL_MS`）；失败结果短缓存 5 分钟（`FAIL_CACHE_TTL_MS`）。
   - 净值每日仅更新一次，重复查询直接命中缓存、**不再打上游**。

4. **实例级限流 + 超时 + 内存压低**
   - 单实例限流 60 次 / 分钟，超出返回 `rate_limited`。
   - 上游抓取超时 8 秒。
   - 函数内存设为 128MB（按量计费减半）。

## 5. 踩坑记录（已修复）

| 问题 | 现象 | 根因 | 修复 |
|---|---|---|---|
| 代码内判登录态误拒自己 | 已登录仍报「请先登录」 | Web SDK `callFunction` 不注入 `event.userInfo`（诊断确认 `event` 仅含 `codes`/`tcbContext`） | 删除代码级 `userInfo` 校验，改用平台安全规则 |
| 「最大实例数」硬封顶设不了 | 控制台 / CLI 均无该字段 | 普通 `callFunction` 云函数不开放实例数上限（`cloudbaserc.json` 无 `maxInstances`；`instanceConcurrencyConfig` 仅 HTTP 云函数可用） | 确认非必需，依赖缓存 + 限流 + 128MB 内存即可 |

## 6. 控制台手动配置（CI 不支持）

安全规则需**手动**在控制台配置一次（CLI 无对应部署命令）：

1. CloudBase 控制台 → 环境 `mycloudbase-d2g3grx15f32df45e` → 左侧 **云函数** → `fundNavProxy` → **权限控制 / 安全规则**。
2. 写入第 4 节中的 JSON 规则并保存。
   （若控制台为开关式「允许未登录访问」，直接**关闭**该项即可，含义等价。）

> 前端 `payload.error === 'unauthorized'` 分支已删除（函数不再返回该字段），下次 push 触发 CI 即更新。

## 7. 当前状态

- ✅ 线上已登录即可刷新场外基金净值
- ✅ 仅登录用户可调用，匿名被平台拒绝
- ✅ CI 自动部署函数，本地 `deploy.ps1` 亦可

## 8. 可选后续

- 函数 `timeout` 收紧到 8s（上游抓取 8s 已足够）。
- 若改用 HTTP 触发器，可再加来源域名白名单（当前 `callFunction` 走 SDK，白名单不适用）。
- 按 `desginRule.md` 安全约定，定期轮换 `CLOUDBASE_API_KEY`。

## 9. 相关文件速查

- 函数代码：`functions/fundNavProxy/index.js`
- 部署声明：`cloudbaserc.json`
- CI 流水线：`.github/workflows/deploy.yml`
- 本地部署：`deploy.ps1`
- SDK 封装 / 登录：`assets/cloudbase-sync.js`
- 调用入口：`investmentManagement.html`
