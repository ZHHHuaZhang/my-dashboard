# 本地应急部署脚本（GitHub Actions 不可用时使用）
#
# 前置：安装 CloudBase CLI
#   npm install -g @cloudbase/cli
#
# 用法：
#   $env:CLOUDBASE_APIKEY_ID = "你的 keyId"
#   $env:CLOUDBASE_APIKEY    = "你的 apiKey"
#   .\deploy.ps1
#
# 注意：api_key 属服务端凭证，不要写进本文件或提交到仓库。

$ErrorActionPreference = 'Stop'

$EnvId = 'mycloudbase-d2g3grx15f32df45e'
$Pages = @(
    'index.html',
    'dividend.html',
    'investmentManagement.html',
    'itemManagement.html',
    'ledgerWorkbench.html',
    'personalFinancesDashboard.html',
    'sunlightCompass.html'
)
$Scripts = @('assets/cloudbase-sdk.js', 'assets/cloudbase-sync.js')

if (-not $env:CLOUDBASE_APIKEY_ID -or -not $env:CLOUDBASE_APIKEY) {
    Write-Error '请先设置环境变量 CLOUDBASE_APIKEY_ID 与 CLOUDBASE_APIKEY'
}

# 组装 dist
if (Test-Path dist) { Remove-Item dist -Recurse -Force }
New-Item -ItemType Directory -Force -Path dist/assets | Out-Null

foreach ($f in $Pages) {
    if (-not (Test-Path $f)) { Write-Error "缺少页面文件 $f" }
    Copy-Item $f dist/
}
foreach ($f in $Scripts) {
    if (-not (Test-Path $f)) { Write-Error "缺少脚本文件 $f" }
    Copy-Item $f dist/assets/
}

Write-Host '=== 本次部署清单 ===' -ForegroundColor Cyan
Get-ChildItem -Recurse -File dist | ForEach-Object { Write-Host ('  ' + $_.FullName.Replace((Get-Location).Path + '\', '')) }
Write-Host ('文件数: ' + (Get-ChildItem -Recurse -File dist).Count) -ForegroundColor Cyan

# 登录并部署
tcb login --apiKeyId $env:CLOUDBASE_APIKEY_ID --apiKey $env:CLOUDBASE_APIKEY
if ($LASTEXITCODE -ne 0) { Write-Error '登录失败' }

tcb hosting deploy dist -e $EnvId --verify --safe --prune --yes
if ($LASTEXITCODE -ne 0) { Write-Error '部署失败（--safe 已尝试自动回滚）' }

Write-Host '部署完成: https://mycloudbase-d2g3grx15f32df45e-1300750191.tcloudbaseapp.com/' -ForegroundColor Green
