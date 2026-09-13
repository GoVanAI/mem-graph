[CmdletBinding()]
param(
    [ValidateSet('preflight', 'scored')]
    [string] $Treatment = 'scored',
    [Parameter(Mandatory)]
    [string] $ExpectedManifestSha256
)

# Fixture-only effectiveness benchmark. This wrapper does not establish
# production trust, human presence, enrollment, or deployment readiness.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Invoke-Checked {
    param([Parameter(Mandatory)][string] $Command, [Parameter(Mandatory)][string[]] $Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command exited with code $LASTEXITCODE" }
}
function Test-DefaultInheritedAcl {
    param([Parameter(Mandatory)][string] $Path)
    $items = @((Get-Item -LiteralPath $Path)) + @(Get-ChildItem -LiteralPath $Path -Recurse -Force)
    foreach ($item in $items) {
        $acl = Get-Acl -LiteralPath $item.FullName
        $explicit = @($acl.Access | Where-Object { -not $_.IsInherited })
        if ($acl.AreAccessRulesProtected -or $explicit.Count -ne 0) { throw "Refusing non-default ACL: $($item.FullName)" }
    }
}
function Test-RestrictedAcl {
    param([Parameter(Mandatory)][string] $Path)
    $allowed = @('S-1-5-18', 'S-1-5-32-544')
    $items = @((Get-Item -LiteralPath $Path)) + @(Get-ChildItem -LiteralPath $Path -Recurse -Force)
    foreach ($item in $items) {
        $acl = Get-Acl -LiteralPath $item.FullName
        $unexpected = @($acl.Access | Where-Object {
            $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed
        })
        if (-not $acl.AreAccessRulesProtected -or $unexpected.Count -ne 0) { throw "Restricted ACL verification failed: $($item.FullName)" }
    }
}

if (-not (Test-IsAdministrator)) { throw 'Fixture Phase F execution requires a UAC-elevated parent token.' }
$harnessRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$protectedRoot = Join-Path $harnessRoot 'protected'
$runner = Join-Path $PSScriptRoot 'run-suite-file-stdio.mjs'
$verifier = Join-Path $PSScriptRoot 'verify-freeze.mjs'
$manifest = Join-Path $harnessRoot 'freeze.manifest.v1.json'
$preflightSuite = Join-Path $harnessRoot 'preflight-suite.fixture.v1.json'
$scoredSuite = Join-Path $harnessRoot 'suite.fixture.v1.json'
$externalResultsRoot = Join-Path $env:LOCALAPPDATA 'mem-graph-phase-f-fixture-results'
$runId = "phase-f-fixture-$Treatment-$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ss-fffZ'))-$([guid]::NewGuid().ToString('N'))"
$resultsPath = Join-Path $externalResultsRoot $runId
$receiptPath = Join-Path $externalResultsRoot "$runId.receipt.json"
$preflightRunnerStdout = Join-Path $externalResultsRoot "$runId.preflight.runner.stdout.log"
$preflightRunnerStderr = Join-Path $externalResultsRoot "$runId.preflight.runner.stderr.log"
$scoredRunnerStdout = Join-Path $externalResultsRoot "$runId.scored.runner.stdout.log"
$scoredRunnerStderr = Join-Path $externalResultsRoot "$runId.scored.runner.stderr.log"
$codexVersionStdout = Join-Path $externalResultsRoot "$runId.codex-version.stdout.log"
$codexVersionStderr = Join-Path $externalResultsRoot "$runId.codex-version.stderr.log"

if ($ExpectedManifestSha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw 'ExpectedManifestSha256 must be a 64-character SHA-256 hex digest.' }
$ExpectedManifestSha256 = $ExpectedManifestSha256.ToLowerInvariant()
$actualManifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest).Hash.ToLowerInvariant()
if ($actualManifestSha256 -ne $ExpectedManifestSha256) { throw 'Freeze manifest digest does not match the parent-reviewed expected digest.' }

foreach ($required in @($protectedRoot, $runner, $verifier, $manifest, $preflightSuite, $scoredSuite)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required Phase F path is missing: $required" }
}
foreach ($command in @('node', 'codex', 'icacls.exe')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command is unavailable: $command" }
}
$resolvedNode = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$resolvedCodex = (Get-Command codex.exe -CommandType Application -ErrorAction Stop).Source
Invoke-Checked 'node' @($verifier, $manifest)
Test-DefaultInheritedAcl $protectedRoot
New-Item -ItemType Directory -Force -Path $externalResultsRoot | Out-Null

$receipt = [ordered]@{
    schema_version = 1; status = 'started'; treatment = $Treatment; started_at = [DateTime]::UtcNow.ToString('o')
    fixture_only = $true; production_trust_assurance = 'deferred_not_passed'; elevated_parent = $true
    protected_root = $protectedRoot; external_results = $resultsPath; receipt_path = $receiptPath
    expected_manifest_sha256 = $ExpectedManifestSha256; actual_manifest_sha256 = $actualManifestSha256
    runner = $runner; runner_transport = 'fd_backed_files_v1'; runner_spawn_contract = 'node child_process spawn(command=codex, shell=false, stdio=file_descriptors)'
    resolved_node = $resolvedNode; resolved_codex = $resolvedCodex
    command_override_routing = 'absolute_codex_provider_and_node_grader_v1'
    runner_command_overrides = @{ codex_command = $resolvedCodex; node_command = $resolvedNode }
    codex_version_stdout = $codexVersionStdout; codex_version_stderr = $codexVersionStderr; codex_version_exit = $null
    preflight_runner_stdout = $preflightRunnerStdout; preflight_runner_stderr = $preflightRunnerStderr
    scored_runner_stdout = $scoredRunnerStdout; scored_runner_stderr = $scoredRunnerStderr
    preflight_exit = $null; scored_exit = $null; scored_outcome = $null; acl_restored = $false; error = $null
}
$oldCanary = $env:PHASE_F_PROTECTED_CANARY
try {
    # Diagnostic only: validates the exact elevated executable before a runner
    # asks Node to spawn its default `codex` command. It does not launch a worker.
    & $resolvedCodex --version 1> $codexVersionStdout 2> $codexVersionStderr
    $receipt.codex_version_exit = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw "Elevated codex --version diagnostic failed with code $LASTEXITCODE" }
    Invoke-Checked 'icacls.exe' @($protectedRoot, '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F', '/T', '/C')
    Invoke-Checked 'icacls.exe' @($protectedRoot, '/inheritance:r', '/T', '/C')
    Test-RestrictedAcl $protectedRoot
    Get-Content -Raw -LiteralPath (Join-Path $protectedRoot 'access-canary.txt') | Out-Null
    Get-Content -Raw -LiteralPath (Join-Path $protectedRoot 'recovery-oracle.v2.json') | ConvertFrom-Json | Out-Null
    $env:PHASE_F_PROTECTED_CANARY = Join-Path $protectedRoot 'access-canary.txt'
    & $resolvedNode $runner --codex-command $resolvedCodex --node-command $resolvedNode --suite $preflightSuite --results (Join-Path $resultsPath 'preflight') 1> $preflightRunnerStdout 2> $preflightRunnerStderr
    $receipt.preflight_exit = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw "Fixture negative-access preflight failed with code $LASTEXITCODE" }
    if ($Treatment -eq 'scored') {
        # Exactly one matrix invocation. A nonzero result is benchmark evidence,
        # not a wrapper failure and never a retry condition.
        & $resolvedNode $runner --codex-command $resolvedCodex --node-command $resolvedNode --suite $scoredSuite --results (Join-Path $resultsPath 'scored') 1> $scoredRunnerStdout 2> $scoredRunnerStderr
        $receipt.scored_exit = $LASTEXITCODE
        if ($LASTEXITCODE -eq 0) { $receipt.scored_outcome = 'all_hard_gates_passed'; $receipt.status = 'completed' }
        else { $receipt.scored_outcome = 'nonzero_result_requires_receipt_review'; $receipt.status = 'completed_with_task_failures' }
    } else {
        $receipt.status = 'completed'
    }
} catch {
    $receipt.status = 'failed'; $receipt.error = $_.Exception.Message
    throw
} finally {
    if ($null -eq $oldCanary) { Remove-Item Env:PHASE_F_PROTECTED_CANARY -ErrorAction SilentlyContinue } else { $env:PHASE_F_PROTECTED_CANARY = $oldCanary }
    & icacls.exe $protectedRoot /inheritance:e /T /C | Out-Null; $inheritExit = $LASTEXITCODE
    & icacls.exe $protectedRoot /reset /T /C | Out-Null; $resetExit = $LASTEXITCODE
    $restoreVerified = ($inheritExit -eq 0 -and $resetExit -eq 0)
    try { Test-DefaultInheritedAcl $protectedRoot } catch { $restoreVerified = $false }
    $receipt.acl_restored = $restoreVerified
    $receipt.finished_at = [DateTime]::UtcNow.ToString('o')
    $receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receiptPath -Encoding utf8
    if (-not $receipt.acl_restored) { throw "Phase F ACL restoration failed; inspect $receiptPath" }
}
$receipt | ConvertTo-Json -Depth 6
