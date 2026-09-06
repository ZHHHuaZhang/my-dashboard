# 本地应急部署脚本（GitHub Actions 不可用时使用）
#
# 前置：安装 CloudBase CLI
#   npm install -g @cloudbase/cli
#
# 用法：
#   $env:CLOUDBASE_API_KEY = "你的 CloudBase 环境级 API Key"
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

if (-not $env:CLOUDBASE_API_KEY) {
    Write-Error '请先设置环境变量 CLOUDBASE_API_KEY（CloudBase 环境级 API Key，见 .env.example）'
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
tcb login --cloudbase-api-key $env:CLOUDBASE_API_KEY -e $EnvId
if ($LASTEXITCODE -ne 0) { Write-Error '登录失败' }

tcb hosting deploy dist -e $EnvId --verify --safe --prune --yes
if ($LASTEXITCODE -ne 0) { Write-Error '部署失败（--safe 已尝试自动回滚）' }

Write-Host '部署完成: https://mycloudbase-d2g3grx15f32df45e-1300750191.tcloudbaseapp.com/' -ForegroundColor Green
