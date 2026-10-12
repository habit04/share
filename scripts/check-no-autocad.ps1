# Read-only inventory gate for the fresh Windows runner before installed shipping probes.
param([string]$EvidencePath = 'packaged-smoke-output/no-autocad-inventory.json')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'The AutoCAD absence inventory requires Windows.'
}
$sourceSha = [Environment]::GetEnvironmentVariable('SOURCE_SHA')
if ($sourceSha -cnotmatch '^[a-f0-9]{40}$') { throw 'The AutoCAD absence inventory requires a lowercase 40-character SOURCE_SHA.' }

$findings = [Collections.Generic.List[string]]::new()
$uninstallEntries = 0
$classEntries = 0
$views = @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)
foreach ($hive in @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryHive]::CurrentUser)) {
    foreach ($view in $views) {
        $root = $null
        $key = $null
        try {
            $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
            $key = $root.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
            if ($null -ne $key) {
                foreach ($name in $key.GetSubKeyNames()) {
                    $entry = $key.OpenSubKey($name)
                    if ($null -eq $entry) { throw 'An uninstall registry entry disappeared during inventory.' }
                    try {
                        $display = [string]$entry.GetValue('DisplayName')
                        $uninstallEntries++
                        if ($display -match 'AutoCAD' -or $name -match 'AutoCAD') {
                            $findings.Add("uninstall $hive/$view`: $($display -replace '[\r\n\t]', ' ')")
                        }
                    } finally { $entry.Dispose() }
                }
            }
        } finally {
            if ($null -ne $key) { $key.Dispose() }
            if ($null -ne $root) { $root.Dispose() }
        }
    }
}

# HKCR merges machine and user COM registrations; inspect both registry views.
foreach ($view in $views) {
    $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::ClassesRoot, $view)
    try {
        foreach ($name in $root.GetSubKeyNames()) {
            $classEntries++
            if ($name -match '^AutoCAD\.Application(?:\.|$)') { $findings.Add("COM $view`: $name") }
        }
    } finally { $root.Dispose() }
}

function Read-ExecutablePaths([string]$Directory, [string]$Filter, [IO.SearchOption]$Scope) {
    try { $attributes = [IO.File]::GetAttributes($Directory) }
    catch {
        # Only an absent scan root is normal. A missing descendant/broken junction during
        # enumeration of an existing Autodesk tree must fail, retaining no absence claim.
        $failure = $_.Exception.GetBaseException()
        if ($failure -is [IO.DirectoryNotFoundException] -or $failure -is [IO.FileNotFoundException]) { return @() }
        throw
    }
    if (($attributes -band [IO.FileAttributes]::Directory) -eq 0) { throw 'An executable inventory root is not a directory.' }
    return [IO.Directory]::GetFiles($Directory, $Filter, $Scope)
}

$pathValue = [Environment]::GetEnvironmentVariable('PATH')
if ([string]::IsNullOrWhiteSpace($pathValue)) { throw 'PATH is unavailable for the AutoCAD absence inventory.' }
$pathDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($part in $pathValue.Split(';')) {
    $directory = [Environment]::ExpandEnvironmentVariables($part.Trim().Trim('"'))
    if ($directory) { [void]$pathDirectories.Add([IO.Path]::GetFullPath($directory)) }
}
$executableNames = @('acad.exe', 'acadlt.exe', 'accoreconsole.exe')
foreach ($directory in $pathDirectories) {
    foreach ($filter in $executableNames) {
        foreach ($file in @(Read-ExecutablePaths $directory $filter ([IO.SearchOption]::TopDirectoryOnly))) {
            $findings.Add("PATH executable: $file")
        }
    }
}
$processes = @(Get-Process -ErrorAction Stop)
foreach ($process in $processes) {
    if ($process.ProcessName -in @('acad', 'acadlt', 'accoreconsole')) { $findings.Add("running process: $($process.ProcessName)") }
}

$programRoots = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($name in @('ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432')) {
    $directory = [Environment]::GetEnvironmentVariable($name)
    if ($directory) { [void]$programRoots.Add([IO.Path]::GetFullPath($directory)) }
}
if ($programRoots.Count -eq 0) { throw 'Program Files locations are unavailable for the AutoCAD absence inventory.' }
foreach ($directory in $programRoots) {
    $autodesk = [IO.Path]::Combine($directory, 'Autodesk')
    foreach ($filter in $executableNames) {
        foreach ($file in @(Read-ExecutablePaths $autodesk $filter ([IO.SearchOption]::AllDirectories))) {
            $findings.Add("Autodesk executable: $file")
        }
    }
}
if ($findings.Count -gt 0) {
    $findings | Select-Object -First 5 | ForEach-Object { Write-Output "AUTOCAD_PRESENT $_" }
    throw "AutoCAD absence could not be established ($($findings.Count) matching installation/runtime entries)."
}
$inventory = [ordered]@{
    schemaVersion = 1
    checkedAtUtc = [DateTime]::UtcNow.ToString('o')
    sourceSha = $sourceSha
    platform = 'Windows'
    autoCadPresent = $false
    uninstallViews = 4
    uninstallEntries = $uninstallEntries
    comViews = 2
    classEntries = $classEntries
    pathDirectories = $pathDirectories.Count
    runningProcesses = $processes.Count
    autodeskTrees = $programRoots.Count
    matches = 0
    scope = 'HKLM/HKCU uninstall views, AutoCAD.Application COM views, acad/acadlt/accoreconsole executables on PATH and in standard Program Files Autodesk trees, and all three running process names. Arbitrary user directories are not searched.'
}
$evidence = [IO.Path]::GetFullPath($EvidencePath)
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($evidence))
$bytes = [Text.Encoding]::UTF8.GetBytes(($inventory | ConvertTo-Json) + [Environment]::NewLine)
$file = [IO.File]::Open($evidence, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $file.Write($bytes, 0, $bytes.Length); $file.Flush() }
finally { $file.Dispose() }
Write-Output "JCAD_NO_AUTOCAD_OK uninstall_views=4 uninstall_entries=$uninstallEntries COM_views=2 class_entries=$classEntries PATH_directories=$($pathDirectories.Count) running_processes=$($processes.Count) Autodesk_trees=$($programRoots.Count) matches=0"
