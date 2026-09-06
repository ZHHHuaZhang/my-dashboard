# Design Rule

All moudlue must follow the design rule.
Every moudlue's tab is in the top of the page and has gittee synchronization funtion. Moudlue should intergare with the main page index.html.
This porject is deployed on CloudBase static hosting (data sync requires the hosting domain, which is in the CloudBase 安全域名白名单). The GitHub Pages copy remains as a public demo without cloud sync.

## Cloud Sync (CloudBase)

Data sync between phone and PC is handled by `assets/cloudbase-sync.js` (CloudBase PostgreSQL), not by manual Gitee upload/download.

### Integration contract

Every module that owns persistent data MUST register itself at the end of its script:

```js
CloudSync.attach({
    module: '<module_key>',   // stable, unique, never rename
    label: '<中文名>',
    mode: 'list' | 'single',  // list: 数组按 id 合并 / single: 整个 state 作为一条记录
    getList / setList / idOf, // mode = 'list'
    getSingle / setSingle,    // mode = 'single'
    onRemoteChange            // 远端合并后重绘
});
```

Currently registered: `ledger`(日常记账)、`finance`(资金统计)、`items`(物品管理)、`portfolio`(智投精算)、`dividend`(股息自由之路, single)。
`module` key is written into the database; renaming it orphans existing cloud data.

### Rules

1. **Zero instrumentation** — 变更由快照哈希自动检测，禁止在业务代码里手动调用 push/save 触发同步。
2. **Never send `uid`** — `sync_records.uid` 由服务端按 JWT 自动填充，前端传 uid 即为安全缺陷。
3. **Deletes are tombstones** — 删除同步为 `deleted:true` 墓碑，不是物理删除；不得在同步层之外清理墓碑。
4. **Never overwrite wholesale** — 合并以记录为粒度、按 `updated_at` 取新（LWW），禁止整包覆盖 localStorage。
5. **Records need a stable id** — `idOf` 返回的 id 必须稳定且唯一；缺失 id 的记录会被跳过。
6. Single-object modules (股息) use `mode:'single'`，整包存一条，冲突按最新版胜出。

### Deployment

发布采用 **GitHub Actions 持续部署**，唯一入口是 `git push`：

```
git push  →  .github/workflows/deploy.yml
               ├─ 组装 dist（仅登记在册的 9 个文件）
               ├─ tcb login（凭证来自 GitHub Secrets）
               └─ tcb hosting deploy dist --verify --safe --prune
          →  GitHub Pages 由仓库「分支自动部署」负责，无需 Actions
```

访问地址（均已加入安全域名白名单）：

- 主站：<https://zhhhuazhang.github.io/my-dashboard/>
- 备用/CDN：<https://mycloudbase-d2g3grx15f32df45e-1300750191.tcloudbaseapp.com/>

#### 发布清单（新增页面必须登记）

`dist` 只装配以下文件，**未在清单内的文件不会上线**：

```
index.html  dividend.html  investmentManagement.html  itemManagement.html
ledgerWorkbench.html  personalFinancesDashboard.html  sunlightCompass.html
assets/cloudbase-sdk.js  assets/cloudbase-sync.js
```

登记位置有两处，需同步修改：

1. `.github/workflows/deploy.yml` → `Assemble dist` 步骤的 `PAGES` / 脚本循环
2. `deploy.ps1` → `$Pages` / `$Scripts` 数组

漏登记会导致 Actions 以 `缺少页面文件 xxx` 报错退出，不会静默漏发。

#### 部署开关说明

| 参数 | 作用 |
|---|---|
| `--verify` | 发布后比对远端与本地文件大小和 MD5，不一致即失败 |
| `--safe` | 发布前备份远端，失败自动回滚 |
| `--prune` | 删除远端不属于本次发布的文件，保证云端与仓库完全对齐 |

`--prune` 与 `--safe` 必须同时使用——前者会删文件，后者提供误删恢复。

#### 凭证

Actions 使用**腾讯云 CAM 密钥**，存于仓库
**Settings → Secrets and variables → Actions**：

- `TCB_SECRET_ID` — 腾讯云 SecretId（`AKID...` 开头）
- `TCB_SECRET_KEY` — 腾讯云 SecretKey

获取：腾讯云控制台 → **访问管理 → API 密钥管理** → 新建密钥。

> ⚠️ 常见误区：`tcb login --apiKeyId/--apiKey` 传的是上述 CAM 密钥，
> **不是** CloudBase 控制台「环境 → API Key 管理」里创建的密钥。
> CloudBase 的 `api_key`（服务端）类型平台尚未开放，传入会报
> `Tencent Cloud Key verification failed`。

⚠️ CAM 密钥可操作账号下全部云资源，务必：

- 在 CAM 里新建**子用户**并仅授予 CloudBase 相关权限，不要用主账号密钥
- 任何情况下不得写入代码或日志
- 定期轮换

本地应急部署用 `deploy.ps1`，凭证通过环境变量注入（见 `.env.example`）。

#### 其他

- SDK: `assets/cloudbase-sdk.js`（本地打包，勿改）。
- 域名必须在 CloudBase 安全域名白名单内，否则 Auth 请求被拒。
  当前已在白名单：`zhhhuazhang.github.io`、CloudBase 默认托管域名。
- 回滚：在 Actions 历史里找到上一个成功的 commit，点 Re-run 即可重新部署该版本。

## Cloud resource

Pay close attention to design schemes that consume cloud resources thorough polling or circular methods ; machie shou be strongly reminded  designer of this.
