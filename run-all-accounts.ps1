# ============================================================
# Run Multiple Visa Bot Accounts in Separate PowerShell Windows
# Each account runs nothang.js for Toronto
# ============================================================

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptPath

# Account configurations
$accounts = @(
    @{ email = "ranvir9060001@gmail.com"; password = "Filing123$" },
    @{ email = "palupasna2501@gmail.com"; password = "Upasna@123" },
    @{ email = "parmar.rahul.187201@gmail.com"; password = "sonu1872" },
    @{ email = "hardik1996.p01@gmail.com"; password = "Hard1996@Pru" },
    @{ email = "Jashan842602@gmail.com"; password = "Davinder123@" },
    @{ email = "Khera359301@gmail.com"; password = "Nitikakhera@2609" },
    @{ email = "patelmeet1421@gmail.com"; password = "Jayambe22" },
    @{ email = "Kartikmandora200101@gmail.com"; password = "Candy@1608" },
    @{ email = "ks86033801@gmail.com"; password = "Kamaldeep@1" }
)

# Common settings
$city = "Toronto"
$startDate = "2026-01-17"
$endDate = "2026-05-30"
$baseUrl = "https://ais.usvisa-info.com/en-ca/niv"
$telegramToken = "8452739802:AAFc-_sguwlQqwV5_UJPUkcsWbjRCM-Cjds"
$telegramChatId = "8448289435"
$proxyServer = "pr.oxylabs.io:7777"
$proxyUsername = "customer-shivansh_eMxFt-cc-us-st-us_washington-city-seattle"
$proxyPassword = "ay+oWeQ54BO2ko"
$targetCPM = "350"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Launching $($accounts.Count) accounts for $city" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan

for ($i = 0; $i -lt $accounts.Count; $i++) {
    $account = $accounts[$i]
    $envFile = "env_account_$($i + 1).env"
    $shortEmail = $account.email.Split("@")[0]

    # Create .env file for this account
    $envContent = @"
# Account $($i + 1): $($account.email)
VISA_EMAIL=$($account.email)
VISA_PASSWORD=$($account.password)
PREFERRED_CITY=$city
START_DATE=$startDate
END_DATE=$endDate
VISA_BASE_URL=$baseUrl
TELEGRAM_BOT_TOKEN=$telegramToken
TELEGRAM_CHAT_ID=$telegramChatId
PROXY_ENABLED=true
PROXY_SERVER=$proxyServer
PROXY_USERNAME=$proxyUsername-sessid-$($i + 1)$(Get-Random -Maximum 99999)
PROXY_PASSWORD=$proxyPassword
TARGET_CPM=$targetCPM
HEADLESS=true
"@

    # Write env file
    $envContent | Out-File -FilePath $envFile -Encoding UTF8 -NoNewline
    Write-Host "[$($i + 1)/$($accounts.Count)] Created $envFile for $shortEmail" -ForegroundColor Yellow

    # Launch in new PowerShell window
    $command = "Set-Location '$scriptPath'; Copy-Item '$envFile' '.env' -Force; node nothang.js; Read-Host 'Press Enter to close'"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $command

    Write-Host "[$($i + 1)/$($accounts.Count)] Launched $shortEmail in new window" -ForegroundColor Green

    # Small delay between launches to avoid overwhelming
    Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  All $($accounts.Count) accounts launched!" -ForegroundColor Green
Write-Host "  Each running in separate PowerShell window" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
