[CmdletBinding()]
param(
    [ValidateSet('v1', 'v2-calibration', 'v2-pilot', 'v3-calibration', 'v3-pilot')]
    [string] $Treatment = 'v1'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)] [string] $Command,
        [Parameter(Mandatory)] [string[]] $Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command exited with code $LASTEXITCODE"
    }
}

if (-not (Test-IsAdministrator)) {
    throw 'Phase B protected execution requires a UAC-elevated parent token.'
}

$harnessRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$protectedRoot = Join-Path $harnessRoot 'protected'
$preflightSuite = Join-Path $harnessRoot 'preflight-suite.json'
$benchmarkSuite = switch ($Treatment) {
    'v2-calibration' { Join-Path $harnessRoot 'calibration-suite.v2.json' }
    'v2-pilot' { Join-Path $harnessRoot 'suite.v2.json' }
    'v3-calibration' { Join-Path $harnessRoot 'calibration-suite.v3.json' }
    'v3-pilot' { Join-Path $harnessRoot 'suite.v3.json' }
    default { Join-Path $harnessRoot 'suite.json' }
}
$oracleFile = if ($Treatment -eq 'v1') { 'recovery-oracle.json' } else { 'recovery-oracle.v2.json' }
$runner = Join-Path $env:USERPROFILE '.codex\skills\evaluate-agent-harnesses\scripts\run-suite.mjs'
$resultsRoot = Join-Path $harnessRoot 'results'
$runStamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
$elevatedReceipt = Join-Path $resultsRoot "elevated-phase-b-$Treatment-$runStamp.json"

foreach ($required in @($protectedRoot, $preflightSuite, $benchmarkSuite, $runner)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required Phase B path is missing: $required"
    }
}

foreach ($command in @('node', 'codex', 'icacls.exe')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required command is unavailable: $command"
    }
}

$originalItems = @((Get-Item -LiteralPath $protectedRoot)) +
    @(Get-ChildItem -LiteralPath $protectedRoot -Recurse -Force)

foreach ($item in $originalItems) {
    $acl = Get-Acl -LiteralPath $item.FullName
    $explicitRules = @($acl.Access | Where-Object { -not $_.IsInherited })
    if ($acl.AreAccessRulesProtected -or $explicitRules.Count -ne 0) {
        throw "Refusing to replace a non-default ACL: $($item.FullName)"
    }
}

$receipt = [ordered]@{
    schema_version = 1
    started_at = [DateTime]::UtcNow.ToString('o')
    elevated_parent = $true
    treatment = $Treatment
    protected_root = $protectedRoot
    acl_principals = @('S-1-5-18', 'S-1-5-32-544')
    preflight_exit = $null
    benchmark_exit = $null
    acl_restored = $false
    stage = 'initialized'
    outcome = 'started'
    error = $null
}

New-Item -ItemType Directory -Force -Path $resultsRoot | Out-Null

try {
    $receipt.stage = 'protecting_acl'
    Invoke-Checked 'icacls.exe' @(
        $protectedRoot,
        '/grant:r',
        '*S-1-5-18:F',
        '*S-1-5-32-544:F',
        '/T',
        '/C'
    )
    Invoke-Checked 'icacls.exe' @(
        $protectedRoot,
        '/inheritance:r',
        '/T',
        '/C'
    )

    $receipt.stage = 'verifying_acl'
    $allowedSids = @('S-1-5-18', 'S-1-5-32-544')
    $protectedItems = @((Get-Item -LiteralPath $protectedRoot)) +
        @(Get-ChildItem -LiteralPath $protectedRoot -Recurse -Force)

    foreach ($item in $protectedItems) {
        $acl = Get-Acl -LiteralPath $item.FullName
        $unexpectedAllow = @(
            $acl.Access | Where-Object {
                $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowedSids
            }
        )
        if (-not $acl.AreAccessRulesProtected -or $unexpectedAllow.Count -ne 0) {
            throw "Protected ACL verification failed: $($item.FullName)"
        }
    }

    # Parent/oracle access must remain available before starting the worker.
    Get-Content -Raw -LiteralPath (Join-Path $protectedRoot 'access-canary.txt') | Out-Null
    Get-Content -Raw -LiteralPath (Join-Path $protectedRoot $oracleFile) |
        ConvertFrom-Json | Out-Null

    $receipt.stage = 'negative_access_preflight'
    & node $runner --suite $preflightSuite
    $receipt.preflight_exit = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) {
        $receipt.outcome = 'negative_access_preflight_failed'
        throw "Protected negative-access preflight failed with code $LASTEXITCODE"
    }

    $receipt.stage = 'protected_benchmark'
    & node $runner --suite $benchmarkSuite
    $receipt.benchmark_exit = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) {
        $receipt.outcome = 'protected_benchmark_failed'
        throw "Protected benchmark failed with code $LASTEXITCODE"
    }

    $receipt.outcome = 'protected_benchmark_passed'
}
catch {
    if ($receipt.outcome -eq 'started') {
        $receipt.outcome = 'wrapper_failed'
    }
    $receipt.error = $_.Exception.Message
    throw
}
finally {
    # The repository started with inherited ACLs and no explicit rules. Restore
    # that exact shape even when the preflight or benchmark fails.
    & icacls.exe $protectedRoot /inheritance:e /T /C | Out-Null
    $inheritExit = $LASTEXITCODE
    & icacls.exe $protectedRoot /reset /T /C | Out-Null
    $resetExit = $LASTEXITCODE

    $restoredItems = @((Get-Item -LiteralPath $protectedRoot)) +
        @(Get-ChildItem -LiteralPath $protectedRoot -Recurse -Force)
    $restoreVerified = $inheritExit -eq 0 -and $resetExit -eq 0
    foreach ($item in $restoredItems) {
        $acl = Get-Acl -LiteralPath $item.FullName
        $explicitRules = @($acl.Access | Where-Object { -not $_.IsInherited })
        if ($acl.AreAccessRulesProtected -or $explicitRules.Count -ne 0) {
            $restoreVerified = $false
        }
    }

    $receipt.acl_restored = $restoreVerified
    $receipt.stage = 'finished'
    $receipt.finished_at = [DateTime]::UtcNow.ToString('o')
    $receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $elevatedReceipt -Encoding utf8

    if (-not $restoreVerified) {
        throw "Phase B protected ACL restoration failed; inspect $elevatedReceipt"
    }
}

$receipt | ConvertTo-Json -Depth 6
