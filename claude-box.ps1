# claude-box.ps1 — run Claude Code agents in isolated containers with
# detachable sessions and a slim/full toolchain choice.
#
# Invoke as `cb` or `claude-box` (both shims call this script).
#
# Usage:
#   cb [options] [-- claude args...]   launch agent(s) in new WT tab(s)
#   cb shell                           launch a bash session instead of claude
#   cb ls                              list all claude-box containers
#   cb attach [name-fragment]          reattach to a running (or stopped) agent
#                                      (opens in a new WT tab, like launching)
#   cb rm <name-fragment | all>        force-remove container(s)
#
# Options (case-insensitive; unique prefixes work too, e.g. -n, -m, -fu):
#   -full            use the full image (JDK 25 / pnpm / Chromium); default is slim
#   -rebuild         rebuild image(s) from scratch
#   -name foo        name the session: container becomes claude-box-<project>-foo,
#                    tab title + tmux status show foo, reattach via `cb attach foo`
#   -agents N        number of agent tabs to open (named foo-1, foo-2, ... with -name)
#   -mount p1,p2     extra directories to mount into /workspace
#   -frontend 4200   published frontend dev-server port (0 = none)
#   -hostip x.x.x.x  Windows host IP for backend forwarding (blank = auto)
#   -env "K=V"       extra environment variables
#
# Sessions are backed by tmux INSIDE the container. Closing the tab (or F12)
# detaches — the agent keeps running. Reattach any time with `cb attach`.
# When claude actually exits, the container is removed.
#
# In-session keys (F1 shows this list; WT tabs handle parallel sessions,
# tmux is panes-only):
#   F1 help | F2/F3 split right/down with claude (yolo) | F4 next pane
#   F5 zoom pane | F6 close pane (confirms) | F7 scrollback (q exits)
#   F8 split with plain shell | F9 paste Windows clipboard image | F12 detach

[CmdletBinding(PositionalBinding = $false)]
param(
    [switch]$Rebuild,
    [string]$Name = '',         # session name; shows up in container name, tab title and tmux status bar
    [int]$Agents = 1,
    [string[]]$Mount = @(),
    [int]$Frontend = 4200,      # frontend dev-server port in the container; published so you can open it on the host. Set 0 to disable.
    [string]$HostIp = '',       # Windows host IP the container forwards backends to; blank = auto-detect the WSL gateway
    [string[]]$Env = @(),       # extra env vars to pass in, e.g. -Env "FOO=bar"
    [switch]$Full,              # full image: slim + JDK 25 + pnpm + Chromium (default is the slim image)
    [switch]$InTab,   # internal: set when the script re-invokes itself inside a spawned tab
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$ErrorActionPreference = 'Continue'

# Slim is the default; -Full opts into the heavyweight image.
$Slim = -not $Full

# Sanitized session name: must be safe for docker container names AND tmux
# session names (tmux forbids ':' and '.').
$BoxName = $Name.Trim() -replace '[^A-Za-z0-9_-]', '-'

$ImageVersion  = '13'                   # bump to force auto-upgrade of stale images
$SlimImage     = 'claude-box:slim'
$FullImage     = 'claude-box:full'
$CredsVolume   = 'claude-box-creds'
$HomeVolume    = 'claude-box-home'      # persists ALL of /home/node (m2/pnpm caches, secrets, memory) across containers
$WorkspaceDir  = (Get-Location).Path

# Host services the container must reach at localhost:PORT (hard-coded).
$BackendPorts = @(
    '9980',   # Tomcat
    '8080'    # Keycloak
)

# --- find a container runtime --------------------------------------------------
$Docker = $null
foreach ($candidate in @('docker', 'nerdctl')) {
    if (Get-Command $candidate -ErrorAction SilentlyContinue) { $Docker = $candidate; break }
}
if (-not $Docker) {
    Write-Host "Error: neither 'docker' nor 'nerdctl' is on your PATH." -ForegroundColor Red
    Write-Host "Start Rancher Desktop and make sure its CLI tools are installed." -ForegroundColor Red
    exit 1
}

# Literal double quote inside docker --format templates: Windows PowerShell and
# pwsh <7.3 strip bare quotes when calling native exes, so they need \"; pwsh
# 7.3+ passes arguments verbatim, so a plain " is correct there.
$Q = if ($PSVersionTable.PSVersion -ge [version]'7.3.0' -and $PSNativeCommandArgumentPassing -ne 'Legacy') { '"' } else { '\"' }

# --- parse subcommand + entry + forwarded args --------------------------------
$Sub     = ''
$SubArgs = @()
if ($Args -and $Args.Count -gt 0 -and @('ls', 'attach', 'rm', 'shell') -contains $Args[0]) {
    $Sub     = $Args[0]
    $SubArgs = @($Args | Select-Object -Skip 1)
}

$Entry   = @('claude', '--dangerously-skip-permissions')
$Forward = @()
if ($Sub -eq 'shell') {
    $Entry   = @('bash')
    $Forward = $SubArgs
} elseif (-not $Sub -and $Args) {
    $Forward = $Args
}

# --- helpers -------------------------------------------------------------------
function Get-BoxContainers([string]$Pattern) {
    $lines = & $Docker ps -a --filter 'label=claude-box' --format "{{.Names}}|{{.State}}|{{.Label $($Q)claude-box.workspace$($Q)}}"
    $global:LASTEXITCODE = 0
    $found = @()
    foreach ($l in @($lines)) {
        if (-not "$l".Trim()) { continue }
        $parts = "$l" -split '\|', 3
        if ($Pattern -and ($parts[0] -notlike "*$Pattern*")) { continue }
        $found += [pscustomobject]@{
            Name      = $parts[0]
            State     = $parts[1]
            Workspace = if ($parts.Count -gt 2) { $parts[2] } else { '' }
        }
    }
    return ,$found
}

function Get-PortHolder([int]$Port) {
    # name of the RUNNING container publishing $Port on the host, or ''
    $lines = & $Docker ps --format '{{.Names}}|{{.Ports}}'
    $global:LASTEXITCODE = 0
    foreach ($l in @($lines)) {
        $parts = "$l" -split '\|', 2
        if ($parts.Count -gt 1 -and $parts[1] -match ":$Port->") { return $parts[0] }
    }
    return ''
}

function Test-PortBusy([int]$Port) {
    if (Get-PortHolder $Port) { return $true }
    try { return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) } catch { return $false }
}

function Show-DetachResult([string]$Name) {
    # After an attach/exec returns: either the user detached (container still
    # running) or claude exited (container stopped -> clean it up).
    $running = & $Docker inspect -f '{{.State.Running}}' $Name 2>$null
    $global:LASTEXITCODE = 0
    if ("$running".Trim() -eq 'true') {
        Write-Host ""
        Write-Host "==> Detached. '$Name' is still running." -ForegroundColor Cyan
        Write-Host "    Reattach : claude-box attach $Name" -ForegroundColor Cyan
        Write-Host "    Kill it  : claude-box rm $Name" -ForegroundColor Cyan
    } else {
        & $Docker rm $Name *> $null
        $global:LASTEXITCODE = 0
        Write-Host ""
        Write-Host "==> Session ended; container '$Name' removed." -ForegroundColor Cyan
    }
}

# --- subcommand: ls ------------------------------------------------------------
if ($Sub -eq 'ls') {
    & $Docker ps -a --filter 'label=claude-box' --format "table {{.Names}}\t{{.State}}\t{{.RunningFor}}\t{{.Label $($Q)claude-box.workspace$($Q)}}"
    exit 0
}

# --- subcommand: attach --------------------------------------------------------
if ($Sub -eq 'attach') {
    $pattern = if ($SubArgs.Count -gt 0) { $SubArgs[0] } else { '' }
    $found = Get-BoxContainers $pattern
    if ($found.Count -eq 0) {
        Write-Host "No claude-box containers match '$pattern'. Use 'claude-box ls'." -ForegroundColor Red
        exit 1
    }
    $target = $null
    $exact  = @($found | Where-Object { $_.Name -eq $pattern })
    if ($exact.Count -eq 1) {
        $target = $exact[0]
    } elseif ($found.Count -eq 1) {
        $target = $found[0]
    } else {
        $running = @($found | Where-Object { $_.State -eq 'running' })
        if ($running.Count -eq 1) {
            $target = $running[0]
        } else {
            Write-Host "Multiple matches — be more specific:" -ForegroundColor Yellow
            foreach ($c in $found) { Write-Host "  $($c.Name)  [$($c.State)]  $($c.Workspace)" }
            exit 1
        }
    }
    # Like launch: do the actual attach in a fresh Windows Terminal tab. The
    # tab re-invokes this script with -InTab and the exact container name.
    if (-not $InTab -and (Get-Command wt -ErrorAction SilentlyContinue)) {
        $psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
        $tabTitle = $target.Name -replace '^claude-box-', ''
        $escapedScript = $PSCommandPath -replace "'", "''"
        Write-Host "==> Attaching to $($target.Name) in a new Windows Terminal tab..." -ForegroundColor Cyan
        & wt -w 0 new-tab --title $tabTitle -d (Get-Location).Path `
            $psExe '-NoExit' '-Command' "& '$escapedScript' -InTab attach '$($target.Name)'"
        exit 0
    }
    if ($target.State -ne 'running') {
        Write-Host "==> Container is stopped; starting it (note: this launches a FRESH claude — use 'claude --continue' inside to resume)" -ForegroundColor Yellow
        & $Docker start $target.Name *> $null
        Start-Sleep -Seconds 1
    }
    Write-Host "==> Attaching to $($target.Name). Detach: F12. Key help: F1." -ForegroundColor Cyan
    & $Docker exec -it $target.Name tmux attach
    $global:LASTEXITCODE = 0
    Show-DetachResult $target.Name
    exit 0
}

# --- subcommand: rm ------------------------------------------------------------
if ($Sub -eq 'rm') {
    if ($SubArgs.Count -eq 0) {
        Write-Host "Usage: claude-box rm <name-fragment | all>" -ForegroundColor Red
        exit 1
    }
    if ($SubArgs[0] -eq 'all') {
        $ids = & $Docker ps -aq --filter 'label=claude-box'
        if ($ids) { & $Docker rm -f @($ids) } else { Write-Host "Nothing to remove." }
    } else {
        foreach ($pat in $SubArgs) {
            $found = Get-BoxContainers $pat
            if ($found.Count -eq 0) { Write-Host "No match for '$pat'." -ForegroundColor Yellow; continue }
            foreach ($c in $found) { & $Docker rm -f $c.Name }
        }
    }
    exit 0
}

# --- host IP detection (launch path only) -------------------------------------
# Where the container should forward backend ports. The backend runs on Windows,
# and in a WSL2 Docker engine "host.docker.internal" only reaches the Linux VM,
# not Windows. The address that DOES reach Windows is the WSL2 VM's default
# gateway. It's dynamic across reboots, so detect it each launch; -HostIp overrides.
$WindowsHostIp = $HostIp.Trim()
if (-not $WindowsHostIp) {
    try {
        $route = (wsl.exe -e sh -lc "ip route show default" 2>$null) -join "`n"
        $route = $route -replace "`0", ""   # wsl.exe output is sometimes UTF-16
        if ($route -match 'via\s+(\d{1,3}(?:\.\d{1,3}){3})') { $WindowsHostIp = $Matches[1] }
    } catch { }
    $global:LASTEXITCODE = 0
}
if (-not $WindowsHostIp) {
    try {
        $WindowsHostIp = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.InterfaceAlias -like 'vEthernet (WSL*' } |
            Select-Object -First 1 -ExpandProperty IPAddress
    } catch { }
}
$WindowsHostIp = "$WindowsHostIp".Trim()

# --- clipboard bridge ----------------------------------------------------------
# The container cannot see the Windows clipboard, so F9 in-session (clip-paste
# in the image) fetches the clipboard image from this tiny hidden listener on
# the WSL-facing interface: every TCP connect on 41417 is answered with the
# current clipboard image as PNG bytes (empty response if none). Idempotent -
# starts one bridge per boot, reused by all sessions.
$ClipPort = 41417
$ClipBridgeScript = @'
param([string]$BindIp = '0.0.0.0')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# The clipboard holds images in different shapes depending on the source app:
# bitmap data (screenshots), a file-drop list (Ctrl+C on a file in Explorer),
# or a PNG-only stream. Try them in order.
function Get-ClipboardImageBytes {
    try {
        $img = [System.Windows.Forms.Clipboard]::GetImage()
        if ($img) {
            $ms = New-Object System.IO.MemoryStream
            $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
            $img.Dispose()
            $bytes = $ms.ToArray()
            $ms.Dispose()
            return ,$bytes
        }
    } catch { }
    try {
        $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
        foreach ($f in $files) {
            if ($f -match '\.(png|jpe?g|gif|bmp|webp)$' -and (Test-Path -LiteralPath $f)) {
                return ,[System.IO.File]::ReadAllBytes($f)
            }
        }
    } catch { }
    try {
        $obj = [System.Windows.Forms.Clipboard]::GetDataObject()
        if ($obj -and $obj.GetDataPresent('PNG')) {
            $s = $obj.GetData('PNG')
            if ($s -is [System.IO.Stream]) {
                $ms = New-Object System.IO.MemoryStream
                $s.CopyTo($ms)
                $bytes = $ms.ToArray()
                $ms.Dispose()
                return ,$bytes
            }
        }
    } catch { }
    return $null
}

$listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Parse($BindIp), 41417)
$listener.Start()
while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
        $bytes = Get-ClipboardImageBytes
        if ($bytes) {
            $stream = $client.GetStream()
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush()
        }
    } catch { }
    $client.Close()
}
'@

function Start-ClipboardBridge([string]$BindIp) {
    $dir  = Join-Path $env:LOCALAPPDATA 'claude-box'
    $file = Join-Path $dir 'clipboard-bridge.ps1'
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }

    # If the on-disk bridge code is stale, kill the old bridge so the new code
    # actually takes over (the port probe alone would keep the old one forever).
    $current = if (Test-Path -LiteralPath $file) { [System.IO.File]::ReadAllText($file) } else { '' }
    if ($current.TrimEnd() -ne $ClipBridgeScript.TrimEnd()) {
        try {
            Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'clipboard-bridge\.ps1' } |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        } catch { }
        Set-Content -LiteralPath $file -Value $ClipBridgeScript -Encoding Ascii
    } else {
        $probe = New-Object System.Net.Sockets.TcpClient
        try { $probe.Connect($BindIp, $ClipPort); $probe.Close(); return } catch { }
        finally { $probe.Dispose() }
    }
    Start-Process powershell -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', "`"$file`"", $BindIp)
}

if ($WindowsHostIp) { Start-ClipboardBridge $WindowsHostIp }

# --- image build ---------------------------------------------------------------
# Two images:
#   claude-box:slim  = Node + Claude Code + socat/tmux plumbing  (builds in ~1-2 min)
#   claude-box:full  = slim + Temurin JDK 25 + pnpm + Playwright Chromium
# full is layered FROM slim, so slim is always built first and shared.
# Note: Node itself cannot be removed — Claude Code is a Node CLI.

function Test-ImageCurrent([string]$Name) {
    & $Docker image inspect $Name *> $null
    if ($LASTEXITCODE -ne 0) { $global:LASTEXITCODE = 0; return $false }
    $label = & $Docker image inspect $Name --format "{{ index .Config.Labels $($Q)claude-box.version$($Q) }}" 2>$null
    $global:LASTEXITCODE = 0
    return ("$label".Trim() -eq $ImageVersion)
}

$SlimDockerfile = @'
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl wget gnupg ca-certificates sudo less jq procps openssh-client socat \
        ripgrep tmux unzip xz-utils ncurses-term \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# host-forward: for each port in $HOST_FORWARD_PORTS, listen on the container's
# own localhost:PORT and relay to $HOST_FORWARD_TARGET:PORT, then exec the real
# command. Lets the app/tests keep calling localhost:PORT unchanged while
# actually reaching a backend on the host. No-op if HOST_FORWARD_PORTS is empty.
RUN printf '%s\n' \
        '#!/usr/bin/env bash' \
        'target="${HOST_FORWARD_TARGET:-host.docker.internal}"' \
        'if [ -n "$HOST_FORWARD_PORTS" ]; then' \
        '  for p in ${HOST_FORWARD_PORTS//,/ }; do' \
        '    echo "[claude-box] localhost:$p -> $target:$p" >&2' \
        '    socat "TCP-LISTEN:$p,fork,reuseaddr" "TCP:$target:$p" &' \
        '  done' \
        'fi' \
        'exec "$@"' \
        > /usr/local/bin/host-forward \
    && chmod +x /usr/local/bin/host-forward

# clip-paste (F9): fetch the Windows clipboard image from the host-side
# clipboard bridge (a TcpListener claude-box.ps1 starts on the Windows host,
# port 41417), save it to /tmp and type its path into the active pane so
# Claude Code picks it up as an image.
COPY <<'SCRIPT' /usr/local/bin/clip-paste
#!/bin/bash
host="${HOST_FORWARD_TARGET:-host.docker.internal}"
f="/tmp/clip-$(date +%s)"
if ! cat < "/dev/tcp/$host/41417" > "$f" 2>/dev/null || [ ! -s "$f" ]; then
    rm -f "$f"
    tmux display-message "no image on the Windows clipboard (or clipboard bridge not running)"
    exit 0
fi
magic=$(head -c 4 "$f" | od -An -tx1 | tr -d " \n")
case "$magic" in
    89504e47) ext=png ;;
    47494638) ext=gif ;;
    52494646) ext=webp ;;
    424d*)    ext=bmp ;;
    ffd8*)    ext=jpg ;;
    *)        ext=png ;;
esac
mv "$f" "$f.$ext"
tmux send-keys -l " $f.$ext "
SCRIPT

# the heredoc above inherits CRLF from the Windows-side script file - strip CRs
RUN sed -i 's/\r$//' /usr/local/bin/clip-paste && chmod +x /usr/local/bin/clip-paste

# F1 help popup: cheat sheet for the F-key bindings below
RUN printf '%s\n' \
        '#!/bin/bash' \
        'printf "\n  claude-box keys\n\n"' \
        'printf "  F1   this help\n"' \
        'printf "  F2   split: claude at the side\n"' \
        'printf "  F3   split: claude below\n"' \
        'printf "  F4   jump to next pane\n"' \
        'printf "  F5   zoom pane (again = restore)\n"' \
        'printf "  F6   close pane (asks y/n)\n"' \
        'printf "  F7   scrollback: arrows/PgUp, q exits\n"' \
        'printf "  F8   split: plain shell at the side\n"' \
        'printf "  F9   paste clipboard image from Windows\n"' \
        'printf "  F12  detach (agent keeps running)\n\n"' \
        'printf "  mouse: wheel scrolls, click picks pane\n"' \
        'printf "  claude/shell exiting closes its pane\n\n"' \
        'printf "  press any key to close"' \
        'read -rsn 1' \
        > /usr/local/bin/tmux-help \
    && chmod +x /usr/local/bin/tmux-help

# system-wide tmux config (NOT in /home/node — the home volume would hide it)
# The input chain (WT/conpty/docker) mangles Ctrl+modified keys once Claude
# Code switches keyboard protocols, so all core actions live on plain F-keys
# (which encode identically in every protocol). F10/F11 deliberately unused —
# Windows menus / WT fullscreen grab them. Ctrl+B prefix still works when the
# terminal is in legacy mode.
RUN printf '%s\n' \
        'set -g default-terminal "tmux-256color"' \
        'set -ga terminal-overrides ",xterm-256color:Tc"' \
        'set -s extended-keys on' \
        'set -as terminal-features ",xterm*:extkeys"' \
        'bind -n F1 display-popup -w 48 -h 16 -E tmux-help' \
        'bind -n F2 split-window -h -c "#{pane_current_path}" claude --dangerously-skip-permissions' \
        'bind -n F3 split-window -v -c "#{pane_current_path}" claude --dangerously-skip-permissions' \
        'bind -n F4 select-pane -t :.+' \
        'bind -n F5 resize-pane -Z' \
        'bind -n F6 confirm-before -p "close this pane? (y/n)" kill-pane' \
        'bind -n F7 copy-mode -u' \
        'bind -T copy-mode q send -X cancel' \
        'bind -T copy-mode F7 send -X cancel' \
        'bind -n F8 split-window -h -c "#{pane_current_path}"' \
        'bind -n F9 run-shell -b clip-paste' \
        'bind -n F12 detach-client' \
        'set -g mouse on' \
        'set -g history-limit 50000' \
        'set -g status-style "bg=colour24,fg=colour255"' \
        'set -g window-status-format ""' \
        'set -g window-status-current-format ""' \
        'set -g status-right " F1=help F7=scroll F12=detach "' \
        > /etc/tmux.conf

RUN echo "node ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers \
    && mkdir -p /home/node/.claude /workspace \
    && chown -R node:node /home/node /workspace

LABEL claude-box.version="13"
LABEL claude-box.variant="slim"

USER node
WORKDIR /workspace
ENV CLAUDE_CONFIG_DIR=/home/node/.claude
# UTF-8 locale: without it tmux runs in the POSIX C locale and mangles all
# box-drawing/Unicode output (broken TUI rendering)
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
CMD ["claude"]
'@

$FullDockerfile = @'
FROM claude-box:slim
USER root

# Temurin JDK 25 for ai.modeling (mvnw downloads Maven itself into ~/.m2)
RUN wget -qO- https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /usr/share/keyrings/adoptium.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb bookworm main" > /etc/apt/sources.list.d/adoptium.list \
    && apt-get update && apt-get install -y --no-install-recommends temurin-25-jdk \
    && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64

RUN npm install -g pnpm@11.5.2 playwright

# headless Chromium (+ its OS libs) for in-container browser testing; browsers
# live outside /home so the home volume never hides them
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN playwright install --with-deps chromium && chmod -R a+rX /opt/ms-playwright
ENV NODE_PATH=/usr/local/lib/node_modules

LABEL claude-box.version="13"
LABEL claude-box.variant="full"

USER node
'@

$ImageName = if ($Slim) { $SlimImage } else { $FullImage }

if ($Rebuild -or -not (Test-ImageCurrent $SlimImage)) {
    Write-Host "==> Building $SlimImage (fast, ~1-2 minutes)" -ForegroundColor Cyan
    $buildArgs = @('build', '-t', $SlimImage, '-f', '-')
    if ($Rebuild) { $buildArgs += @('--no-cache', '--pull') }
    $buildArgs += '.'
    $SlimDockerfile | & $Docker @buildArgs
    if ($LASTEXITCODE -ne 0) { Write-Host "docker build (slim) failed" -ForegroundColor Red; exit 1 }
}

if (-not $Slim -and ($Rebuild -or -not (Test-ImageCurrent $FullImage))) {
    Write-Host "==> Building $FullImage on top of slim (one-time, ~5-10 minutes)" -ForegroundColor Cyan
    $buildArgs = @('build', '-t', $FullImage, '-f', '-')
    if ($Rebuild) { $buildArgs += @('--no-cache') }   # no --pull: base is the local slim image
    $buildArgs += '.'
    $FullDockerfile | & $Docker @buildArgs
    if ($LASTEXITCODE -ne 0) { Write-Host "docker build (full) failed" -ForegroundColor Red; exit 1 }
}

# --- ensure volumes ------------------------------------------------------------
foreach ($vol in @($CredsVolume, $HomeVolume)) {
    & $Docker volume inspect $vol *> $null
    if ($LASTEXITCODE -ne 0) {
        & $Docker volume create $vol *> $null
    }
    $global:LASTEXITCODE = 0
}

# --- workspace hash + mount path ----------------------------------------------
# The hash keys the per-host-path shadow VOLUMES only; the in-container mount
# path uses the plain directory name so the agent sees /workspace/<real-name>.
# $UsedMountNames de-dupes when the workspace and an extra mount (or two extra
# mounts) share a leaf name — the later one falls back to <name>-<hash>.
$sha = [System.Security.Cryptography.SHA1]::Create()
$hashBytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($WorkspaceDir))
$Hash = -join ($hashBytes[0..3] | ForEach-Object { $_.ToString('x2') })
$ProjectName = (Split-Path $WorkspaceDir -Leaf) -replace '[^A-Za-z0-9._-]', '_'
$MountPath = "/workspace/$ProjectName"
$UsedMountNames = @($ProjectName)

# Shadow volumes: overlay container-local named volumes on top of build-output
# dirs (node_modules, .angular, target) so in-container installs/builds are fast
# and NEVER touch the Windows checkout. The volumes persist, so repeat installs
# are cache hits.
function Get-ShadowMounts([string]$HostDir, [string]$Target, [string]$VolPrefix) {
    $vols = @()
    if (Test-Path -LiteralPath (Join-Path $HostDir 'package.json')) {
        $vols += @('-v', "$VolPrefix-nm:$Target/node_modules")
        $vols += @('-v', "$VolPrefix-ngcache:$Target/.angular")
        if (Test-Path -LiteralPath (Join-Path $HostDir 'extensions\package.json')) {
            $vols += @('-v', "$VolPrefix-extnm:$Target/extensions/node_modules")
        }
    }
    if (Test-Path -LiteralPath (Join-Path $HostDir 'pom.xml')) {
        $vols += @('-v', "$VolPrefix-target:$Target/target")
    }
    return ,$vols
}

$ShadowMounts  = @()
$ShadowSummary = @()
$ws = Get-ShadowMounts $WorkspaceDir $MountPath "claude-box-$Hash"
if ($ws.Count -gt 0) {
    $ShadowMounts += $ws
    $ShadowSummary += (($ws | Where-Object { $_ -ne '-v' }) | ForEach-Object { ($_ -split ':', 2)[1] })
}

$ExtraMounts  = @()
$MountSummary = @()
foreach ($m in $Mount) {
    $resolved = (Resolve-Path -LiteralPath $m -ErrorAction Stop).Path
    $mName    = (Split-Path $resolved -Leaf) -replace '[^A-Za-z0-9._-]', '_'
    $mBytes   = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($resolved))
    $mHash    = -join ($mBytes[0..3] | ForEach-Object { $_.ToString('x2') })
    if ($UsedMountNames -contains $mName) { $mName = "$mName-$mHash" }
    $UsedMountNames += $mName
    $mTarget  = "/workspace/$mName"
    $ExtraMounts  += @('-v', "${resolved}:${mTarget}")
    $MountSummary += "$resolved  ->  $mTarget"
    $ms = Get-ShadowMounts $resolved $mTarget "claude-box-$mHash"
    if ($ms.Count -gt 0) {
        $ShadowMounts += $ms
        $ShadowSummary += (($ms | Where-Object { $_ -ne '-v' }) | ForEach-Object { ($_ -split ':', 2)[1] })
    }
}
$sha.Dispose()

# --- host access: how the container reaches services on the host --------------
if ($WindowsHostIp) {
    $HostAccess     = @("--add-host=host.docker.internal:$WindowsHostIp")
    $ForwardTarget  = $WindowsHostIp
} else {
    $HostAccess     = @('--add-host=host.docker.internal:host-gateway')
    $ForwardTarget  = 'host.docker.internal'
    Write-Host "Warning: could not detect the Windows host IP. The backend may be unreachable from the container." -ForegroundColor Yellow
    Write-Host "         Pass it explicitly, e.g. -HostIp 172.29.x.1 (WSL gateway) or your LAN IP from 'ipconfig'." -ForegroundColor Yellow
}

# --- publish the frontend dev server so you can open it on the host -----------
$PortArgs    = @()
$PortSummary = @()
if ($Frontend -gt 0) {
    if ($BackendPorts -contains "$Frontend") {
        Write-Host "Error: -Frontend $Frontend clashes with a hard-coded backend port ($($BackendPorts -join ', '))." -ForegroundColor Red
        Write-Host "       Pick a different port for the dev server." -ForegroundColor Red
        exit 1
    }
    # A detached/orphaned session (e.g. after Ctrl+C during launch) may still
    # hold the port - auto-bump to the next free one instead of failing.
    $freePort = 0
    for ($p = $Frontend; $p -lt $Frontend + 20; $p++) {
        if ($BackendPorts -contains "$p") { continue }
        if (-not (Test-PortBusy $p)) { $freePort = $p; break }
    }
    if ($freePort -eq 0) {
        Write-Host "Error: no free port in $Frontend-$($Frontend + 19) for the frontend dev server." -ForegroundColor Red
        Write-Host "       Check 'cb ls' for stale sessions, or pass -frontend <port> / -frontend 0." -ForegroundColor Red
        exit 1
    }
    if ($freePort -ne $Frontend) {
        $holder = Get-PortHolder $Frontend
        $why = if ($holder) { "held by running session '$holder'" } else { 'in use by another app' }
        Write-Host "Warning: port $Frontend is $why - using $freePort instead." -ForegroundColor Yellow
        if ($holder) { Write-Host "         (reattach it: cb attach $holder | remove it: cb rm $holder)" -ForegroundColor Yellow }
        $Frontend = $freePort
    }
    $PortArgs    += @('-p', "${Frontend}:${Frontend}")
    $PortSummary += "$Frontend"
    if ($Agents -gt 1) {
        Write-Host "Warning: with $Agents agents, only the first can bind host port $Frontend; the other frontends won't be reachable from the host." -ForegroundColor Yellow
    }
}

# --- environment variables to pass into the container -------------------------
$EnvArgs = @()
foreach ($e in $Env) { $EnvArgs += @('-e', $e) }
if ($Frontend -gt 0) { $EnvArgs += @('-e', "FRONTEND_PORT=$Frontend") }
if ($env:CAS_NEXUS_BASIC_AUTH_ENCODED) {
    $EnvArgs += @('-e', "CAS_NEXUS_BASIC_AUTH_ENCODED=$($env:CAS_NEXUS_BASIC_AUTH_ENCODED)")
}

# --- backend ports on the host, made reachable at localhost inside ------------
$joined          = ($BackendPorts -join ',')
$HostFwdEnv      = @('-e', "HOST_FORWARD_PORTS=$joined", '-e', "HOST_FORWARD_TARGET=$ForwardTarget")
$HostPortSummary = @()
foreach ($p in $BackendPorts) { $HostPortSummary += "localhost:$p -> ${ForwardTarget}:$p" }

# --- spawn a Windows Terminal tab per agent ------------------------------------
if (-not $InTab) {
    $haveWt = [bool](Get-Command wt -ErrorAction SilentlyContinue)

    if ($haveWt) {
        $psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }

        $agentWord = if ($Agents -eq 1) { 'agent' } else { 'agents' }
        $tabWord   = if ($Agents -eq 1) { 'tab' }   else { 'tabs' }
        Write-Host "==> Launching $Agents Claude $agentWord in new Windows Terminal $tabWord..." -ForegroundColor Cyan
        Write-Host "==> Image     : $ImageName" -ForegroundColor Green
        Write-Host "==> Workspace : $WorkspaceDir  ->  $MountPath" -ForegroundColor Green
        foreach ($line in $MountSummary)    { Write-Host "==> Extra     : $line" -ForegroundColor Green }
        foreach ($line in $ShadowSummary)   { Write-Host "==> Isolated  : $line (container-local, never written to Windows)" -ForegroundColor Green }
        foreach ($line in $PortSummary)     { Write-Host "==> Frontend  : container:$line -> open http://localhost:$line on the host" -ForegroundColor Green }
        foreach ($line in $HostPortSummary) { Write-Host "==> Backend   : $line (frontend/tests use localhost:PORT unchanged)" -ForegroundColor Green }
        if ($WindowsHostIp) {
            $ipNote = if ($HostIp.Trim()) { 'from -HostIp' } else { 'auto-detected WSL gateway' }
            Write-Host "==> Win host  : $WindowsHostIp ($ipNote)" -ForegroundColor Green
        }
        Write-Host "==> Creds vol : $CredsVolume (shared)" -ForegroundColor Green
        Write-Host "==> Home vol  : $HomeVolume (persistent /home/node)" -ForegroundColor Green
        Write-Host ""

        # Re-quote forwarded args so each tab receives them intact
        $forwardArgs = ''
        foreach ($a in $Args) {
            $escaped = $a -replace "'", "''"
            $forwardArgs += " '$escaped'"
        }

        $mountArgs = ''
        if ($Mount.Count -gt 0) {
            $quoted = ($Mount | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ','
            $mountArgs = " -Mount $quoted"
        }

        $envArgs = ''
        if ($Env.Count -gt 0) {
            $quoted = ($Env | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ','
            $envArgs = " -Env $quoted"
        }

        $escapedScript = $PSCommandPath -replace "'", "''"
        $hostIpArg = if ($WindowsHostIp) { " -HostIp '$WindowsHostIp'" } else { '' }
        $fullArg   = if ($Full) { ' -Full' } else { '' }
        $commonArgs = "$mountArgs$envArgs$hostIpArg$fullArg$forwardArgs"

        # Only the first agent publishes the frontend port; the rest run headless
        # so their containers don't collide on the same host port.
        $wtArgs = @()
        for ($i = 1; $i -le $Agents; $i++) {
            $fePort = if ($i -eq 1) { $Frontend } else { 0 }
            $tabName = if ($BoxName -and $Agents -gt 1) { "$BoxName-$i" }
                       elseif ($BoxName)                { $BoxName }
                       else                             { '' }
            $nameArg  = if ($tabName) { " -Name '$tabName'" } else { '' }
            $tabTitle = if ($tabName) { $tabName } else { "$ProjectName-$i" }
            $innerCmd = "& '$escapedScript' -InTab -Agents 1 -Frontend $fePort$nameArg$commonArgs"
            if ($i -gt 1) { $wtArgs += ';' }
            $wtArgs += @(
                'new-tab',
                '--title', $tabTitle,
                '-d',      $WorkspaceDir,
                $psExe,    '-NoExit', '-Command', $innerCmd
            )
        }

        & wt -w 0 @wtArgs
        exit 0
    }
    elseif ($Agents -gt 1) {
        Write-Host "Error: wt.exe (Windows Terminal) not found on PATH." -ForegroundColor Red
        Write-Host "Install Windows Terminal to use -Agents > 1." -ForegroundColor Red
        exit 1
    }
    else {
        Write-Host "==> Windows Terminal (wt.exe) not found; running in this window instead." -ForegroundColor Yellow
    }
}

# --- run the container detached, then attach to its tmux session ---------------
# With -Name the container name is deterministic (so `attach <name>` finds it);
# without it a random suffix keeps parallel unnamed sessions from clashing.
if ($BoxName) {
    $ContainerName = "claude-box-$ProjectName-$BoxName"
    $SessionName   = $BoxName
    & $Docker container inspect $ContainerName *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Error: a session named '$BoxName' already exists for this project." -ForegroundColor Red
        Write-Host "       Reattach : claude-box attach $BoxName" -ForegroundColor Red
        Write-Host "       Remove   : claude-box rm $BoxName" -ForegroundColor Red
        exit 1
    }
    $global:LASTEXITCODE = 0
} else {
    $Suffix = [guid]::NewGuid().ToString('N').Substring(0, 6)
    $ContainerName = "claude-box-$ProjectName-$Suffix"
    $SessionName   = 'main'
}

Write-Host "==> Image     : $ImageName" -ForegroundColor Green
Write-Host "==> Workspace : $WorkspaceDir  ->  $MountPath" -ForegroundColor Green
foreach ($line in $MountSummary)    { Write-Host "==> Extra     : $line" -ForegroundColor Green }
foreach ($line in $ShadowSummary)   { Write-Host "==> Isolated  : $line (container-local, never written to Windows)" -ForegroundColor Green }
foreach ($line in $PortSummary)     { Write-Host "==> Frontend  : container:$line -> open http://localhost:$line on the host" -ForegroundColor Green }
foreach ($line in $HostPortSummary) { Write-Host "==> Backend   : $line (frontend/tests use localhost:PORT unchanged)" -ForegroundColor Green }
if ($WindowsHostIp) {
    $ipNote = if ($HostIp.Trim()) { 'from -HostIp' } else { 'auto-detected WSL gateway' }
    Write-Host "==> Win host  : $WindowsHostIp ($ipNote)" -ForegroundColor Green
}
Write-Host "==> Creds vol : $CredsVolume (shared - sign in once, stay signed in)" -ForegroundColor Green
Write-Host "==> Home vol  : $HomeVolume (persistent /home/node: caches, secrets, memory)" -ForegroundColor Green
Write-Host "==> Container : $ContainerName" -ForegroundColor Green
Write-Host "==> Permissions: skipped (container is isolated)" -ForegroundColor Yellow
Write-Host "==> Session   : tmux-backed. F12 (or closing this tab) DETACHES - agent keeps running. F1 = key help." -ForegroundColor Yellow
Write-Host "==> Clipboard : copy an image on Windows, press F9 here to paste it into claude." -ForegroundColor Yellow
Write-Host ""

# PID 1 is tmux running the agent: when the agent exits, tmux exits, the
# container stops (and we remove it below). Detaching/closing the tab only
# kills the `docker exec` client — tmux and the agent keep running.
& $Docker run -dt `
    --name $ContainerName `
    --label 'claude-box=1' `
    --label "claude-box.workspace=$WorkspaceDir" `
    -e COLORTERM=truecolor `
    -e TERM=xterm-256color `
    @HostAccess `
    @PortArgs `
    @EnvArgs `
    @HostFwdEnv `
    -v "${HomeVolume}:/home/node" `
    -v "${CredsVolume}:/home/node/.claude" `
    -v "${WorkspaceDir}:${MountPath}" `
    @ExtraMounts `
    @ShadowMounts `
    -w /workspace `
    $ImageName `
    host-forward tmux new-session -s $SessionName @Entry @Forward | Out-Null

if ($LASTEXITCODE -ne 0) {
    # docker run can leave a half-created container behind (e.g. port bind
    # failure after the container object exists) - clean it up so retries
    # and named sessions don't collide with the corpse.
    & $Docker rm -f $ContainerName *> $null
    $global:LASTEXITCODE = 0
    Write-Host "docker run failed" -ForegroundColor Red
    Write-Host "If the error mentions an already-allocated port, a detached session is holding it - see 'cb ls'." -ForegroundColor Yellow
    exit 1
}

# wait for the tmux session to come up before attaching (avoids a startup race)
for ($try = 0; $try -lt 20; $try++) {
    & $Docker exec $ContainerName tmux has-session *> $null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Milliseconds 250
}
$global:LASTEXITCODE = 0

& $Docker exec -it $ContainerName tmux attach
$global:LASTEXITCODE = 0
Show-DetachResult $ContainerName