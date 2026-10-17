param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$appUrl = 'http://127.0.0.1:4317'
function Test-NotesServer {
    try {
        $info = Invoke-RestMethod -Uri "$appUrl/api/info" -TimeoutSec 2
        return ($info.dataPath -eq (Join-Path $appRoot 'data')) -and ($info.version -eq '0.2.1')
    } catch { return $false }
}
if (-not (Test-NotesServer)) {
    $serverPath = Join-Path $appRoot 'server.mjs'
    $pidFile = Join-Path $appRoot '.runtime\server.pid'
    if (Test-Path -LiteralPath $pidFile) {
        $ownedPid = 0
        if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$ownedPid)) {
            $ownerProcess = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $ownedPid) -ErrorAction SilentlyContinue
            if ($ownerProcess -and $ownerProcess.Name -eq 'node.exe' -and $ownerProcess.CommandLine -match [regex]::Escape($serverPath)) {
                Stop-Process -Id $ownedPid -ErrorAction SilentlyContinue
                Start-Sleep -Milliseconds 250
            }
        }
    }
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $runtimeDir = Join-Path $appRoot '.runtime'
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    $serverPath = Join-Path $appRoot 'server.mjs'
    $serverProcess = Start-Process -FilePath $nodePath -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDir 'server.log') -RedirectStandardError (Join-Path $runtimeDir 'server-error.log')
    $serverProcess.Id | Set-Content -LiteralPath (Join-Path $runtimeDir 'server.pid')
    $ready = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 300
        if (Test-NotesServer) { $ready = $true; break }
    }
    if (-not $ready) { throw '本地服务未能启动，请查看 .runtime/server-error.log，确认 4317 端口未被其他应用占用。' }
}
if (-not $NoBrowser) { Start-Process $appUrl }
Write-Output $appUrl
