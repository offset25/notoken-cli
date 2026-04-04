const fs = require("fs");
const path = require("path");

const intentsPath = path.resolve(__dirname, "../config/intents.json");
const data = JSON.parse(fs.readFileSync(intentsPath, "utf-8"));

const windowsCommands = {
  "server.uptime": `powershell -Command "$os = Get-CimInstance Win32_OperatingSystem; $boot = $os.LastBootUpTime; $up = (Get-Date) - $boot; Write-Host ('Up {0} days, {1} hours, {2} minutes' -f $up.Days, $up.Hours, $up.Minutes); Write-Host ('Boot: ' + $boot); Write-Host ''; Write-Host ('CPUs: ' + (Get-CimInstance Win32_Processor).NumberOfLogicalProcessors); Write-Host ''; $m = Get-CimInstance Win32_OperatingSystem; Write-Host ('Memory: {0:N1} GB total, {1:N1} GB free, {2}% used' -f ($m.TotalVisibleMemorySize/1MB), ($m.FreePhysicalMemory/1MB), [math]::Round(($m.TotalVisibleMemorySize-$m.FreePhysicalMemory)/$m.TotalVisibleMemorySize*100)); Write-Host ''; Write-Host '=== Top Processes (CPU) ==='; Get-Process | Sort-Object CPU -Descending | Select-Object -First 8 Name,Id,@{N='CPU';E={[math]::Round($_.CPU,1)}},@{N='MB';E={[math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize"`,

  "monitor.process": `powershell -Command "Write-Host '=== Top by CPU ==='; Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name,Id,@{N='CPU(s)';E={[math]::Round($_.CPU,1)}},@{N='Mem(MB)';E={[math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize; Write-Host ''; Write-Host '=== Top by Memory ==='; Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 Name,Id,@{N='Mem(MB)';E={[math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize"`,

  "system.kernel": `powershell -Command "$os = Get-CimInstance Win32_OperatingSystem; Write-Host ('OS: ' + $os.Caption); Write-Host ('Version: ' + $os.Version); Write-Host ('Build: ' + $os.BuildNumber); Write-Host ('Arch: ' + $os.OSArchitecture); Write-Host ('Computer: ' + $env:COMPUTERNAME)"`,

  "system.resource_summary": `powershell -Command "Write-Host '=== System ==='; hostname; Write-Host ''; Write-Host '=== CPU ==='; $cpu = Get-CimInstance Win32_Processor; Write-Host $cpu.Name; Write-Host ('Cores: ' + $cpu.NumberOfLogicalProcessors); Write-Host ''; Write-Host '=== Memory ==='; $m = Get-CimInstance Win32_OperatingSystem; Write-Host ('Total: {0:N1} GB' -f ($m.TotalVisibleMemorySize/1MB)); Write-Host ('Free: {0:N1} GB' -f ($m.FreePhysicalMemory/1MB)); Write-Host ('Used: {0}%' -f [math]::Round(($m.TotalVisibleMemorySize-$m.FreePhysicalMemory)/$m.TotalVisibleMemorySize*100)); Write-Host ''; Write-Host '=== Disk ==='; Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { '{0} {1:N1}GB free of {2:N1}GB ({3}%)' -f $_.DeviceID,($_.FreeSpace/1GB),($_.Size/1GB),[math]::Round(($_.Size-$_.FreeSpace)/$_.Size*100) }; Write-Host ''; Write-Host '=== Top Processes ==='; Get-Process | Sort-Object CPU -Descending | Select-Object -First 6 Name,@{N='CPU';E={[math]::Round($_.CPU,1)}},@{N='MB';E={[math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize"`,

  "hardware.info": `powershell -Command "Write-Host '=== CPU ==='; $cpu = Get-CimInstance Win32_Processor; Write-Host ('Name: ' + $cpu.Name); Write-Host ('Cores: ' + $cpu.NumberOfCores + ' (' + $cpu.NumberOfLogicalProcessors + ' logical)'); Write-Host ('Max Clock: ' + $cpu.MaxClockSpeed + ' MHz'); Write-Host ''; Write-Host '=== Memory ==='; $m = Get-CimInstance Win32_OperatingSystem; Write-Host ('{0:N1} GB total' -f ($m.TotalVisibleMemorySize/1MB)); Write-Host ''; Write-Host '=== Storage ==='; Get-CimInstance Win32_DiskDrive | ForEach-Object { Write-Host ('{0} - {1:N0} GB' -f $_.Caption, ($_.Size/1GB)) }; Write-Host ''; Write-Host '=== GPU ==='; Get-CimInstance Win32_VideoController | ForEach-Object { Write-Host ('{0} ({1:N0} MB)' -f $_.Name, ($_.AdapterRAM/1MB)) }"`,

  "monitor.disk_alert": `powershell -Command "Write-Host '=== Disk Usage Check ==='; Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $pct=[math]::Round(($_.Size-$_.FreeSpace)/$_.Size*100); if($pct -ge {{threshold}}) { Write-Host ('WARNING: {0} {1}% used ({2:N1}GB free of {3:N1}GB)' -f $_.DeviceID,$pct,($_.FreeSpace/1GB),($_.Size/1GB)) } }; Write-Host ''; Write-Host '=== All Drives ==='; Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { '{0} {1:N1}GB free of {2:N1}GB ({3}%)' -f $_.DeviceID,($_.FreeSpace/1GB),($_.Size/1GB),[math]::Round(($_.Size-$_.FreeSpace)/$_.Size*100) }"`,

  "network.bandwidth": `powershell -Command "Write-Host '=== Network Adapters ==='; Get-NetAdapter | Where-Object Status -eq 'Up' | Format-Table Name, Status, LinkSpeed, @{N='Received(MB)';E={[math]::Round((Get-NetAdapterStatistics -Name $_.Name).ReceivedBytes/1MB)}}, @{N='Sent(MB)';E={[math]::Round((Get-NetAdapterStatistics -Name $_.Name).SentBytes/1MB)}} -AutoSize"`,

  "ollama.status": `powershell -Command "$p = Get-Process ollama -ErrorAction SilentlyContinue; if($p) { Write-Host 'Ollama is running (PID:' $p.Id ')'; ollama --version } else { $wsl = wsl ollama --version 2>&1; if($LASTEXITCODE -eq 0) { Write-Host 'Ollama (WSL):' $wsl; Write-Host 'Running in WSL' } else { Write-Host 'Ollama is not running' } }"`,

  "claude.status": `powershell -Command "$v = claude --version 2>&1; if($LASTEXITCODE -eq 0) { Write-Host 'Claude:' $v } else { $wsl = wsl claude --version 2>&1; if($LASTEXITCODE -eq 0) { Write-Host 'Claude (WSL):' $wsl } else { Write-Host 'Claude Code not installed' } }"`,

  "codex.status": `powershell -Command "$v = codex --version 2>&1; if($LASTEXITCODE -eq 0) { Write-Host 'Codex:' $v } else { $wsl = wsl codex --version 2>&1; if($LASTEXITCODE -eq 0) { Write-Host 'Codex (WSL):' $wsl } else { Write-Host 'Codex CLI not installed' } }"`,

  "openclaw.status": `powershell -Command "$v = openclaw --version 2>&1; if($LASTEXITCODE -eq 0) { Write-Host 'OpenClaw:' $v } else { $wsl = wsl openclaw --version 2>&1; if($LASTEXITCODE -eq 0) { Write-Host 'OpenClaw (WSL):' $wsl } else { Write-Host 'OpenClaw not installed' } }"`,
};

let changed = 0;
for (const intent of data.intents) {
  if (windowsCommands[intent.name] && !intent.commandWindows) {
    intent.commandWindows = windowsCommands[intent.name];
    changed++;
  }
}

fs.writeFileSync(intentsPath, JSON.stringify(data, null, 2) + "\n");
console.log(`Updated ${changed} intents with commandWindows`);
