$ErrorActionPreference = 'Continue'

$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $root 'server.js'
$log    = Join-Path $root 'service.log'
$port   = 4999

# 优先用 PATH 里的 node；没有再退回常见安装位置。
$node = 'node'
$c = Get-Command node -ErrorAction SilentlyContinue
if ($c) { $node = $c.Source }
elseif (Test-Path 'C:\Program Files\nodejs\node.exe') { $node = 'C:\Program Files\nodejs\node.exe' }

function Write-Log([string]$msg) {
    $line = '{0}  {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $msg
    try { Add-Content -Path $log -Value $line -Encoding UTF8 } catch {}
}

# Single instance: the 5-minute health check re-runs this script.
$needle = '-File "' + $MyInvocation.MyCommand.Path + '"'
$others = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($needle) })
if ($others.Count -gt 0) { exit 0 }

function Test-Port([int]$p) {
    try { return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop) }
    catch { return $false }
}

Write-Log 'supervisor: starting'
$backoff = 5

while ($true) {
    if (-not (Test-Port $port)) {
        Write-Log 'supervisor: port down, launching PortDeck'
        try {
            $p = Start-Process -FilePath $node -ArgumentList @($script) -PassThru -WindowStyle Hidden
            $p.WaitForExit()
            Write-Log ('supervisor: exited code={0}' -f $p.ExitCode)
        } catch {
            Write-Log ('supervisor: launch failed: ' + $_.Exception.Message)
        }
        $backoff = [Math]::Min(60, $backoff * 2)
        Start-Sleep -Seconds $backoff
    } else {
        $backoff = 5
        Start-Sleep -Seconds 5
    }
}
