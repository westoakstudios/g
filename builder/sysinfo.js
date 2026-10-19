// language: JavaScript, file: builder/sysinfo.js
// samples cpu/gpu/ram + top processes on a client via PowerShell.
// reuses /api/clients/:id/exec pipeline. inflight map prevents pileup.

import db from '../db.js';

const sql = (strings, ...vals) => {
  if (vals.length) throw new Error('sql tagged template refused — use ? params');
  return strings[0];
};

const SCRIPT = `
$ErrorActionPreference='SilentlyContinue';$ProgressPreference='SilentlyContinue'
try{$cores=(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors}catch{$cores=[int]$env:NUMBER_OF_PROCESSORS}
if(-not $cores -or $cores -lt 1){$cores=1}
$sw=[System.Diagnostics.Stopwatch]::StartNew()
$p1=@{};foreach($p in Get-Process){if($p.Id -gt 0){$p1[$p.Id]=$p.CPU}}
$paths=@('\\Processor(_Total)\\% Processor Time')
$gpuPerf=$false
try{Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -MaxSamples 1 -SampleInterval 1 -EA Stop|Out-Null;$paths+='\\GPU Engine(*engtype_3D)\\Utilization Percentage';$gpuPerf=$true}catch{}
$c=Get-Counter -Counter $paths -SampleInterval 1 -MaxSamples 2 -EA SilentlyContinue
$el=$sw.Elapsed.TotalSeconds
$p2=@{};foreach($p in Get-Process){if($p.Id -gt 0){$p2[$p.Id]=@{cpu=$p.CPU;ram=$p.WorkingSet64;name=$p.ProcessName}}}
$cpu=0;$gpu=$null
if($c -and $c.Count -ge 2){$last=$c[-1];foreach($s in $last.CounterSamples){if($s.Path -match '% Processor Time'){$cpu=[math]::Round($s.CookedValue,1)}elseif($s.Path -match 'engtype_3D'){if($null -eq $gpu){$gpu=0};$gpu+=$s.CookedValue}};if($null -ne $gpu){$gpu=[math]::Round($gpu,1)}}
if(-not $cpu){try{$cpu=[math]::Round((Get-CimInstance Win32_Processor|Measure-Object LoadPercentage -Average).Average,1)}catch{}}
$gpuObj=$null;$nv='C:\\Windows\\System32\\nvidia-smi.exe'
if(Test-Path $nv){try{$ln=(& $nv --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>$null|Select-Object -First 1);if($ln){$pt=$ln -split ',\\s*';if($pt.Count -ge 3){$gpuObj=[PSCustomObject]@{util=[int]$pt[0];mem_used_mb=[int]$pt[1];mem_total_mb=[int]$pt[2];source='nvidia-smi'}}}}catch{}}
if(-not $gpuObj -and $null -ne $gpu){$gpuObj=[PSCustomObject]@{util=$gpu;mem_used_mb=$null;mem_total_mb=$null;source='perf-counter'}}
try{$os=Get-CimInstance Win32_OperatingSystem;$ramTotal=[math]::Round($os.TotalVisibleMemorySize/1024,0);$ramFree=[math]::Round($os.FreePhysicalMemory/1024,0);$ramUsed=$ramTotal-$ramFree;$ramPercent=if($ramTotal -gt 0){[math]::Round(($ramUsed/$ramTotal)*100,1)}else{0}}catch{$ramTotal=0;$ramUsed=0;$ramPercent=0}
$procs=@()
foreach($pid in $p2.Keys){$cur=$p2[$pid];$ram=[math]::Round($cur.ram/1MB,1);$cs=if($cur.cpu){[math]::Round($cur.cpu,1)}else{0};$cp=$null;if($p1.ContainsKey($pid) -and $null -ne $cur.cpu -and $null -ne $p1[$pid]){$d=$cur.cpu-$p1[$pid];if($d -ge 0 -and $el -gt 0){$cp=[math]::Round(($d/$el)/$cores*100,1);if($cp -gt 100){$cp=100}}};$procs+=[PSCustomObject]@{name=$cur.name;pid=$pid;ram_mb=$ram;cpu_s=$cs;cpu_pct=$cp}}
$procs=$procs|Sort-Object -Property @{Expression='ram_mb';Descending=$true}|Select-Object -First 50
[PSCustomObject]@{ok=$true;ts=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();cores=$cores;cpu=$cpu;gpu=$gpuObj;ram=[PSCustomObject]@{used_mb=$ramUsed;total_mb=$ramTotal;percent=$ramPercent};procs=$procs}|ConvertTo-Json -Compress -Depth 6
`;

const B64 = Buffer.from(SCRIPT, 'utf16le').toString('base64');
const LINE = `powershell -NoProfile -NonInteractive -EncodedCommand ${B64} 2>$null`;
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
  // strip BOM, stderr prelude, anything before the first '{' and after the last '}'
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { ok: false, error: 'no json in output', raw: raw.slice(0, 300) };
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    return { ok: false, error: `bad json: ${e.message}`, raw: raw.slice(start, Math.min(start + 300, end + 1)) };
  }
}