# ============================================================
# Dev-instance access wizard
#
# What this does, in plain words:
#   The DEV platform runs on our server but is NOT on the public
#   internet. The only way in is an encrypted SSH tunnel. This
#   wizard sets that up for you:
#     Step 1  Make you a personal key pair (one-time)
#     Step 2  Help you send the public half to the admin (one-time)
#     Step 3  Open the tunnel and launch the DEV platform
#
#   You never need to type a password. Your private key IS your
#   identity — it never leaves this computer. Do not share the
#   file id_ed25519 (no ".pub") with anyone, including the admin.
# ============================================================

$Server     = "43.136.113.129"
$TunnelUser = "devtunnel"
$RemotePort = 3001                    # fixed on the server; do not change
$PortCandidates = 3001, 13001, 23001, 33001, 43001   # local side tries these in order
$KeyPath    = "$env:USERPROFILE\.ssh\id_ed25519"
$AdminName  = "Herman"

# Pick the first local port nothing else is using (e.g. another app on 3001).
$LocalPort = $null
$listening = (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue).LocalPort
foreach ($p in $PortCandidates) {
    if ($listening -notcontains $p) { $LocalPort = $p; break }
}
if (-not $LocalPort) {
    Write-Host "All candidate ports ($($PortCandidates -join ', ')) are busy on this PC." -ForegroundColor Red
    Write-Host "Close some apps and run the wizard again."
    exit 1
}

function Write-Step($n, $text) {
    Write-Host ""
    Write-Host ("=" * 60) -ForegroundColor DarkGray
    Write-Host "  STEP ${n}: $text" -ForegroundColor Cyan
    Write-Host ("=" * 60) -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  ------------------------------------------------" -ForegroundColor Green
Write-Host "   DEV platform access wizard" -ForegroundColor Green
Write-Host "   (teacher-companion-agent dev instance)" -ForegroundColor Green
Write-Host "  ------------------------------------------------" -ForegroundColor Green

# ---- Step 0: check OpenSSH is available -------------------------------
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "PROBLEM: this PC has no SSH client." -ForegroundColor Red
    Write-Host "Fix (needs admin PowerShell, one time):"
    Write-Host "  Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0"
    Write-Host "Or: Settings > System > Optional features > add 'OpenSSH Client'."
    Write-Host "Then run this wizard again."
    exit 1
}

# ---- Step 1: personal key pair ----------------------------------------
Write-Step 1 "Your personal key pair"
if (Test-Path "$KeyPath.pub") {
    Write-Host "  Key already exists - nothing to do. Good." -ForegroundColor Green
} else {
    Write-Host "  No key found. Creating one now (takes a second)..."
    if (-not (Test-Path "$env:USERPROFILE\.ssh")) {
        New-Item -ItemType Directory -Path "$env:USERPROFILE\.ssh" | Out-Null
    }
    $comment = "$env:USERNAME-$env:COMPUTERNAME"
    ssh-keygen -t ed25519 -f $KeyPath -N '""' -C $comment | Out-Null
    if (-not (Test-Path "$KeyPath.pub")) {
        Write-Host "  Key creation failed. Ask $AdminName for help." -ForegroundColor Red
        exit 1
    }
    Write-Host "  Done. Key created." -ForegroundColor Green
}

# ---- Step 2: is this key authorized on the server yet? ----------------
Write-Step 2 "Checking whether the server knows you"
Write-Host "  Contacting server (a few seconds)..."
$null = ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new `
        -N -L "${LocalPort}:127.0.0.1:${RemotePort}" "$TunnelUser@$Server" -o ExitOnForwardFailure=yes -f 2>$null
Start-Sleep -Seconds 2

$probe = $null
try {
    $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$LocalPort/" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
} catch { }

if (-not $probe -or $probe.StatusCode -ne 200) {
    # Not authorized yet (or tunnel failed) -> onboarding path
    Get-Process ssh -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $pub = Get-Content "$KeyPath.pub" -Raw
    Set-Clipboard -Value $pub.Trim()
    Write-Host ""
    Write-Host "  The server does not know your key yet. One-time step:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Your PUBLIC key (safe to share) is now IN YOUR CLIPBOARD." -ForegroundColor Green
    Write-Host "  It looks like this:"
    Write-Host ""
    Write-Host "  $($pub.Trim())" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  1. Paste it to $AdminName (WeChat / email - it is not secret)."
    Write-Host "  2. Wait for $AdminName to reply 'added'."
    Write-Host "  3. Run this wizard again. That's it."
    Write-Host ""
    Write-Host "  (If $AdminName already added you and you still see this,"
    Write-Host "   check your internet connection, then ask $AdminName.)"
    exit 0
}

# ---- Step 3: tunnel is up, open the browser ---------------------------
Write-Step 3 "Access granted - opening DEV platform"
Write-Host ""
if ($LocalPort -ne $PortCandidates[0]) {
    Write-Host "  (Port $($PortCandidates[0]) was busy on this PC - using $LocalPort instead.)" -ForegroundColor Yellow
}
Write-Host "  Tunnel is running. DEV platform: http://localhost:$LocalPort/" -ForegroundColor Green
Write-Host ""
Write-Host "  IMPORTANT: keep this window open while you work." -ForegroundColor Yellow
Write-Host "  Closing it closes the tunnel (the page will stop loading)."
Write-Host "  When you are done, just close this window."
Write-Host ""
Start-Process "http://localhost:$LocalPort/"

# Foreground tunnel keeps the session alive; window close kills it.
# The -f background tunnel from the probe is already serving; wait on it.
Write-Host "  Press Ctrl+C or close this window to disconnect."
try {
    while ($true) {
        Start-Sleep -Seconds 30
        try {
            $null = Invoke-WebRequest -Uri "http://127.0.0.1:$LocalPort/" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        } catch {
            Write-Host "  Tunnel dropped (network change?). Run the wizard again." -ForegroundColor Red
            break
        }
    }
} finally {
    Get-Process ssh -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
