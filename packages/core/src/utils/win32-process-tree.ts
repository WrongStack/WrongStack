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
 * Suspend-then-walk tree stop. `taskkill /T` enumerates the tree and then
 * terminates it; a child the root launches in between is missed and outlives
 * its dead parent. A shell stopped while it is still starting its command
 * (a packaged pwsh especially) loses that race and orphans the command, which
 * keeps the parent's stdio pipes open.
 *
 * Here the root is suspended first, so it launches nothing new; then the tree
 * is re-listed until two passes find nothing new, each descendant suspended as
 * it is found, and everything is terminated. A launch already inside the
 * kernel can still complete, so a final sweep catches children of the
 * terminated set. Every process is held by a handle from discovery to the end,
 * which pins its PID: "parent PID matches and created after the parent" then
 * identifies a real descendant, never a recycled PID. Exit code 0 = the root
 * was terminated by this helper.
 */
const SUSPEND_STOP_SOURCE = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public static class WrongStackTreeStop {
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
 [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr handle);
 const uint ACCESS=0x1801; // QUERY_LIMITED_INFORMATION | SUSPEND_RESUME | TERMINATE
 static Dictionary<uint,uint> Snapshot() {
  IntPtr s=CreateToolhelp32Snapshot(2,0);
  if(s==IntPtr.Zero || s==new IntPtr(-1)) return null;
  try {
   var rows=new Dictionary<uint,uint>();
   Entry e=new Entry(); e.size=(uint)Marshal.SizeOf(typeof(Entry));
   if(Process32FirstW(s,ref e)) do {rows[e.pid]=e.parent;} while(Process32NextW(s,ref e));
   return rows;
  } finally { CloseHandle(s); }
 }
 static IntPtr OpenLive(uint pid,List<IntPtr> handles,out long created) {
  created=0;
  IntPtr h=OpenProcess(ACCESS,false,pid);
  if(h==IntPtr.Zero) return IntPtr.Zero;
  handles.Add(h);
  long e,k,u; uint code;
  if(!GetProcessTimes(h,out created,out e,out k,out u) || !GetExitCodeProcess(h,out code) || code!=259) return IntPtr.Zero;
  return h;
 }
 // Adds every live, not yet held process whose parent is held and that was
 // created after that parent. Returns how many were added.
 static int Collect(uint expectedParent,Dictionary<uint,long> held,Dictionary<uint,IntPtr> owned,HashSet<uint> seen,List<IntPtr> handles,bool suspend) {
  var rows=Snapshot();
  if(rows==null) return 0;
  int added=0;
  bool grew=true;
  while(grew) {
   grew=false;
   foreach(var row in rows) {
    long parentCreated;
    if(row.Key<=1 || row.Key==expectedParent || seen.Contains(row.Key) || !held.TryGetValue(row.Value,out parentCreated)) continue;
    // A child caught mid-creation may not open yet: retry it on a later pass.
    long created; IntPtr h=OpenLive(row.Key,handles,out created);
    if(h==IntPtr.Zero) continue;
    seen.Add(row.Key);
    if(created<parentCreated) continue; // a recycled PID, not a descendant
    if(suspend) NtSuspendProcess(h); else TerminateProcess(h,1);
    held[row.Key]=created; owned[row.Key]=h; added++; grew=true;
   }
  }
  return added;
 }
 public static int StopTree(uint pid,uint expectedParent,long requestedBefore) {
  var handles=new List<IntPtr>();
  var held=new Dictionary<uint,long>();
  var owned=new Dictionary<uint,IntPtr>();
  var seen=new HashSet<uint>();
  try {
   long rootCreated; IntPtr root=OpenLive(pid,handles,out rootCreated);
   if(root==IntPtr.Zero || rootCreated>requestedBefore) return 2;
   var rows=Snapshot(); uint actualParent;
   if(rows==null || !rows.TryGetValue(pid,out actualParent) || actualParent!=expectedParent) return 3;
   NtSuspendProcess(root);
   held[pid]=rootCreated; owned[pid]=root; seen.Add(pid);
   for(int pass=0,quiet=0; pass<40 && quiet<2; pass++) {
    if(pass>0) Thread.Sleep(25);
    quiet=Collect(expectedParent,held,owned,seen,handles,true)==0 ? quiet+1 : 0;
   }
   foreach(var h in owned.Values) TerminateProcess(h,1);
   for(int pass=0,quiet=0; pass<10 && quiet<2; pass++) {
    Thread.Sleep(25);
    quiet=Collect(expectedParent,held,owned,seen,handles,false)==0 ? quiet+1 : 0;
   }
   return 0;
  } finally {
   // Never leave a suspended process behind, whatever failed above.
   foreach(var h in owned.Values) TerminateProcess(h,1);
   foreach(IntPtr h in handles) CloseHandle(h);
  }
 }
}
`;

/** Bound on the suspend-then-walk helper (PowerShell start, C# compile, walk). */
export const WIN32_SUSPEND_STOP_TIMEOUT_MS = 10_000;

/**
 * Stop `child` and every descendant with the suspend-then-walk helper
 * ({@link SUSPEND_STOP_SOURCE}), asynchronously. `onSettled(true)` means the
 * helper terminated the root; `false` (helper failed, timed out, or refused
 * the root) means the caller should run its usual taskkill chain. Returns
 * false without starting anything when the child is not a live, real
 * `ChildProcess` of this process on Windows.
 */
export function stopWin32TreeSuspended(
  child: {
    readonly pid?: number | undefined;
    readonly exitCode?: number | null | undefined;
    readonly signalCode?: NodeJS.Signals | null | undefined;
  },
  opts: { timeoutMs?: number | undefined; onSettled?: (stopped: boolean) => void } = {},
): boolean {
  if (process.platform !== 'win32') return false;
  const pid = child.pid;
  if (
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    pid <= 1 ||
    pid === process.pid ||
    pid === process.ppid
  )
    return false;
  if (child.exitCode != null || child.signalCode != null) return false;
  const { ChildProcess, spawn } =
    require('node:child_process') as typeof import('node:child_process');
  if (!(child instanceof ChildProcess)) return false;
  const requestedBefore = BigInt(Date.now()) * 10_000n + 116_444_736_000_000_000n;
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'
${SUSPEND_STOP_SOURCE}
'@; exit [WrongStackTreeStop]::StopTree(${pid},${process.pid},${requestedBefore}L)`;
  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows';
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = (stopped: boolean): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    try {
      opts.onSettled?.(stopped);
    } catch {
      /* fallback callbacks are best-effort */
    }
  };
  try {
    const helper = spawn(
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { env: buildChildEnv(), windowsHide: true, stdio: 'ignore' },
    );
    helper.once('error', () => settle(false));
    helper.once('close', (code) => settle(code === 0));
    timer = setTimeout(() => {
      try {
        helper.kill();
      } catch {
        /* already exited */
      }
      settle(false);
    }, opts.timeoutMs ?? WIN32_SUSPEND_STOP_TIMEOUT_MS);
    timer.unref?.();
    helper.unref();
    return true;
  } catch {
    return false;
  }
}

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
