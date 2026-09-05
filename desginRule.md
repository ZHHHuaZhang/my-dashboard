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

同步地址（已部署，安全域名白名单内）：
`https://mycloudbase-d2g3grx15f32df45e-1300750191.tcloudbaseapp.com/`

- SDK: `assets/cloudbase-sdk.js`（本地打包，勿改）。
- The hosting domain MUST be in the CloudBase 安全域名白名单，否则 Auth 请求被拒绝。
  体验版套餐不支持添加自定义域名，GitHub Pages 域名无法入白名单。
- 新增页面后须重新执行 `manageHosting(action="upload")` 才会上线。

## Cloud resource

Pay close attention to design schemes that consume cloud resources thorough polling or circular methods ; machie shou be strongly reminded  designer of this.
