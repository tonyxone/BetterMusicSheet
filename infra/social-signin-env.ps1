# Load the social sign-in credentials out of AWS Secrets Manager and into the
# TF_VAR_* environment variables Terraform reads, so the values never sit on
# disk in a .tfvars file. Windows counterpart of social-signin-env.sh.
#
# Run it from a PowerShell prompt, then apply from that SAME window:
#
#   .\infra\social-signin-env.ps1
#   terraform -chdir=infra apply -var-file=serverless.tfvars
#
# Environment variables are per-process, so they last exactly as long as that
# PowerShell session. Do NOT launch it as `powershell -File ...` from cmd.exe:
# that starts a second process, sets the variables there, and throws them away
# on exit. cmd.exe cannot be used directly either - `set` has no way to put the
# newlines of a PEM key into a variable.
#
# If the script is blocked by the execution policy, unblock this session only
# (it does not spawn a process, so the exports survive):
#
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#
# The secret must be a JSON object whose keys are the Terraform variable names
# from cognito-idp.tf - see the comment in social-signin-env.sh for the shape.
# Only keys naming a real variable are exported; anything else is reported by
# NAME, so a typo is obvious without the value ever being printed.

[CmdletBinding()]
param(
    [string]$SecretArn = $(if ($env:BMS_SOCIAL_SECRET_ARN) { $env:BMS_SOCIAL_SECRET_ARN }
                          else { "arn:aws:secretsmanager:us-west-1:324752064997:secret:better_music_sheet_singin_provider-eKRi1G" })
)

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    Write-Error "social-signin-env: the AWS CLI is not on PATH."
    return
}

$json = aws secretsmanager get-secret-value --secret-id $SecretArn --query SecretString --output text
if ($LASTEXITCODE -ne 0) {
    Write-Error "social-signin-env: couldn't read $SecretArn (the AWS CLI error is above)."
    return
}

try {
    # ConvertFrom-Json turns the \n escapes back into real newlines, which the
    # .p8 needs - Cognito rejects a private key that is one long line.
    $secret = ($json -join "`n") | ConvertFrom-Json
} catch {
    Write-Error "social-signin-env: that secret isn't JSON (see social-signin-env.sh for the shape)."
    return
}
if ($secret -isnot [psobject] -or $secret -is [string]) {
    Write-Error "social-signin-env: that secret isn't a JSON object of variable name -> value."
    return
}

# Exactly the variables cognito-idp.tf declares. A provider switches on in
# Terraform the moment its id is non-empty, so exporting a stray TF_VAR_ would
# quietly try to create a provider with no credentials.
$known = @(
    "google_client_id", "google_client_secret",
    "facebook_app_id", "facebook_app_secret",
    "apple_services_id", "apple_team_id", "apple_key_id", "apple_private_key"
)

$loaded = @()
$skipped = @()
foreach ($property in $secret.PSObject.Properties) {
    if ($known -notcontains $property.Name) {
        $skipped += $property.Name
        continue
    }
    # A key round-tripped through a Windows editor picks up CRs that make the
    # PEM unparseable in a way whose error message says nothing useful.
    $value = [string]$property.Value
    $value = $value -replace "`r", ""
    Set-Item -Path ("env:TF_VAR_" + $property.Name) -Value $value
    $loaded += $property.Name
}

if ($loaded.Count -eq 0) {
    Write-Error "social-signin-env: no recognised keys in that secret."
    if ($skipped.Count -gt 0) { Write-Host "  found instead: $($skipped -join ' ')" }
    return
}

# Values are never echoed - only which variables are now set, and enough shape
# for the .p8 to be checked at a glance.
Write-Host "Exported: $(($loaded | ForEach-Object { 'TF_VAR_' + $_ }) -join ' ')"
if ($env:TF_VAR_apple_private_key) {
    # Non-empty lines only, so the count matches the .sh script's for the
    # same key (a PEM normally ends with a trailing newline).
    $lines = (($env:TF_VAR_apple_private_key -split "`n") | Where-Object { $_ -ne "" }).Count
    if ($env:TF_VAR_apple_private_key -notmatch "BEGIN PRIVATE KEY") {
        Write-Warning "apple_private_key has no BEGIN PRIVATE KEY line - paste the .p8 whole, header and footer included."
    } elseif ($lines -lt 3) {
        Write-Warning "apple_private_key is a single line - its newlines were lost. Store it with \n escapes in the JSON secret."
    } else {
        Write-Host "  apple_private_key looks like a PEM ($lines lines)."
    }
}
if ($skipped.Count -gt 0) {
    Write-Host "Ignored (not a variable in cognito-idp.tf): $($skipped -join ' ')"
}
