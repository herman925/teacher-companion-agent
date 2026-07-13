# Admin helper (Herman only): authorize a fellow's public key for the dev tunnel.
#
# Usage:
#   .\grant-dev-access.ps1 "ssh-ed25519 AAAA... name-pc"
#   .\grant-dev-access.ps1            # then paste the key when prompted
#
# Revoke someone later: edit the server file and delete their line:
#   ssh ubuntu@43.136.113.129 "sudo nano /home/devtunnel/.ssh/authorized_keys"

param([string]$PublicKey)

$Server = "43.136.113.129"

if (-not $PublicKey) {
    $PublicKey = Read-Host "Paste the fellow's public key (starts with ssh-ed25519 or ssh-rsa)"
}
$PublicKey = $PublicKey.Trim()

if ($PublicKey -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) \S+') {
    Write-Host "That does not look like a public key. Expected 'ssh-ed25519 AAAA...'" -ForegroundColor Red
    exit 1
}
if ($PublicKey -match 'PRIVATE KEY') {
    Write-Host "STOP: that is a PRIVATE key. Never accept or transmit private keys." -ForegroundColor Red
    Write-Host "Ask the fellow to send the .pub file contents instead."
    exit 1
}

ssh "ubuntu@$Server" "echo '$PublicKey' | sudo tee -a /home/devtunnel/.ssh/authorized_keys >/dev/null && sudo sort -u /home/devtunnel/.ssh/authorized_keys -o /home/devtunnel/.ssh/authorized_keys && echo ADDED && sudo wc -l /home/devtunnel/.ssh/authorized_keys"
if ($LASTEXITCODE -eq 0) {
    Write-Host "Done. Tell the fellow to run the wizard again." -ForegroundColor Green
} else {
    Write-Host "Failed - check your own SSH access to the server." -ForegroundColor Red
}
