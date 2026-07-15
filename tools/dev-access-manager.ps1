# ============================================================
# Dev-access manager (Herman's admin tool - needs the ubuntu SSH key)
#
# Small GUI over /home/devtunnel/.ssh/authorized_keys on the VM:
#   - lists who currently has dev-tunnel access
#   - Add: paste a teammate's public key (the wizard puts it in
#     their clipboard) and click Add
#   - Remove: select a row, click Remove, confirm
#
# The whole file travels base64-encoded in both directions, so
# keys with Chinese (or mojibake) comments survive quoting intact.
# Replaces the old grant-dev-access.ps1 one-liner (still works).
# ============================================================

$Server   = 'ubuntu@43.136.113.129'
$KeysFile = '/home/devtunnel/.ssh/authorized_keys'
$SshOpts  = @('-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'BatchMode=yes')

[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:Lines = @()   # current authorized_keys lines (source of truth after each fetch)

function Fetch-Keys {
    # base64 out so multibyte comments arrive undamaged
    $b64 = ssh @SshOpts $Server "sudo base64 -w0 $KeysFile 2>/dev/null" 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    if (-not $b64) { return @() }
    $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
    return @($text -split "`n" | Where-Object { $_.Trim() })
}

function Push-Keys([string[]]$lines) {
    # write the whole file atomically via base64 (no quoting pitfalls)
    $text = ($lines -join "`n") + "`n"
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
    $null = ssh @SshOpts $Server "echo $b64 | base64 -d | sudo tee $KeysFile >/dev/null && sudo chown devtunnel:devtunnel $KeysFile && sudo chmod 600 $KeysFile && echo PUSH_OK" 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Row-Label([string]$line) {
    $parts = $line.Trim() -split '\s+', 3
    $comment = if ($parts.Count -ge 3 -and $parts[2]) { $parts[2] } else { '(no name)' }
    $keyTail = if ($parts.Count -ge 2) { $parts[1].Substring([Math]::Max(0, $parts[1].Length - 12)) } else { '?' }
    return "$comment    [$($parts[0]) ...$keyTail]"
}

# ---------------- UI ----------------

$form = New-Object Windows.Forms.Form
$form.Text = 'Dev access manager - devtunnel keys'
$form.Size = New-Object Drawing.Size(640, 470)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 9)

$list = New-Object Windows.Forms.ListBox
$list.Location = New-Object Drawing.Point(12, 40)
$list.Size = New-Object Drawing.Size(600, 220)
$list.HorizontalScrollbar = $true

$lblTop = New-Object Windows.Forms.Label
$lblTop.Text = 'Machines that can open the DEV tunnel (one key = one computer):'
$lblTop.Location = New-Object Drawing.Point(12, 14)
$lblTop.AutoSize = $true

$lblAdd = New-Object Windows.Forms.Label
$lblAdd.Text = 'Paste a public key (one line, starts with ssh-ed25519 / ssh-rsa):'
$lblAdd.Location = New-Object Drawing.Point(12, 272)
$lblAdd.AutoSize = $true

$txtAdd = New-Object Windows.Forms.TextBox
$txtAdd.Location = New-Object Drawing.Point(12, 294)
$txtAdd.Size = New-Object Drawing.Size(600, 24)

$btnAdd = New-Object Windows.Forms.Button
$btnAdd.Text = 'Add key'
$btnAdd.Location = New-Object Drawing.Point(12, 328)
$btnAdd.Size = New-Object Drawing.Size(110, 32)

$btnRemove = New-Object Windows.Forms.Button
$btnRemove.Text = 'Remove selected'
$btnRemove.Location = New-Object Drawing.Point(132, 328)
$btnRemove.Size = New-Object Drawing.Size(130, 32)

$btnRefresh = New-Object Windows.Forms.Button
$btnRefresh.Text = 'Refresh'
$btnRefresh.Location = New-Object Drawing.Point(272, 328)
$btnRefresh.Size = New-Object Drawing.Size(90, 32)

$status = New-Object Windows.Forms.Label
$status.Location = New-Object Drawing.Point(12, 375)
$status.Size = New-Object Drawing.Size(600, 44)
$status.Text = 'Loading...'

$form.Controls.AddRange(@($lblTop, $list, $lblAdd, $txtAdd, $btnAdd, $btnRemove, $btnRefresh, $status))

function Set-Busy([bool]$busy, [string]$msg) {
    foreach ($b in @($btnAdd, $btnRemove, $btnRefresh)) { $b.Enabled = -not $busy }
    if ($msg) { $status.Text = $msg }
    $form.Refresh()
}

function Reload-List {
    Set-Busy $true 'Contacting server...'
    $fetched = Fetch-Keys
    if ($null -eq $fetched) {
        Set-Busy $false 'Could not reach the server (flaky link?). Click Refresh to retry.'
        return
    }
    $script:Lines = $fetched
    $list.Items.Clear()
    foreach ($l in $script:Lines) { [void]$list.Items.Add((Row-Label $l)) }
    Set-Busy $false "$($script:Lines.Count) key(s). Teammates get their key from tools\dev-access-wizard.bat (it lands in their clipboard)."
}

$btnRefresh.Add_Click({ Reload-List })

$btnAdd.Add_Click({
    $key = $txtAdd.Text.Trim()
    if ($key -notmatch '^(ssh-(ed25519|rsa)|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9-]+@openssh\.com)\s+[A-Za-z0-9+/=]+') {
        $status.Text = 'That does not look like a public key line (must start with ssh-ed25519 / ssh-rsa ...).'
        return
    }
    $blob = ($key -split '\s+')[1]
    if ($script:Lines | Where-Object { $_ -match [regex]::Escape($blob) }) {
        $status.Text = 'That key is already authorized.'
        return
    }
    Set-Busy $true 'Adding...'
    if (Push-Keys (@($script:Lines) + $key)) {
        $txtAdd.Text = ''
        Reload-List
        $status.Text = 'Added. Tell them: "added - run the wizard again".'
    } else {
        Set-Busy $false 'Add failed (server unreachable?). Nothing was changed - retry.'
    }
})

$btnRemove.Add_Click({
    $i = $list.SelectedIndex
    if ($i -lt 0) { $status.Text = 'Select a row first.'; return }
    $victim = Row-Label $script:Lines[$i]
    $ok = [Windows.Forms.MessageBox]::Show(
        "Remove access for:`n`n$victim`n`nTheir wizard will stop connecting immediately.",
        'Confirm removal', 'YesNo', 'Warning')
    if ($ok -ne 'Yes') { return }
    Set-Busy $true 'Removing...'
    $remaining = @($script:Lines | Where-Object { $_ -ne $script:Lines[$i] })
    if (Push-Keys $remaining) {
        Reload-List
        $status.Text = 'Removed.'
    } else {
        Set-Busy $false 'Remove failed (server unreachable?). Nothing was changed - retry.'
    }
})

$form.Add_Shown({ Reload-List })
[void]$form.ShowDialog()
