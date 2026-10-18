$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$skillHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$destination = Join-Path $skillHome 'skills\aesthetic-notes'
$files = @(
    @('skills\aesthetic-notes\SKILL.md', 'SKILL.md'),
    @('skills\aesthetic-notes\agents\openai.yaml', 'agents\openai.yaml'),
    @('skills\aesthetic-notes\references\organization.md', 'references\organization.md'),
    @('skills\aesthetic-notes\scripts\notes.mjs', 'scripts\notes.mjs'),
    @('lib\store.mjs', 'runtime\lib\store.mjs'),
    @('lib\folders.mjs', 'runtime\lib\folders.mjs'),
    @('lib\lock.mjs', 'runtime\lib\lock.mjs'),
    @('lib\files.mjs', 'runtime\lib\files.mjs'),
    @('lib\preview.mjs', 'runtime\lib\preview.mjs'),
    @('scripts\notes.mjs', 'runtime\scripts\notes.mjs')
)
foreach ($pair in $files) {
    $target = Join-Path $destination $pair[1]
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination ($target + '.previous') -Force }
    Copy-Item -LiteralPath (Join-Path $appRoot $pair[0]) -Destination $target -Force
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $destination 'skill-manifest.json'), (@{ name = 'aesthetic-notes'; version = '0.3.0' } | ConvertTo-Json), $utf8)
$libraryConfig = Join-Path $destination 'scripts\library.json'
if (-not (Test-Path -LiteralPath $libraryConfig)) {
    [IO.File]::WriteAllText($libraryConfig, (@{ root = $appRoot } | ConvertTo-Json), $utf8)
}
Write-Output $destination
