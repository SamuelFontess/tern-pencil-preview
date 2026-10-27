param([Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$published = $false
$replacing = $false
$code = 'SAVE_FAILED'
try {
    $m = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $allowed = @('candidate', 'original', 'backup', 'expected_hash', 'candidate_hash')
    $names = @($m.PSObject.Properties.Name)
    if ($names.Count -ne $allowed.Count -or @($names | Where-Object { $_ -notin $allowed }).Count -ne 0) {
        $code = 'SAVE_MANIFEST_INVALID'
        throw 'Manifest contains unknown or missing fields'
    }
    if (Test-Path -LiteralPath $m.backup) {
        $code = 'SAVE_BACKUP_EXISTS'
        throw 'Backup destination already exists'
    }
    $candidateHash = (Get-FileHash -LiteralPath $m.candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($candidateHash -ne $m.candidate_hash) {
        $code = 'SAVE_CANDIDATE_INVALID'
        throw 'Candidate changed before publication'
    }
    $before = (Get-FileHash -LiteralPath $m.original -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($before -ne $m.expected_hash) {
        $code = 'SOURCE_CHANGED'
        throw 'Original changed before publication'
    }
    $replacing = $true
    [System.IO.File]::Replace($m.candidate, $m.original, $m.backup, $false)
    $published = $true
    $replacing = $false
    $sourceHash = (Get-FileHash -LiteralPath $m.original -Algorithm SHA256).Hash.ToLowerInvariant()
    $replacedHash = (Get-FileHash -LiteralPath $m.backup -Algorithm SHA256).Hash.ToLowerInvariant()
    $conflict = $replacedHash -ne $m.expected_hash
    $result = @{ published=$true; source_hash=$sourceHash; replaced_hash=$replacedHash; conflict=$conflict }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 4))
    if ($conflict) { exit 2 }
    exit 0
} catch {
    $outcome = $published
    if ($replacing) { $outcome = $null }
    if ($published -or $replacing) { $code = 'SAVE_UNCERTAIN' }
    $result = @{ published=$outcome; error=@{ code=$code; message=$_.Exception.Message } }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 4))
    exit 1
}
