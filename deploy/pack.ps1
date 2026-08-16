# Build a slim production archive (no .claude / node_modules / tests).
# Usage from repo root:
#   powershell -ExecutionPolicy Bypass -File deploy/pack.ps1
#   powershell -ExecutionPolicy Bypass -File deploy/pack.ps1 -WithImage
param(
  [switch]$WithImage
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$Dist = Join-Path $Root 'dist'
$Name = "acc-core-$Stamp"
$Stage = Join-Path $Dist $Name
$Archive = Join-Path $Dist "$Name.tar.gz"

New-Item -ItemType Directory -Force -Path $Stage | Out-Null

foreach ($dir in @('src', 'server', 'public')) {
  Copy-Item -Recurse -Force (Join-Path $Root $dir) (Join-Path $Stage $dir)
}

New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'deploy') | Out-Null
foreach ($file in @(
  'Dockerfile',
  'docker-compose.yml',
  'env.example',
  'start.sh',
  'hot-deploy.sh',
  'nginx.conf.example',
  'openapi.md'
)) {
  Copy-Item -Force (Join-Path $PSScriptRoot $file) (Join-Path $Stage "deploy\$file")
}

foreach ($file in @('package.json', 'package-lock.json', '.dockerignore')) {
  Copy-Item -Force (Join-Path $Root $file) (Join-Path $Stage $file)
}

@(
  'Unpack, then:',
  '',
  '  tar -xzf acc-core-*.tar.gz -C /opt',
  '  cd /opt/acc-core-*',
  '  cp deploy/env.example deploy/.env',
  '  # edit WORKBENCH_PASSWORD and ALLOWED_HOSTS',
  '  bash deploy/start.sh',
  '',
  'If you also uploaded *-image.tar, start.sh will docker load it and skip the build.'
) | Set-Content -Encoding utf8 (Join-Path $Stage 'START.txt')

if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
  throw 'tar not found. Windows 10 includes tar.exe, or install Git for Windows.'
}
tar -czf $Archive -C $Dist $Name
Remove-Item -Recurse -Force $Stage

$imageArchive = $null
if ($WithImage) {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw '-WithImage requires Docker Desktop in Linux container mode.'
  }
  Write-Host 'Building Linux image (first run is slow)...'
  docker compose -f (Join-Path $PSScriptRoot 'docker-compose.yml') build
  $imageArchive = Join-Path $Dist "$Name-image.tar"
  docker save -o $imageArchive acc-core:latest
}

function Format-Size([string]$path) {
  if (-not $path -or -not (Test-Path $path)) { return '' }
  '{0:N1} MB' -f ((Get-Item $path).Length / 1MB)
}

Write-Host ''
Write-Host ("Release: {0}  ({1})" -f $Archive, (Format-Size $Archive))
if ($imageArchive) {
  Write-Host ("Image:   {0}  ({1})" -f $imageArchive, (Format-Size $imageArchive))
}
Write-Host 'Upload this archive to the server. You do not need the full repo.'
