# 从用户级 DPAPI 文件里解密 DeepSeek 密钥，注入环境变量后运行翻译脚本。
# 密钥只存在于本进程环境里，不写入任何文件。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\run-translate.ps1 --size=60 --concurrency=5
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)

Add-Type -AssemblyName System.Security

$keyFile = Join-Path $env:USERPROFILE '.codex\deepseek-worker.key.dpapi'
if (-not (Test-Path $keyFile)) {
  throw "找不到密钥文件：$keyFile。请先在 Codex 里运行 deepseek_worker.py configure。"
}

$blob = [System.IO.File]::ReadAllBytes($keyFile)
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
$env:DEEPSEEK_API_KEY = [System.Text.Encoding]::UTF8.GetString($plain).Trim()

$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
  & node src/translate.js @Rest
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
