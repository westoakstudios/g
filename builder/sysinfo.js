// language: JavaScript, file: builder/sysinfo.js
import db from '../db.js';

const sql = (strings, ...vals) => {
  if (vals.length) throw new Error('sql tagged template refused — use ? params');
  return strings[0];
};

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$cores = [Environment]::ProcessorCount
if (-not $cores) { $cores = 1 }

# RAM (WMI - language agnostic)
$os = Get-CimInstance Win32_OperatingSystem
$ramTotal = [math]::Round($os.TotalVisibleMemorySize / 1024, 0)
$ramFree = [math]::Round($os.FreePhysicalMemory / 1024, 0)
$ramUsed = $ramTotal - $ramFree
$ramPercent = if ($ramTotal -gt 0) { [math]::Round(($ramUsed / $ramTotal) * 100, 1) } else { 0 }

# CPU (WMI - language agnostic)
$cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor | Where-Object { $_.Name -eq '_Total' }).PercentProcessorTime
if ($null -eq $cpu) { $cpu = 0 }

# GPU (nvidia-smi fallback)
$gpuObj = $null
$nv = 'C:\\Windows\\System32\\nvidia-smi.exe'
if (Test-Path $nv) {
    try {
        $ln = (& $nv --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>nul | Select-Object -First 1)
        if ($ln) {
            $pt = $ln -split ',\\s*'
            if ($pt.Count -ge 3) {
                $gpuObj = [PSCustomObject]@{ util = [int]$pt[0]; mem_used_mb = [int]$pt[1]; mem_total_mb = [int]$pt[2]; source = 'nvidia-smi' }
            }
        }
    } catch {}
}

# Processes
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$p1 = @{}
foreach ($p in Get-Process) { if ($p.Id -gt 0) { $p1[$p.Id] = $p.CPU } }
Start-Sleep -Milliseconds 500
$el = $sw.Elapsed.TotalSeconds
$procs = @()

foreach ($p in Get-Process) {
    if ($p.Id -le 0) { continue }
    $procId = $p.Id
    $ram = [math]::Round($p.WorkingSet64 / 1MB, 1)
    $cs = if ($p.CPU) { [math]::Round($p.CPU, 1) } else { 0 }
    $cp = $null
    if ($p1.ContainsKey($procId) -and $null -ne $p.CPU -and $null -ne $p1[$procId]) {
        $d = $p.CPU - $p1[$procId]
        if ($d -ge 0 -and $el -gt 0) {
            $cp = [math]::Round(($d / $el) / $cores * 100, 1)
            if ($cp -gt 100) { $cp = 100 }
        }
    }
    $procs += [PSCustomObject]@{ name = $p.ProcessName; pid = $procId; ram_mb = $ram; cpu_s = $cs; cpu_pct = $cp }
}

$procs = @($procs | Sort-Object -Property @{Expression='ram_mb';Descending=$true} | Select-Object -First 200)

$out = [PSCustomObject]@{
    ok = $true
    ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    cores = $cores
    cpu = $cpu
    gpu = $gpuObj
    ram = [PSCustomObject]@{ used_mb = $ramUsed; total_mb = $ramTotal; percent = $ramPercent }
    procs = $procs
}

Write-Output "__JSON_START__"
$out | ConvertTo-Json -Compress -Depth 10
Write-Output "__JSON_END__"
`;

const B64 = Buffer.from(SCRIPT, 'utf16le').toString('base64');
const LINE = `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${B64} 2>nul`;
const EXEC_TIMEOUT_MS = 20_000;
const CACHE_MS = 2000;

const inflight = new Map();
const cache = new Map();

export async function runSysinfo(clientId, userId) {
  const hit = cache.get(clientId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  if (inflight.has(clientId)) return inflight.get(clientId);

  const p = doSysinfo(clientId, userId)
    .then(data => {
      cache.set(clientId, { at: Date.now(), data });
      inflight.delete(clientId);
      return data;
    })
    .catch(err => {
      inflight.delete(clientId);
      throw err;
    });

  inflight.set(clientId, p);
  return p;
}

async function doSysinfo(clientId, userId) {
  const info = db.prepare(sql`
    INSERT INTO commands (user_id, client_id, shell, line, status, created_at)
    VALUES (?, ?, 'cmd', ?, 'pending', ?)
  `).run(userId, clientId, LINE, Date.now());

  const cmdId = Number(info.lastInsertRowid);
  const deadline = Date.now() + EXEC_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
    const row = db.prepare(sql`SELECT output, status FROM commands WHERE id = ?`).get(cmdId);
    if (!row) continue;
    if (row.status === 'done') {
      return parseOutput(row.output || '');
    }
  }
  return { ok: false, error: 'timeout — client did not respond within 20s' };
}

function parseOutput(raw) {
  if (!raw) return { ok: false, error: 'empty output' };
  const startMark = '__JSON_START__';
  const endMark = '__JSON_END__';

  if (raw.includes(startMark) && raw.includes(endMark)) {
     raw = raw.slice(raw.indexOf(startMark) + startMark.length, raw.lastIndexOf(endMark)).trim();
  } else {
     if (raw.includes('[stderr]')) raw = raw.split('[stderr]')[0];
     const start = raw.indexOf('{');
     const end = raw.lastIndexOf('}');
     if (start < 0 || end <= start) {
       return { ok: false, error: 'no json in output', raw: raw.slice(0, 2000) }; // expanded error slice
     }
     raw = raw.slice(start, end + 1);
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `bad json: ${e.message}`, raw: raw.slice(0, 2000) };
  }
}