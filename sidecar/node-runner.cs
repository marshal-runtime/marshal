using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

/// <summary>
/// Windowless wrapper that clears NODE_OPTIONS and spawns the bundled
/// node.exe for MCP server processes. Used because the Copilot CLI does
/// not forward env vars to MCP children, and to suppress the console
/// window that node.exe would otherwise flash on Windows.
///
/// The spawned child is placed in a kill-on-close Job Object and is
/// force-killed when our own stdin reaches EOF (the parent/session closed
/// the pipe). Windows does not tree-kill by default, so without this a
/// terminated session leaked orphaned MCP server processes that piled up
/// (hundreds of node.exe / tens of GB observed over multi-day sessions).
///
/// Usage: node-runner.exe C:\path\to\node.exe server.js [args...]
/// </summary>
class NodeRunner {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    // Create a Job Object that kills every assigned process when the last handle
    // closes — i.e. when THIS wrapper exits or is force-killed. Returns
    // IntPtr.Zero on failure; the caller then relies on the stdin-EOF kill path.
    static IntPtr CreateKillOnCloseJob() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buf = Marshal.AllocHGlobal(len);
        try {
            Marshal.StructureToPtr(info, buf, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buf, (uint)len)) {
                return IntPtr.Zero;
            }
        } finally {
            Marshal.FreeHGlobal(buf);
        }
        return job;
    }

    static int Main(string[] args) {
        if (args.Length < 1) return 1;

        string exePath = args[0];
        string arguments = "";
        for (int i = 1; i < args.Length; i++) {
            if (i > 1) arguments += " ";
            arguments += "\"" + args[i] + "\"";
        }

        var psi = new ProcessStartInfo {
            FileName = exePath,
            Arguments = arguments,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.EnvironmentVariables["NODE_OPTIONS"] = "";

        // Kept in scope for the wrapper's lifetime: closing this handle (on our
        // process exit or force-kill) triggers KILL_ON_JOB_CLOSE and reaps the
        // child tree. Do NOT close it early.
        IntPtr job = CreateKillOnCloseJob();

        Process proc;
        try {
            proc = Process.Start(psi);
        } catch {
            return 1;
        }
        if (proc == null) return 1;

        // Assign the child to the kill-on-close job so it (and any grandchildren)
        // die when this wrapper does. Succeeds on Windows 8+ even if we're
        // already inside a job (nested jobs); best-effort otherwise.
        if (job != IntPtr.Zero) {
            try { AssignProcessToJobObject(job, proc.Handle); } catch {}
        }

        // Relay stdin -> child (flush after each read for MCP JSON-RPC). When our
        // stdin hits EOF the parent/session has gone away: close the child's
        // stdin (graceful MCP shutdown) and then force-kill if it doesn't exit,
        // so a server that ignores stdin-close can't linger. The job reaps any
        // surviving tree once we exit.
        var stdinThread = new Thread(() => {
            try {
                var src = Console.OpenStandardInput();
                var dst = proc.StandardInput.BaseStream;
                byte[] buf = new byte[4096];
                int n;
                while ((n = src.Read(buf, 0, buf.Length)) > 0) {
                    dst.Write(buf, 0, n);
                    dst.Flush();
                }
                try { proc.StandardInput.Close(); } catch {}
                try { if (!proc.WaitForExit(3000)) proc.Kill(); } catch {}
            } catch {}
        });
        stdinThread.IsBackground = true;
        stdinThread.Start();

        // Relay child stdout -> our stdout (flush after each read for MCP)
        var stdoutThread = new Thread(() => {
            try {
                var src = proc.StandardOutput.BaseStream;
                var dst = Console.OpenStandardOutput();
                byte[] buf = new byte[4096];
                int n;
                while ((n = src.Read(buf, 0, buf.Length)) > 0) {
                    dst.Write(buf, 0, n);
                    dst.Flush();
                }
            } catch {}
        });
        stdoutThread.IsBackground = true;
        stdoutThread.Start();

        // Relay child stderr -> our stderr
        var stderrThread = new Thread(() => {
            try {
                var src = proc.StandardError.BaseStream;
                var dst = Console.OpenStandardError();
                byte[] buf = new byte[4096];
                int n;
                while ((n = src.Read(buf, 0, buf.Length)) > 0) {
                    dst.Write(buf, 0, n);
                    dst.Flush();
                }
            } catch {}
        });
        stderrThread.IsBackground = true;
        stderrThread.Start();

        proc.WaitForExit();
        // Join relay threads so all buffered output is forwarded before Main() returns.
        // Safe: child exit closes the pipe handles, causing src.Read() to return 0 (EOF)
        // and the relay loops to exit naturally. Background threads would be killed by
        // .NET the moment Main() returns without these Join() calls.
        stdoutThread.Join();
        stderrThread.Join();
        return proc.ExitCode;
    }
}
