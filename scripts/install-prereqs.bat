@echo off
setlocal enabledelayedexpansion
set SCRIPT_DIR=%~dp0
set REPO_ROOT=%SCRIPT_DIR%..
set NODE_VERSION_DEFAULT=%NODE_VERSION%
if not defined NODE_VERSION_DEFAULT set NODE_VERSION_DEFAULT=20.18.0
set NODE_CACHE_DIR=%REPO_ROOT%\.cache\node-bootstrap

set "PS_CMD="
set "PS_CMD=%PS_CMD%$ErrorActionPreference = 'Stop';"
set "PS_CMD=%PS_CMD%$repo = [IO.Path]::GetFullPath('%REPO_ROOT%');"
set "PS_CMD=%PS_CMD%$cache = Join-Path $repo '.cache\\node-bootstrap';"
set "PS_CMD=%PS_CMD%$nodeVersion = '%NODE_VERSION_DEFAULT%';"
set "PS_CMD=%PS_CMD%function Test-Node($exe) { if (-not (Test-Path $exe)) { return $false } $ver = & $exe -v 2>$null; if ($ver -match '^v([0-9]+)\\.') { return [int]$Matches[1] -ge 18 } return $false };"
set "PS_CMD=%PS_CMD%function Resolve-Node() {"
set "PS_CMD=%PS_CMD%  $envBin = $env:NODE_BIN; if ($envBin -and (Test-Node $envBin)) { return $envBin }"
set "PS_CMD=%PS_CMD%  try { $cmd = (Get-Command node -ErrorAction Stop).Source; if (Test-Node $cmd) { return $cmd } } catch {}"
set "PS_CMD=%PS_CMD%  $arch = (Get-CimInstance Win32_Processor).Architecture; $cpu = 'x64'; if ($arch -eq 12) { $cpu = 'arm64' }"
set "PS_CMD=%PS_CMD%  $dist = \"node-v$nodeVersion-win-$cpu\";"
set "PS_CMD=%PS_CMD%  $targetDir = Join-Path $cache $dist; $nodeExe = Join-Path $targetDir 'node.exe';"
set "PS_CMD=%PS_CMD%  if (-not (Test-Path $nodeExe)) {"
set "PS_CMD=%PS_CMD%    New-Item -Force -ItemType Directory -Path $cache | Out-Null;"
set "PS_CMD=%PS_CMD%    $zip = Join-Path $cache \"$dist.zip\";"
set "PS_CMD=%PS_CMD%    Write-Host '[install-prereqs] 正在下载临时 Node.js v' + $nodeVersion + '...';"
set "PS_CMD=%PS_CMD%    $url = \"https://nodejs.org/dist/v$nodeVersion/$dist.zip\";"
set "PS_CMD=%PS_CMD%    Invoke-WebRequest -Uri $url -OutFile $zip;"
set "PS_CMD=%PS_CMD%    Write-Host '[install-prereqs] 正在解压 Node.js...';"
set "PS_CMD=%PS_CMD%    if (Test-Path $targetDir) { Remove-Item -Recurse -Force $targetDir }"
set "PS_CMD=%PS_CMD%    Expand-Archive -Path $zip -DestinationPath $cache -Force;"
set "PS_CMD=%PS_CMD%  }"
set "PS_CMD=%PS_CMD%  return $nodeExe"
set "PS_CMD=%PS_CMD%};"
set "PS_CMD=%PS_CMD%$result = Resolve-Node; if (-not $result) { Write-Error '无法获取 Node.js'; exit 1 }"
set "PS_CMD=%PS_CMD%Write-Output $result;"

for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "%PS_CMD%"`) do set NODE_BIN_RESOLVED=%%i
if not defined NODE_BIN_RESOLVED (
  echo [install-prereqs] 未能获取 Node.js，可手动安装 Node 18+ 后重试。
  exit /b 1
)
echo [install-prereqs] 使用 Node 可执行文件: %NODE_BIN_RESOLVED%
"%NODE_BIN_RESOLVED%" "%REPO_ROOT%\scripts\install-prereqs.mjs" %*
