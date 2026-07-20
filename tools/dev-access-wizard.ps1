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

# ---- Step 2: open the tunnel (non-blocking) and check access ----------
Write-Step 2 "Checking whether the server knows you"
Write-Host "  Contacting server (up to ~15s)..."

# Launch ssh as a real background process. Windows OpenSSH does not background
# reliably with -f (it can run in the foreground and hang the wizard), so we use
# Start-Process and keep the handle. ServerAliveInterval makes a stalled
# handshake fail fast instead of hanging. We only ever stop THIS ssh by its Id,
# never a broad "kill all ssh" (that would also kill your admin sessions).
$sshArgs = @(
    '-o','BatchMode=yes','-o','ConnectTimeout=10',
    '-o','ServerAliveInterval=5','-o','ServerAliveCountMax=3',
    '-o','StrictHostKeyChecking=accept-new','-o','ExitOnForwardFailure=yes',
    '-N','-L',"${LocalPort}:127.0.0.1:${RemotePort}","$TunnelUser@$Server"
)
$tunnel = Start-Process ssh -ArgumentList $sshArgs -WindowStyle Hidden -PassThru

$probe = $null
for ($i = 0; $i -lt 7; $i++) {
    if ($tunnel.HasExited) { break }        # ssh gave up (key not added / forward refused)
    Start-Sleep -Seconds 2
    try { $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$LocalPort/" -UseBasicParsing -TimeoutSec 4 -ErrorAction Stop } catch { $probe = $null }
    if ($probe -and $probe.StatusCode -eq 200) { break }
}

if (-not $probe -or $probe.StatusCode -ne 200) {
    if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
    $pub = Get-Content "$KeyPath.pub" -Raw
    Set-Clipboard -Value $pub.Trim()
    Write-Host ""
    Write-Host "  Could not open the tunnel yet. Most likely one of:" -ForegroundColor Yellow
    Write-Host "    - the server has not added your key yet, or"
    Write-Host "    - the link was slow/blocked just now (a re-run usually works)."
    Write-Host ""
    Write-Host "  Your PUBLIC key (safe to share) is now IN YOUR CLIPBOARD." -ForegroundColor Green
    Write-Host "  It looks like this:"
    Write-Host ""
    Write-Host "  $($pub.Trim())" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  1. Paste it to $AdminName (WeChat / email - it is not secret)."
    Write-Host "  2. Wait for $AdminName to reply 'added'."
    Write-Host "  3. Run this wizard again. If $AdminName already added you,"
    Write-Host "     just re-run - a slow link often connects on the second try."
    exit 0
}

# ---- Step 3: tunnel is up, open the browser ---------------------------
Write-Step 3 "Access granted - tunnel is running"
Write-Host ""
if ($LocalPort -ne $PortCandidates[0]) {
    Write-Host "  (Port $($PortCandidates[0]) was busy on this PC - using $LocalPort instead.)" -ForegroundColor Yellow
}

# Teammates kept missing the quiet one-line prompt and thought the wizard had
# stalled. Loud block + a re-ask on invalid input; plain Enter still means 1.
Write-Host ""
Write-Host ("  " + ("=" * 56)) -ForegroundColor Yellow
Write-Host "   >>> YOUR TURN - TYPE A NUMBER AND PRESS Enter <<<   " -ForegroundColor Black -BackgroundColor Yellow
Write-Host ("  " + ("=" * 56)) -ForegroundColor Yellow
Write-Host ""
Write-Host "     1   DEV platform (chat)      http://localhost:$LocalPort/" -ForegroundColor Cyan
Write-Host "     2   Admin data console       http://localhost:$LocalPort/admin" -ForegroundColor Cyan
Write-Host "     3   Both pages" -ForegroundColor Cyan
Write-Host ""
Write-Host "     (just pressing Enter opens the platform)" -ForegroundColor DarkGray
Write-Host ""
do {
    $choice = Read-Host "  ==> Open which page? [1 / 2 / 3]"
    $ok = ($choice -in '', '1', '2', '3')
    if (-not $ok) { Write-Host "  '$choice' is not an option - type 1, 2 or 3 (or just Enter)." -ForegroundColor Red }
} until ($ok)
if ($choice -eq '2' -or $choice -eq '3') { Start-Process "http://localhost:$LocalPort/admin" }
if ($choice -ne '2') { Start-Process "http://localhost:$LocalPort/" }
Write-Host ""
Write-Host "  IMPORTANT: keep this window open while you work." -ForegroundColor Yellow
Write-Host "  Closing it closes the tunnel (the page will stop loading)."
Write-Host "  When you are done, just close this window."
Write-Host ""

# Watchdog with self-healing: the mainland link stalls now and then, so one
# slow probe must NOT kill a healthy session. Declare trouble only after the
# ssh process died or 3 consecutive probe misses, then quietly reconnect
# (up to 30 times in a row) instead of telling the human to start over.
Write-Host "  Press Ctrl+C or close this window to disconnect."
$failStreak = 0
$reconnects = 0
try {
    while ($true) {
        Start-Sleep -Seconds 20
        $ok = $false
        if (-not $tunnel.HasExited) {
            try {
                $null = Invoke-WebRequest -Uri "http://127.0.0.1:$LocalPort/" -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop
                $ok = $true
            } catch { }
        }
        if ($ok) {
            if ($reconnects -gt 0) { Write-Host "  Connection healthy again." -ForegroundColor Green }
            $failStreak = 0; $reconnects = 0
            continue
        }
        $failStreak++
        if (-not $tunnel.HasExited -and $failStreak -lt 3) { continue }   # slow link - tolerate two misses
        if ($reconnects -ge 30) {
            Write-Host "  Could not keep the tunnel up (30 reconnect attempts failed)." -ForegroundColor Red
            Write-Host "  Check your internet connection, then run the wizard again."
            break
        }
        $reconnects++
        Write-Host "  Tunnel hiccup - reconnecting ($reconnects/30)..." -ForegroundColor Yellow
        if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
        $tunnel = Start-Process ssh -ArgumentList $sshArgs -WindowStyle Hidden -PassThru
        Start-Sleep -Seconds 8
        $failStreak = 0
    }
} finally {
    if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
}
