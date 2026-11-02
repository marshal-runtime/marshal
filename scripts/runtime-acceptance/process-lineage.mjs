export function buildCaptureDescendantsScript(rootPid) {
  if (!Number.isInteger(rootPid)) throw new TypeError("rootPid must be an integer");
  return [
    "$ErrorActionPreference = 'Stop'",
    "$all = Get-CimInstance Win32_Process",
    `$rootPid = ${rootPid}`,
    "$root = $all | Where-Object { $_.ProcessId -eq $rootPid } | Select-Object -First 1",
    "$rootCreationDate = if ($null -eq $root) { $null } else { $root.CreationDate }",
    "$queue = New-Object System.Collections.Generic.Queue[int]",
    "$queue.Enqueue($rootPid)",
    "$depth = @{ $rootPid = 0 }",
    "$result = @()",
    "while ($queue.Count -gt 0) {",
    "  $current = $queue.Dequeue()",
    "  $process = $all | Where-Object { $_.ProcessId -eq $current } | Select-Object -First 1",
    "  if ($null -ne $process) {",
    "    $commandLine = [string]$process.CommandLine",
    "    $role = if ($current -eq $rootPid) { 'main' } elseif ($commandLine -match '--type=renderer') { 'renderer' } elseif ($commandLine -match '--type=gpu-process') { 'gpu' } elseif ($commandLine -match '--type=utility') { 'utility' } elseif ([string]$process.ExecutablePath -match 'copilot') { 'backend' } elseif ([string]$process.ExecutablePath -match 'node-runner') { 'backend-launcher' } else { 'child' }",
    "    $result += [pscustomobject]@{",
    "      pid = [int]$process.ProcessId",
    "      parentPid = [int]$process.ParentProcessId",
    "      depth = [int]$depth[$current]",
    "      role = $role",
    "      executablePath = [string]$process.ExecutablePath",
    "      creationDate = if ($null -eq $process.CreationDate) { $null } else { $process.CreationDate.ToString('o') }",
    "    }",
    "  }",
    "  foreach ($child in ($all | Where-Object { $_.ParentProcessId -eq $current -and ($null -eq $rootCreationDate -or $_.CreationDate -ge $rootCreationDate) })) {",
    "    if (-not $depth.ContainsKey([int]$child.ProcessId)) {",
    "      $depth[[int]$child.ProcessId] = [int]$depth[$current] + 1",
    "      $queue.Enqueue([int]$child.ProcessId)",
    "    }",
    "  }",
    "}",
    "$result | ConvertTo-Json -Compress -Depth 3",
  ].join("\n");
}

export function buildQueryProcessScript(pid) {
  if (!Number.isInteger(pid)) throw new TypeError("pid must be an integer");
  return [
    `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
    "if ($null -ne $process) {",
    "  [pscustomobject]@{",
    "    executablePath = [string]$process.ExecutablePath",
    "    creationDate = if ($null -eq $process.CreationDate) { $null } else { $process.CreationDate.ToString('o') }",
    "  } | ConvertTo-Json -Compress",
    "}",
  ].join("\n");
}
