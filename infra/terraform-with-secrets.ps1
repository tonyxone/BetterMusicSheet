[CmdletBinding()]
param(
    [ValidateSet("plan", "apply")]
    [string]$Command = "plan",

    [string]$SecretArn = $(if ($env:BMS_SOCIAL_SECRET_ARN) { $env:BMS_SOCIAL_SECRET_ARN }
                          else { "arn:aws:secretsmanager:us-west-1:324752064997:secret:better_music_sheet_singin_provider-eKRi1G" }),

    [string]$VarFile = "serverless.tfvars",

    [switch]$AutoApprove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($AutoApprove -and $Command -ne "apply") {
    throw "-AutoApprove can only be used with -Command apply."
}

$terraformVariables = @(
    "google_client_id",
    "google_client_secret",
    "apple_services_id",
    "apple_team_id",
    "apple_key_id",
    "apple_private_key"
)
$previousEnvironment = @{}
foreach ($variableName in $terraformVariables) {
    $environmentName = "TF_VAR_$variableName"
    $previousEnvironment[$environmentName] = [Environment]::GetEnvironmentVariable(
        $environmentName,
        "Process"
    )
}

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $scriptDirectory
try {
    if (-not (Get-Command terraform -ErrorAction SilentlyContinue)) {
        throw "Terraform was not found on PATH."
    }
    if (-not (Test-Path -LiteralPath $VarFile -PathType Leaf)) {
        throw "Terraform variable file was not found: $VarFile"
    }

    # Reuse the cross-platform loader's PowerShell twin so JSON decoding, PEM
    # newline handling, and the allowlist of Terraform variables stay in one
    # place. Dot-sourcing keeps its process environment exports available here.
    . "$scriptDirectory\social-signin-env.ps1" -SecretArn $SecretArn

    foreach ($variableName in $terraformVariables) {
        $value = [Environment]::GetEnvironmentVariable("TF_VAR_$variableName", "Process")
        if ([string]::IsNullOrWhiteSpace($value)) {
            throw "The social sign-in secret did not provide a non-empty '$variableName' value."
        }
    }

    $arguments = @($Command, "-var-file=$VarFile")
    if ($AutoApprove) {
        $arguments += "-auto-approve"
    }

    & terraform @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "terraform $Command failed with exit code $LASTEXITCODE."
    }
}
finally {
    foreach ($variableName in $terraformVariables) {
        $environmentName = "TF_VAR_$variableName"
        [Environment]::SetEnvironmentVariable(
            $environmentName,
            $previousEnvironment[$environmentName],
            "Process"
        )
    }
    Pop-Location
}
