import { createRequire } from 'node:module';
import path from 'node:path';
import { buildChildEnv } from './child-env.js';

const require = createRequire(import.meta.url);
// Bound native helper startup/compilation on a loaded Windows host.
export const WIN32_NATIVE_CLEANUP_TIMEOUT_MS = 5000;
const NATIVE_SOURCE = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class WrongStackProcessTree {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 struct Entry {
  public uint size, usage, pid;
  public IntPtr heap;
  public uint module, threads, parent;
  public int priority;
  public uint flags;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
 }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot,ref Entry entry);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot,ref Entry entry);
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 struct Owned { public uint pid; public IntPtr handle; public long created; }
 static bool Inspect(uint pid,uint access,List<IntPtr> handles,out Owned owned) {
  owned = new Owned();
  IntPtr h=OpenProcess(access,false,pid);
  if(h==IntPtr.Zero) return false;
  handles.Add(h);
  long c,e,k,u; uint code;
  if(!GetProcessTimes(h,out c,out e,out k,out u) || !GetExitCodeProcess(h,out code) || code!=259) return false;
  owned=new Owned {pid=pid,handle=h,created=c}; return true;
 }
 public static void StopDescendants(uint pid,uint expectedParent,long requestedBefore) {
  var handles=new List<IntPtr>(); IntPtr snapshot=IntPtr.Zero;
  try {
   Owned root;
   if(!Inspect(pid,0x1000,handles,out root) || root.created>requestedBefore) return;
   long snapshotBefore=DateTime.UtcNow.ToFileTimeUtc();
   snapshot=CreateToolhelp32Snapshot(2,0);
   if(snapshot==IntPtr.Zero || snapshot==new IntPtr(-1)) {snapshot=IntPtr.Zero;return;}
   var entries=new Dictionary<uint,uint>();
   Entry entry=new Entry(); entry.size=(uint)Marshal.SizeOf(typeof(Entry));
   if(Process32FirstW(snapshot,ref entry)) do {entries[entry.pid]=entry.parent;} while(Process32NextW(snapshot,ref entry));
   uint actualParent;
   if(!entries.TryGetValue(pid,out actualParent) || actualParent!=expectedParent) return;
   var owned=new List<Owned>(); owned.Add(root);
   var seen=new HashSet<uint>(); seen.Add(pid);
   for(int i=0;i<owned.Count;i++) foreach(var row in entries) {
    if(row.Value!=owned[i].pid || row.Key<=1 || row.Key==expectedParent || !seen.Add(row.Key)) continue;
    Owned descendant;
    if(!Inspect(row.Key,0x1001,handles,out descendant) || descendant.created<owned[i].created || descendant.created>snapshotBefore) continue;
    owned.Add(descendant);
   }
   for(int i=owned.Count-1;i>0;i--) TerminateProcess(owned[i].handle,1);
  } finally {
   if(snapshot!=IntPtr.Zero) CloseHandle(snapshot);
   foreach(IntPtr h in handles) CloseHandle(h);
  }
 }
}
`;

/**
 * Best-effort fallback after a stalled/failed taskkill, before stopping its
 * wrapper. Toolhelp avoids the slow WMI table. A real ChildProcess, its expected
 * parent and creation time establish root ownership; retained handles and
 * creation-time bounds reject PID reuse while capturing/killing descendants.
 * PowerShell/.NET is bounded and optional; the caller always retains its direct
 * child-handle fallback. No arbitrary PID-only targets or test doubles accepted.
 */
export function terminateWin32Descendants(child: {
  readonly pid?: number | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signalCode?: NodeJS.Signals | null | undefined;
}): void {
  if (process.platform !== 'win32') return;
  const pid = child.pid;
  if (
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    pid <= 1 ||
    pid === process.pid ||
    pid === process.ppid
  )
    return;
  if (child.exitCode != null || child.signalCode != null) return;
  const { ChildProcess, spawnSync } =
    require('node:child_process') as typeof import('node:child_process');
  if (!(child instanceof ChildProcess)) return;
  const requestedBefore = BigInt(Date.now()) * 10_000n + 116_444_736_000_000_000n;
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'
${NATIVE_SOURCE}
'@; [WrongStackProcessTree]::StopDescendants(${pid},${process.pid},${requestedBefore}L)`;
  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows';
  try {
    spawnSync(
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        env: buildChildEnv(),
        windowsHide: true,
        stdio: 'ignore',
        timeout: WIN32_NATIVE_CLEANUP_TIMEOUT_MS,
      },
    );
  } catch {
    // The direct child handle remains the final fallback on restricted hosts.
  }
}
