# Which processes hold files in a folder (Windows' Restart Manager): update-electron.mjs asks when npm finds
# Electron's folder busy, and writes the answer to update.log.
param([Parameter(Mandatory)][string]$Dir)
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Rm {
  [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable; }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int f, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint n, string[] files, uint a, IntPtr b, uint c, string[] d);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint n, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
  public static List<string> Who(string[] files) {
    var res = new List<string>(); uint h; RmStartSession(out h, 0, Guid.NewGuid().ToString());
    try {
      RmRegisterResources(h, (uint)files.Length, files, 0, IntPtr.Zero, 0, null);
      uint needed = 0, n = 0, r = 0; RmGetList(h, out needed, ref n, null, ref r);
      if (needed > 0) { var info = new RM_PROCESS_INFO[needed]; n = needed; RmGetList(h, out needed, ref n, info, ref r);
        for (int i = 0; i < n; i++) res.Add(info[i].Process.dwProcessId + " " + info[i].strAppName + " " + info[i].strServiceShortName); }
    } finally { RmEndSession(h); }
    return res;
  }
}
"@
$files = Get-ChildItem $Dir -Recurse -File | ForEach-Object FullName
[Rm]::Who($files) | ForEach-Object { $id = [int]($_ -split ' ')[0]; $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"; "$_ | $($p.ExecutablePath)" }
