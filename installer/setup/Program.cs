using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Management;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace AgyClaudeStyle.Installer
{
    internal class InstallerOptions
    {
        public bool Uninstall;
        public bool Silent;
        public bool Popup;
        public bool StatusOnly;
        public bool NoAutostart;
        public bool NoKillLegacy;
        public string InstallDir;
        public int? CdpPort;
        public string OutFile;
        public string RunMode;
        public bool ModeExplicit;
        public bool DesktopShortcut = true;
        public bool NoDesktopShortcut;
    }

    internal class AntigravityDetectResult
    {
        public string ExePath;
        public string Version;
        public bool IsRunning;
    }

    internal class OperationResult
    {
        public bool Ok;
        public string Mode;
        public string RunMode;
        public bool WatcherStarted;
        public string LauncherShortcutPath;
        public string DesktopShortcutPath;
        public bool StartupShortcutActive;
        public string Headline;
        public string Detail;
        public string InstallDir;
        public string AntigravityExe;
        public string AntigravityVersion;
        public bool AntigravityRunningWithoutCdp;
        public int? CdpPort;
        public List<string> InjectedPages = new List<string>();
        public bool PreservedExistingConfig;
        public bool SelfDeleteScheduled;
        public string ConfigSummary;
    }

    internal static class InstallerCore
    {
        private const string UninstallRegSubKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\AGYClaudeStyle";
        private const string StartupLnkName = "AGY-Claude-Style.lnk";
        private const string LauncherLnkName = "Antigravity (AGY Claude Style).lnk";
        private const string WatcherExeName = "agy-claude-style-watcher.exe";
        private const string SelfInstalledExeName = "agy-claude-style-installer.exe";
        private const string InstallModeFileName = ".install-mode";

        public static string GetTestSystemRoot()
        {
            string root = Environment.GetEnvironmentVariable("AGY_CS_TEST_SYSTEM_ROOT");
            if (string.IsNullOrEmpty(root)) return null;
            string trimmed = root.Trim();
            return string.IsNullOrEmpty(trimmed) ? null : Path.GetFullPath(trimmed);
        }

        public static string NormalizeRunMode(string value)
        {
            if (string.Equals(value, "daemon", StringComparison.OrdinalIgnoreCase)) return "daemon";
            if (string.Equals(value, "managed", StringComparison.OrdinalIgnoreCase)) return "managed";
            return null;
        }

        public static string ReadInstalledMode(string installDir)
        {
            try
            {
                if (string.IsNullOrEmpty(installDir)) return null;
                string modePath = Path.Combine(installDir, InstallModeFileName);
                if (!File.Exists(modePath)) return null;
                return NormalizeRunMode(File.ReadAllText(modePath, Encoding.UTF8).Trim());
            }
            catch
            {
                return null;
            }
        }

        public static void WriteInstalledMode(string installDir, string mode)
        {
            string normalized = NormalizeRunMode(mode) ?? "managed";
            Directory.CreateDirectory(installDir);
            File.WriteAllText(Path.Combine(installDir, InstallModeFileName), normalized + "\n", new UTF8Encoding(false));
        }

        public static string ResolveRunMode(InstallerOptions opts, string installDir)
        {
            if (opts != null && opts.ModeExplicit)
            {
                string explicitMode = NormalizeRunMode(opts.RunMode);
                if (!string.IsNullOrEmpty(explicitMode)) return explicitMode;
            }
            if (opts != null && opts.NoAutostart) return "managed";
            string installed = ReadInstalledMode(installDir);
            if (!string.IsNullOrEmpty(installed)) return installed;
            if (File.Exists(GetStartupShortcutPath())) return "daemon";
            return "managed";
        }

        public static bool IsWatcherRunningInDir(string dir)
        {
            try
            {
                string pidFile = Path.Combine(dir, ".watch.pid");
                if (!File.Exists(pidFile)) return false;
                int pid;
                if (int.TryParse(File.ReadAllText(pidFile, Encoding.UTF8).Trim(), out pid) && pid > 0)
                {
                    return CdpHelper.IsProcessAlive(pid);
                }
            }
            catch { }
            return false;
        }

        public static string GetDefaultInstallDir()
        {
            string localAppData = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (string.IsNullOrEmpty(localAppData))
            {
                localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            }
            return Path.Combine(localAppData, "agy-claude-style");
        }

        public static string GetDirHash(string dir)
        {
            return CdpHelper.ComputeHash(Path.GetFullPath(dir).TrimEnd('\\', '/').ToLowerInvariant());
        }

        public static string GetStartupShortcutPath()
        {
            string testRoot = GetTestSystemRoot();
            string dir = !string.IsNullOrEmpty(testRoot)
                ? Path.Combine(testRoot, "Startup")
                : Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            return Path.Combine(dir, StartupLnkName);
        }

        public static string GetStartMenuLauncherShortcutPath()
        {
            string testRoot = GetTestSystemRoot();
            string dir = !string.IsNullOrEmpty(testRoot)
                ? Path.Combine(testRoot, "StartMenu")
                : Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            return Path.Combine(dir, LauncherLnkName);
        }

        public static string GetDesktopLauncherShortcutPath()
        {
            string testRoot = GetTestSystemRoot();
            string dir = !string.IsNullOrEmpty(testRoot)
                ? Path.Combine(testRoot, "Desktop")
                : Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            return Path.Combine(dir, LauncherLnkName);
        }

        public static void CreateManagedLauncherShortcut(string lnkPath, string installDir, string antigravityExe)
        {
            if (string.IsNullOrEmpty(lnkPath) || string.IsNullOrEmpty(installDir)) return;
            string cleanDir = installDir.TrimEnd('\\', '/');
            string watcherExe = Path.Combine(cleanDir, WatcherExeName);
            if (!File.Exists(watcherExe)) return;
            string iconTarget = (!string.IsNullOrEmpty(antigravityExe) && File.Exists(antigravityExe))
                ? antigravityExe
                : watcherExe;
            try
            {
                string parent = Path.GetDirectoryName(lnkPath);
                if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                object shell = Activator.CreateInstance(shellType);
                object lnk = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
                Type lnkType = lnk.GetType();
                lnkType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { watcherExe });
                lnkType.InvokeMember("Arguments", BindingFlags.SetProperty, null, lnk, new object[] { "--launch --relaunch --exit-on-host-close --dir \"" + cleanDir + "\"" });
                lnkType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { cleanDir });
                lnkType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { iconTarget + ",0" });
                lnkType.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { "Launch Antigravity Desktop with AGY Claude Style (Managed Mode)" });
                lnkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
            }
            catch { }
        }

        public static AntigravityDetectResult DetectAntigravityDesktop()
        {
            AntigravityDetectResult res = new AntigravityDetectResult();
            try
            {
                Process[] procs = Process.GetProcessesByName("Antigravity");
                if (procs != null && procs.Length > 0)
                {
                    res.IsRunning = true;
                    for (int i = 0; i < procs.Length; i++)
                    {
                        try
                        {
                            string p = procs[i].MainModule.FileName;
                            if (!string.IsNullOrEmpty(p) && File.Exists(p))
                            {
                                res.ExePath = p;
                                break;
                            }
                        }
                        catch { }
                        finally
                        {
                            try { procs[i].Dispose(); } catch { }
                        }
                    }
                }
            }
            catch { }

            if (string.IsNullOrEmpty(res.ExePath))
            {
                List<string> candidates = new List<string>();
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string progFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                string progFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
                if (!string.IsNullOrEmpty(localAppData))
                    candidates.Add(Path.Combine(localAppData, "Programs", "antigravity", "Antigravity.exe"));
                if (!string.IsNullOrEmpty(progFiles))
                    candidates.Add(Path.Combine(progFiles, "Antigravity", "Antigravity.exe"));
                if (!string.IsNullOrEmpty(progFilesX86))
                    candidates.Add(Path.Combine(progFilesX86, "Antigravity", "Antigravity.exe"));

                for (int i = 0; i < candidates.Count; i++)
                {
                    if (File.Exists(candidates[i]))
                    {
                        res.ExePath = candidates[i];
                        break;
                    }
                }
            }

            if (string.IsNullOrEmpty(res.ExePath))
            {
                res.ExePath = FindAntigravityFromUninstallRegistry();
            }

            if (!string.IsNullOrEmpty(res.ExePath))
            {
                try
                {
                    FileVersionInfo fvi = FileVersionInfo.GetVersionInfo(res.ExePath);
                    res.Version = !string.IsNullOrEmpty(fvi.FileVersion) ? fvi.FileVersion : fvi.ProductVersion;
                }
                catch { }
                if (string.IsNullOrEmpty(res.Version))
                {
                    string dir = Path.GetDirectoryName(res.ExePath);
                    string versionFile = Path.Combine(dir, "version");
                    if (File.Exists(versionFile))
                    {
                        try { res.Version = File.ReadAllText(versionFile, Encoding.UTF8).Trim(); } catch { }
                    }
                }
            }

            return res;
        }

        private static string FindAntigravityFromUninstallRegistry()
        {
            RegistryKey[] roots = new RegistryKey[] { Registry.CurrentUser, Registry.LocalMachine };
            string[] subPaths = new string[]
            {
                @"Software\Microsoft\Windows\CurrentVersion\Uninstall",
                @"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
            };
            for (int r = 0; r < roots.Length; r++)
            {
                for (int sp = 0; sp < subPaths.Length; sp++)
                {
                    try
                    {
                        using (RegistryKey parent = roots[r].OpenSubKey(subPaths[sp]))
                        {
                            if (parent == null) continue;
                            string[] names = parent.GetSubKeyNames();
                            for (int i = 0; i < names.Length; i++)
                            {
                                try
                                {
                                    using (RegistryKey item = parent.OpenSubKey(names[i]))
                                    {
                                        if (item == null) continue;
                                        string disp = item.GetValue("DisplayName") as string;
                                        if (string.IsNullOrEmpty(disp)) continue;
                                        if (!disp.StartsWith("Antigravity", StringComparison.OrdinalIgnoreCase)) continue;
                                        if (disp.IndexOf("IDE", StringComparison.OrdinalIgnoreCase) >= 0) continue;

                                        string loc = item.GetValue("InstallLocation") as string;
                                        string exe = TryProbeAntigravityDir(loc);
                                        if (exe != null) return exe;

                                        string uninst = item.GetValue("UninstallString") as string;
                                        exe = TryProbeAntigravityFromCmd(uninst);
                                        if (exe != null) return exe;

                                        string icon = item.GetValue("DisplayIcon") as string;
                                        exe = TryProbeAntigravityFromCmd(icon);
                                        if (exe != null) return exe;
                                    }
                                }
                                catch { }
                            }
                        }
                    }
                    catch { }
                }
            }
            return null;
        }

        private static string TryProbeAntigravityDir(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return null;
            string cleaned = dir.Trim().Trim('"');
            if (string.IsNullOrEmpty(cleaned)) return null;
            string exe = Path.Combine(cleaned, "Antigravity.exe");
            return File.Exists(exe) ? exe : null;
        }

        private static string TryProbeAntigravityFromCmd(string cmd)
        {
            if (string.IsNullOrEmpty(cmd)) return null;
            string s = cmd.Trim();
            string pathPart = null;
            if (s.StartsWith("\"", StringComparison.Ordinal))
            {
                int end = s.IndexOf('"', 1);
                if (end > 1) pathPart = s.Substring(1, end - 1);
            }
            else
            {
                int exeIdx = s.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
                if (exeIdx > 0) pathPart = s.Substring(0, exeIdx + 4);
            }
            if (string.IsNullOrEmpty(pathPart)) return null;
            int comma = pathPart.IndexOf(',');
            if (comma > 0) pathPart = pathPart.Substring(0, comma);
            try
            {
                return TryProbeAntigravityDir(Path.GetDirectoryName(pathPart));
            }
            catch
            {
                return null;
            }
        }

        public static void StopWatcherInDir(string dir, Action<string> log)
        {
            if (!Directory.Exists(dir)) return;
            int selfPid = Process.GetCurrentProcess().Id;
            string pidFile = Path.Combine(dir, ".watch.pid");
            if (File.Exists(pidFile))
            {
                bool shouldDeletePidFile = false;
                try
                {
                    int pid;
                    if (!int.TryParse(File.ReadAllText(pidFile, Encoding.UTF8).Trim(), out pid) || pid <= 0)
                    {
                        shouldDeletePidFile = true;
                    }
                    else if (pid != selfPid)
                    {
                        CdpHelper.WatcherPidClassification cls = CdpHelper.ClassifyWatcherPid(pid, dir);
                        if (cls.Status == CdpHelper.WatcherPidStatus.Owned)
                        {
                            string hash = GetDirHash(dir);
                            try
                            {
                                using (EventWaitHandle stopEvt = EventWaitHandle.OpenExisting("Local\\AGYClaudeStyleStop_" + hash))
                                {
                                    stopEvt.Set();
                                }
                            }
                            catch { }

                            try
                            {
                                using (Process p = Process.GetProcessById(pid))
                                {
                                    if (!p.WaitForExit(2000))
                                    {
                                        p.Kill();
                                        p.WaitForExit(2000);
                                    }
                                    if (log != null) log("已停止运行中的守护进程 (PID " + pid + ")");
                                }
                            }
                            catch { }
                            shouldDeletePidFile = true;
                        }
                        else if (cls.Status == CdpHelper.WatcherPidStatus.Dead || cls.Status == CdpHelper.WatcherPidStatus.Foreign)
                        {
                            // Never signal/kill foreign processes; clean stale pointer only.
                            shouldDeletePidFile = true;
                        }
                        else
                        {
                            // Fail closed: unknown ownership must not be terminated or unlinked.
                            if (log != null) log("无法验证 .watch.pid 进程归属 (PID " + pid + ")，已拒绝终止并保留锁文件");
                        }
                    }
                }
                catch { }
                if (shouldDeletePidFile)
                {
                    try { File.Delete(pidFile); } catch { }
                }
            }

            try
            {
                string hash = GetDirHash(dir);
                Process[] procs = Process.GetProcessesByName(Path.GetFileNameWithoutExtension(WatcherExeName));
                for (int i = 0; i < procs.Length; i++)
                {
                    try
                    {
                        if (procs[i].Id == selfPid) continue;
                        CdpHelper.WatcherPidClassification cls = CdpHelper.ClassifyWatcherPid(procs[i].Id, dir);
                        if (cls.Status == CdpHelper.WatcherPidStatus.Owned)
                        {
                            try
                            {
                                using (EventWaitHandle stopEvt = EventWaitHandle.OpenExisting("Local\\AGYClaudeStyleStop_" + hash))
                                {
                                    stopEvt.Set();
                                }
                            }
                            catch { }

                            if (!procs[i].WaitForExit(1500))
                            {
                                procs[i].Kill();
                                procs[i].WaitForExit(1500);
                            }
                        }
                    }
                    catch { }
                    finally
                    {
                        try { procs[i].Dispose(); } catch { }
                    }
                }
            }
            catch { }
        }

        public static void StopLegacyNodeWatchers(Action<string> log)
        {
            try
            {
                string lnkPath = GetStartupShortcutPath();
                if (File.Exists(lnkPath))
                {
                    string workDir = ReadShortcutWorkingDir(lnkPath);
                    if (!string.IsNullOrEmpty(workDir) && Directory.Exists(workDir))
                    {
                        string legacyPidFile = Path.Combine(workDir, ".watch.pid");
                        if (File.Exists(legacyPidFile))
                        {
                            bool deleteLegacyPid = false;
                            int pid;
                            if (int.TryParse(File.ReadAllText(legacyPidFile, Encoding.UTF8).Trim(), out pid) && pid > 0)
                            {
                                CdpHelper.WatcherPidClassification cls = CdpHelper.ClassifyWatcherPid(pid, workDir);
                                if (cls.Status == CdpHelper.WatcherPidStatus.Owned)
                                {
                                    try
                                    {
                                        using (Process p = Process.GetProcessById(pid))
                                        {
                                            p.Kill();
                                            p.WaitForExit(1500);
                                        }
                                        if (log != null) log("已停止旧版脚本守护进程 (PID " + pid + ")");
                                    }
                                    catch { }
                                    deleteLegacyPid = true;
                                }
                                else if (cls.Status == CdpHelper.WatcherPidStatus.Dead || cls.Status == CdpHelper.WatcherPidStatus.Foreign)
                                {
                                    deleteLegacyPid = true;
                                }
                                else if (log != null)
                                {
                                    log("无法验证旧版 .watch.pid 进程归属 (PID " + pid + ")，已跳过终止");
                                }
                            }
                            else
                            {
                                deleteLegacyPid = true;
                            }
                            if (deleteLegacyPid)
                            {
                                try { File.Delete(legacyPidFile); } catch { }
                            }
                        }
                    }
                }
            }
            catch { }

            try
            {
                int selfPid = Process.GetCurrentProcess().Id;
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE Name = 'node.exe'"))
                {
                    foreach (ManagementObject obj in searcher.Get())
                    {
                        try
                        {
                            string cmd = obj["CommandLine"] as string;
                            string exePath = obj["ExecutablePath"] as string;
                            if (string.IsNullOrWhiteSpace(cmd)) continue;
                            int pid = Convert.ToInt32(obj["ProcessId"]);
                            if (pid <= 0 || pid == selfPid) continue;

                            List<string> args = CdpHelper.SplitCommandArgs(cmd);
                            if (args.Count < 2) continue;
                            string scriptArg = args[1];
                            if (string.IsNullOrEmpty(scriptArg) || scriptArg.StartsWith("-", StringComparison.Ordinal)) continue;
                            if (!Path.IsPathRooted(scriptArg)) continue;
                            if (!string.Equals(Path.GetFileName(scriptArg), "inject.js", StringComparison.OrdinalIgnoreCase)) continue;

                            string parentDir = Path.GetDirectoryName(Path.GetFullPath(scriptArg));
                            if (string.IsNullOrEmpty(parentDir) ||
                                parentDir.IndexOf("agy-claude-style", StringComparison.OrdinalIgnoreCase) < 0)
                            {
                                continue;
                            }

                            CdpHelper.WatcherPidStatus status = CdpHelper.EvaluateWatcherOwnership(exePath, cmd, parentDir);
                            if (status == CdpHelper.WatcherPidStatus.Owned)
                            {
                                try
                                {
                                    using (Process p = Process.GetProcessById(pid))
                                    {
                                        p.Kill();
                                        p.WaitForExit(1500);
                                    }
                                    if (log != null) log("已替换旧版 Node 守护进程 (PID " + pid + ")");
                                }
                                catch { }
                            }
                        }
                        catch { }
                        finally
                        {
                            obj.Dispose();
                        }
                    }
                }
            }
            catch { }
        }

        private static string ReadShortcutWorkingDir(string lnkPath)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                object shell = Activator.CreateInstance(shellType);
                object lnk = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
                return lnk.GetType().InvokeMember("WorkingDirectory", BindingFlags.GetProperty, null, lnk, null) as string;
            }
            catch
            {
                return null;
            }
        }

        public static void CreateStartupShortcut(string installDir)
        {
            string cleanDir = installDir.TrimEnd('\\', '/');
            string lnkPath = GetStartupShortcutPath();
            string parent = Path.GetDirectoryName(lnkPath);
            if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
            string targetExe = Path.Combine(cleanDir, WatcherExeName);
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            object lnk = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
            Type lnkType = lnk.GetType();
            lnkType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { targetExe });
            lnkType.InvokeMember("Arguments", BindingFlags.SetProperty, null, lnk, new object[] { "--watch --dir \"" + cleanDir + "\"" });
            lnkType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { cleanDir });
            lnkType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { targetExe + ",0" });
            lnkType.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { "AGY Claude Style (agy-claude-style) watcher" });
            lnkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
        }

        public static void RegisterUninstallEntry(string installDir, string version)
        {
            if (!string.IsNullOrEmpty(GetTestSystemRoot())) return;
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallRegSubKey))
            {
                if (key == null) return;
                string exePath = Path.Combine(installDir, SelfInstalledExeName);
                key.SetValue("DisplayName", "AGY Claude Style (Antigravity 界面增强补丁)", RegistryValueKind.String);
                key.SetValue("DisplayVersion", version ?? "2.2.0", RegistryValueKind.String);
                key.SetValue("Publisher", "AGY Claude Style", RegistryValueKind.String);
                key.SetValue("InstallLocation", installDir, RegistryValueKind.String);
                key.SetValue("DisplayIcon", exePath + ",0", RegistryValueKind.String);
                key.SetValue("UninstallString", "\"" + exePath + "\" --uninstall", RegistryValueKind.String);
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        public static OperationResult RunInstall(InstallerOptions opts, Action<int, string> progress)
        {
            OperationResult result = new OperationResult();
            result.Mode = "install";
            string installDir = Path.GetFullPath(string.IsNullOrEmpty(opts.InstallDir) ? GetDefaultInstallDir() : opts.InstallDir).TrimEnd('\\', '/');
            result.InstallDir = installDir;
            string runMode = ResolveRunMode(opts, installDir);
            result.RunMode = runMode;

            Action<int, string> report = (pct, msg) =>
            {
                if (progress != null) progress(pct, msg);
            };

            report(8, "当前安装模式: " + (runMode == "daemon" ? "开机自启 · 后台常驻监听 (daemon)" : "免后台常驻 · 随 Antigravity 启动并自动退出 (managed)"));
            report(12, "正在检测本机 Antigravity Desktop 环境...");
            AntigravityDetectResult ag = DetectAntigravityDesktop();
            result.AntigravityExe = ag.ExePath;
            result.AntigravityVersion = ag.Version;
            if (!string.IsNullOrEmpty(ag.ExePath))
            {
                report(18, "已发现 Antigravity Desktop" + (string.IsNullOrEmpty(ag.Version) ? "" : " (" + ag.Version + ")") + ": " + ag.ExePath);
            }
            else
            {
                report(18, "未在默认目录检测到 Antigravity.exe，仍将安装并启用无损 CDP 注入");
            }

            report(28, "正在停止旧版守护进程（如存在）...");
            StopWatcherInDir(installDir, (m) => report(32, m));
            if (!opts.NoKillLegacy)
            {
                StopLegacyNodeWatchers((m) => report(35, m));
            }

            report(45, "正在部署独立运行环境与插件资源至: " + installDir);
            Directory.CreateDirectory(installDir);

            bool preservedConfig = false;
            using (Stream resStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("AGY_PAYLOAD.zip"))
            {
                if (resStream == null) throw new InvalidOperationException("安装包内嵌资源 AGY_PAYLOAD.zip 缺失");
                using (ZipArchive archive = new ZipArchive(resStream, ZipArchiveMode.Read))
                {
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        if (string.IsNullOrEmpty(entry.Name)) continue;
                        string destPath = Path.Combine(installDir, entry.FullName.Replace('/', '\\'));
                        string parent = Path.GetDirectoryName(destPath);
                        if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);

                        if (string.Equals(entry.Name, "config.json", StringComparison.OrdinalIgnoreCase) && File.Exists(destPath))
                        {
                            preservedConfig = true;
                            continue;
                        }
                        using (Stream inStream = entry.Open())
                        using (FileStream outStream = new FileStream(destPath, FileMode.Create, FileAccess.Write, FileShare.None))
                        {
                            inStream.CopyTo(outStream);
                        }
                    }
                }
            }
            result.PreservedExistingConfig = preservedConfig;
            report(60, preservedConfig ? "已保留本机现有 config.json 用户配置" : "已写入内置默认配置 config.json");

            try
            {
                string selfSrc = Assembly.GetExecutingAssembly().Location;
                string selfDest = Path.Combine(installDir, SelfInstalledExeName);
                if (!string.IsNullOrEmpty(selfSrc) && File.Exists(selfSrc) &&
                    !string.Equals(Path.GetFullPath(selfSrc), Path.GetFullPath(selfDest), StringComparison.OrdinalIgnoreCase))
                {
                    File.Copy(selfSrc, selfDest, true);
                }
            }
            catch { }

            WriteInstalledMode(installDir, runMode);

            PluginManifest manifest = PluginManifest.Load(installDir);
            Dictionary<string, object> activeCfg = CdpHelper.ReadConfig(installDir, manifest);
            result.ConfigSummary = string.Format(
                "语言={0} | 配色={1} | 圆环={2} | 思考滑块={3}",
                activeCfg.ContainsKey("language") ? activeCfg["language"] : "zh-CN",
                activeCfg.ContainsKey("palette") ? activeCfg["palette"] : "obsidian",
                activeCfg.ContainsKey("ringMode") ? activeCfg["ringMode"] : "context",
                activeCfg.ContainsKey("effortSliderStyle") ? activeCfg["effortSliderStyle"] : "claude"
            );

            string localLauncherLnk = Path.Combine(installDir, LauncherLnkName);
            CreateManagedLauncherShortcut(localLauncherLnk, installDir, ag.ExePath);
            result.LauncherShortcutPath = File.Exists(localLauncherLnk) ? localLauncherLnk : null;

            if (!opts.NoAutostart)
            {
                report(70, "正在配置启动快捷方式与卸载入口...");
                string startMenuLnk = GetStartMenuLauncherShortcutPath();
                CreateManagedLauncherShortcut(startMenuLnk, installDir, ag.ExePath);
                if (opts.DesktopShortcut && !opts.NoDesktopShortcut)
                {
                    string desktopLnk = GetDesktopLauncherShortcutPath();
                    CreateManagedLauncherShortcut(desktopLnk, installDir, ag.ExePath);
                    if (File.Exists(desktopLnk)) result.DesktopShortcutPath = desktopLnk;
                }
                RegisterUninstallEntry(installDir, manifest.Version);

                if (runMode == "daemon")
                {
                    CreateStartupShortcut(installDir);
                    report(76, "已注册 Windows 开机自启快捷方式 (daemon)");
                }
                else
                {
                    string startupLnk = GetStartupShortcutPath();
                    if (File.Exists(startupLnk))
                    {
                        try
                        {
                            File.Delete(startupLnk);
                            report(76, "已清理旧版开机自启快捷方式（当前为免后台常驻模式）");
                        }
                        catch { }
                    }
                    else
                    {
                        report(76, "免后台常驻模式：不注册开机自启，平时 0 进程常驻");
                    }
                }
            }
            else
            {
                report(72, "已按参数跳过系统快捷方式与开机自启注册");
            }
            result.StartupShortcutActive = File.Exists(GetStartupShortcutPath());

            bool isExplicitPort = opts.CdpPort.HasValue || !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("AG_CDP_PORT"));
            bool effectiveAgRunning = isExplicitPort ? false : ag.IsRunning;
            int? port = CdpHelper.ReadPort(opts.CdpPort);
            bool cdpReachable = false;
            if (port.HasValue)
            {
                try
                {
                    List<CdpPageInfo> probePages = CdpHelper.ListPagesAsync(port.Value).GetAwaiter().GetResult();
                    cdpReachable = (probePages != null);
                }
                catch
                {
                    cdpReachable = false;
                }
            }

            bool hasCdpFlag = !cdpReachable && effectiveAgRunning && CdpHelper.HasAntigravityCdpFlag();
            bool shouldStartWatcher = (runMode == "daemon") || cdpReachable || hasCdpFlag;

            if (shouldStartWatcher)
            {
                report(82, runMode == "daemon" ? "正在启动后台常驻守护进程..." : "检测到 Antigravity 已开启 CDP，正在按需附加托管监听...");
                string watcherExe = Path.Combine(installDir, WatcherExeName);
                string watcherArgs = (runMode == "daemon" ? "--watch --dir \"" : "--watch --exit-on-host-close --dir \"") + installDir + "\"";
                if (opts.CdpPort.HasValue && opts.CdpPort.Value > 0)
                {
                    watcherArgs += " --cdp-port " + opts.CdpPort.Value;
                }
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = watcherExe;
                psi.Arguments = watcherArgs;
                psi.WorkingDirectory = installDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(psi);
                result.WatcherStarted = true;

                string pidWaitPath = Path.Combine(installDir, ".watch.pid");
                for (int w = 0; w < 20 && !File.Exists(pidWaitPath); w++)
                {
                    Thread.Sleep(50);
                }

                report(90, "正在检查 Antigravity Desktop 实时注入状态...");
                string watchLogPath = Path.Combine(installDir, "watch.log");
                if (port.HasValue && (cdpReachable || !isExplicitPort))
                {
                    List<CdpPageInfo> pages = null;
                    for (int attempt = 0; attempt < 15; attempt++)
                    {
                        try
                        {
                            pages = CdpHelper.ListPagesAsync(port.Value).GetAwaiter().GetResult();
                            cdpReachable = true;
                            string logContent = "";
                            if (File.Exists(watchLogPath))
                            {
                                using (FileStream fs = new FileStream(watchLogPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                                using (StreamReader sr = new StreamReader(fs, Encoding.UTF8))
                                {
                                    logContent = sr.ReadToEnd();
                                }
                            }
                            bool watcherInjected =
                                logContent.IndexOf("[✓]", StringComparison.Ordinal) >= 0 ||
                                logContent.IndexOf("[↻]", StringComparison.Ordinal) >= 0 ||
                                (File.Exists(Path.Combine(installDir, ".watch.pid")) && attempt >= 2);
                            if (pages != null && pages.Count > 0 && watcherInjected)
                            {
                                bool allReady = true;
                                List<string> titles = new List<string>();
                                for (int p = 0; p < pages.Count; p++)
                                {
                                    titles.Add(CdpHelper.ShortTitle(pages[p]));
                                    using (CdpSession s = CdpSession.ConnectAsync(pages[p].WebSocketDebuggerUrl, 2000).GetAwaiter().GetResult())
                                    {
                                        object okVal = s.EvaluateAsync("Boolean(window.__agClaudeStyle)", false).GetAwaiter().GetResult();
                                        if (!(okVal is bool) || !((bool)okVal))
                                        {
                                            allReady = false;
                                        }
                                    }
                                }
                                if (allReady)
                                {
                                    result.InjectedPages = titles;
                                    break;
                                }
                            }
                        }
                        catch
                        {
                            pages = null;
                            if (!effectiveAgRunning && attempt >= 1)
                            {
                                break;
                            }
                        }
                        Thread.Sleep(350);
                    }
                }
            }
            else
            {
                result.WatcherStarted = false;
                report(88, "免后台常驻模式：当前未检测到运行中的 CDP 会话，不常驻后台进程");
            }
            result.CdpPort = cdpReachable ? port : null;

            bool autoRelaunchEnabled = true;
            if (activeCfg.ContainsKey("autoRelaunchWithCdp") && activeCfg["autoRelaunchWithCdp"] is bool)
            {
                autoRelaunchEnabled = (bool)activeCfg["autoRelaunchWithCdp"];
            }

            result.Ok = true;
            if (result.InjectedPages.Count > 0)
            {
                result.Headline = string.Format("修补成功！已实时注入 {0} 个 Antigravity 窗口", result.InjectedPages.Count);
                result.Detail = runMode == "managed"
                    ? "当前为「免后台常驻」托管模式：已按需附加监听，Antigravity 关闭后自动退出。后续请通过桌面或开始菜单「Antigravity (AGY Claude Style)」快捷方式启动。"
                    : "当前为「开机自启 · 常驻守护」模式：后台无损守护已运行并已配置开机自启，后续打开新窗口或更新 Antigravity 后也会自动注入。";
                for (int i = 0; i < result.InjectedPages.Count; i++)
                {
                    report(98, "已注入窗口: " + result.InjectedPages[i]);
                }
            }
            else if (cdpReachable && port.HasValue)
            {
                result.Headline = runMode == "managed"
                    ? "已安装并按需附加托管监听！等待窗口就绪"
                    : "已安装并启动常驻守护！等待 Antigravity 窗口就绪";
                result.Detail = runMode == "managed"
                    ? "当前为「免后台常驻」模式：检测到调试端口 " + port.Value + "，窗口就绪后将自动注入并在 Antigravity 关闭后退出。"
                    : "当前为「开机自启 · 常驻守护」模式：已配置开机自启，检测到调试端口 " + port.Value + "，窗口就绪后将自动完成注入。";
            }
            else if (effectiveAgRunning)
            {
                result.AntigravityRunningWithoutCdp = true;
                if (runMode == "managed")
                {
                    result.Headline = "安装完成（免后台常驻模式）！当前 Antigravity 未开启 CDP";
                    result.Detail = "平时后台 0 进程常驻。请点击下方「以 CDP 模式重启」立即生效，或关闭后使用桌面/开始菜单「Antigravity (AGY Claude Style)」启动。";
                }
                else
                {
                    result.Headline = "已安装并启动常驻守护！但当前 Antigravity 未开启 CDP 端口";
                    result.Detail = autoRelaunchEnabled
                        ? "当前为「开机自启 · 常驻守护」模式。后台守护已启用自动接管，将在数秒内尝试温和重启；也可点击下方「以 CDP 模式重启」立即生效。"
                        : "当前为「开机自启 · 常驻守护」模式。请点击下方「以 CDP 模式重启」，或通过「Antigravity (AGY Claude Style)」快捷方式启动。";
                }
                report(95, "[!] 检测到 Antigravity 正在运行但未开启 CDP（2.33.0+ 需带参 --remote-debugging-port=0 启动）");
            }
            else
            {
                if (runMode == "managed")
                {
                    result.Headline = "安装成功！（免后台常驻 · 托管模式已就绪）";
                    result.Detail = "后台 0 进程常驻。请通过桌面或开始菜单「Antigravity (AGY Claude Style)」快捷方式（或下方按钮）启动 Antigravity，关闭后监听自动退出。";
                }
                else
                {
                    result.Headline = "安装成功！开机自启与后台常驻守护已就绪";
                    result.Detail = "当前为「开机自启 · 常驻守护」模式：守护进程已在后台待命并已写入 Startup 自启。也可使用「Antigravity (AGY Claude Style)」快捷方式启动。";
                }
            }
            report(100, result.Headline);
            return result;
        }

        public static OperationResult RunUninstall(InstallerOptions opts, Action<int, string> progress)
        {
            OperationResult result = new OperationResult();
            result.Mode = "uninstall";
            string installDir = Path.GetFullPath(string.IsNullOrEmpty(opts.InstallDir) ? GetDefaultInstallDir() : opts.InstallDir).TrimEnd('\\', '/');
            result.InstallDir = installDir;
            result.RunMode = ReadInstalledMode(installDir) ?? "managed";

            Action<int, string> report = (pct, msg) =>
            {
                if (progress != null) progress(pct, msg);
            };

            report(15, "正在停止后台守护进程...");
            StopWatcherInDir(installDir, (m) => report(25, m));

            report(40, "正在通过 CDP 清理运行中的 Antigravity Desktop 界面...");
            int? port = CdpHelper.ReadPort(opts.CdpPort);
            result.CdpPort = port;
            string removeExpr = null;
            if (File.Exists(Path.Combine(installDir, "manifest.json")))
            {
                try { removeExpr = PluginManifest.Load(installDir).RemoveExpression; } catch { }
            }
            if (string.IsNullOrEmpty(removeExpr))
            {
                try
                {
                    using (Stream resStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("AGY_PAYLOAD.zip"))
                    using (ZipArchive archive = new ZipArchive(resStream, ZipArchiveMode.Read))
                    {
                        ZipArchiveEntry entry = archive.GetEntry("manifest.json");
                        if (entry != null)
                        {
                            using (StreamReader sr = new StreamReader(entry.Open(), Encoding.UTF8))
                            {
                                Dictionary<string, object> raw = MiniJson.ParseObject(sr.ReadToEnd());
                                if (raw.ContainsKey("removeExpression")) removeExpr = raw["removeExpression"] as string;
                            }
                        }
                    }
                }
                catch { }
            }

            if (port.HasValue && !string.IsNullOrEmpty(removeExpr))
            {
                try
                {
                    List<CdpPageInfo> pages = CdpHelper.ListPagesAsync(port.Value).GetAwaiter().GetResult();
                    for (int i = 0; i < pages.Count; i++)
                    {
                        try
                        {
                            using (CdpSession s = CdpSession.ConnectAsync(pages[i].WebSocketDebuggerUrl, 3000).GetAwaiter().GetResult())
                            {
                                s.EvaluateAsync(removeExpr, false).GetAwaiter().GetResult();
                                string title = CdpHelper.ShortTitle(pages[i]);
                                result.InjectedPages.Add(title);
                                report(55, "已恢复原生界面: " + title);
                            }
                        }
                        catch { }
                    }
                }
                catch { }
            }

            if (!opts.NoAutostart)
            {
                report(70, "正在移除快捷方式、开机自启与卸载注册表项...");
                try
                {
                    string lnk = GetStartupShortcutPath();
                    if (File.Exists(lnk)) File.Delete(lnk);
                }
                catch { }
                try
                {
                    string launcherLnk = GetStartMenuLauncherShortcutPath();
                    if (File.Exists(launcherLnk)) File.Delete(launcherLnk);
                }
                catch { }
                try
                {
                    string desktopLnk = GetDesktopLauncherShortcutPath();
                    if (File.Exists(desktopLnk)) File.Delete(desktopLnk);
                }
                catch { }
                if (string.IsNullOrEmpty(GetTestSystemRoot()))
                {
                    try
                    {
                        Registry.CurrentUser.DeleteSubKeyTree(UninstallRegSubKey, false);
                    }
                    catch { }
                }
            }
            result.StartupShortcutActive = File.Exists(GetStartupShortcutPath());

            report(85, "正在清理安装目录: " + installDir);
            string selfExe = Assembly.GetExecutingAssembly().Location;
            bool runningInsideInstallDir = !string.IsNullOrEmpty(selfExe) &&
                Path.GetFullPath(selfExe).ToLowerInvariant().StartsWith(installDir.ToLowerInvariant() + "\\", StringComparison.Ordinal);

            if (Directory.Exists(installDir))
            {
                if (!runningInsideInstallDir)
                {
                    try { Directory.Delete(installDir, true); } catch { }
                }
                else
                {
                    string[] files = Directory.GetFiles(installDir, "*", SearchOption.AllDirectories);
                    for (int i = 0; i < files.Length; i++)
                    {
                        if (string.Equals(Path.GetFullPath(files[i]), Path.GetFullPath(selfExe), StringComparison.OrdinalIgnoreCase)) continue;
                        try { File.Delete(files[i]); } catch { }
                    }
                    result.SelfDeleteScheduled = true;
                }
            }

            result.Ok = true;
            result.Headline = "已卸载并恢复 Antigravity Desktop 原生界面";
            result.Detail = result.InjectedPages.Count > 0
                ? string.Format("已停止守护、移除自启，并立即还原了 {0} 个打开的窗口。", result.InjectedPages.Count)
                : "已停止守护、移除开机自启并清理安装文件。";
            report(100, result.Headline);
            return result;
        }

        public static void ScheduleSelfDeleteIfNeeded(string installDir)
        {
            string selfExe = Assembly.GetExecutingAssembly().Location;
            if (string.IsNullOrEmpty(selfExe)) return;
            string escapedExe = selfExe.Replace("'", "''");
            string escapedDir = installDir.Replace("'", "''");
            string psScript = string.Format(
                "$e='{0}';$d='{1}';for($i=0;$i -lt 12;$i++){{Start-Sleep -Milliseconds 350;if(Test-Path -LiteralPath $e){{Remove-Item -LiteralPath $e -Force -ErrorAction SilentlyContinue}};if(Test-Path -LiteralPath $d){{Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue}};if(-not (Test-Path -LiteralPath $d)){{exit 0}}}}",
                escapedExe,
                escapedDir
            );
            string encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(psScript));
            ProcessStartInfo psi = new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " + encoded);
            psi.WorkingDirectory = Path.GetTempPath();
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            try { Process.Start(psi); } catch { }
        }
    }

    internal class InstallerForm : Form
    {
        private readonly InstallerOptions _opts;
        private readonly Label _titleLabel;
        private readonly Label _subtitleLabel;
        private readonly RadioButton _managedRadio;
        private readonly RadioButton _daemonRadio;
        private readonly CheckBox _desktopShortcutCheck;
        private readonly Label _statusHeadline;
        private readonly Label _statusDetail;
        private readonly Label _metaLabel;
        private readonly ProgressBar _progressBar;
        private readonly TextBox _logBox;
        private readonly Button _actionBtn;
        private readonly Button _uninstallBtn;
        private readonly Button _openDirBtn;
        private readonly Button _launchAgBtn;
        private readonly Button _closeBtn;

        private string _activeInstallDir;
        private string _antigravityExe;
        private bool _needsCdpRelaunch;
        private bool _selfDeleteOnClose;
        private bool _busy;

        public InstallerForm(InstallerOptions opts)
        {
            _opts = opts;
            _activeInstallDir = Path.GetFullPath(string.IsNullOrEmpty(opts.InstallDir) ? InstallerCore.GetDefaultInstallDir() : opts.InstallDir).TrimEnd('\\', '/');
            bool isInstalled = Directory.Exists(_activeInstallDir) && File.Exists(Path.Combine(_activeInstallDir, "agy-claude-style-watcher.exe"));
            string initialMode = InstallerCore.ResolveRunMode(opts, _activeInstallDir);

            Text = "AGY Claude Style 安装与模式管理";
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            AutoScaleMode = AutoScaleMode.Font;
            Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Regular);
            ClientSize = new Size(620, 560);
            BackColor = Color.FromArgb(248, 246, 243);
            try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }

            Panel header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = 76;
            header.BackColor = Color.FromArgb(26, 25, 24);
            header.Padding = new Padding(20, 12, 20, 10);

            _titleLabel = new Label();
            _titleLabel.Text = "AGY Claude Style · 无损界面增强安装器";
            _titleLabel.ForeColor = Color.FromArgb(250, 248, 245);
            _titleLabel.Font = new Font("Microsoft YaHei UI", 13.5f, FontStyle.Bold);
            _titleLabel.AutoSize = true;
            _titleLabel.Location = new Point(20, 12);

            _subtitleLabel = new Label();
            _subtitleLabel.Text = "Antigravity Desktop 实时样式增强、思考滑块与 Token HUD";
            _subtitleLabel.ForeColor = Color.FromArgb(217, 119, 87);
            _subtitleLabel.Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular);
            _subtitleLabel.AutoSize = true;
            _subtitleLabel.Location = new Point(21, 44);

            header.Controls.Add(_titleLabel);
            header.Controls.Add(_subtitleLabel);
            Controls.Add(header);

            Panel modePanel = new Panel();
            modePanel.Location = new Point(20, 88);
            modePanel.Size = new Size(580, 114);
            modePanel.BackColor = Color.White;
            modePanel.BorderStyle = BorderStyle.FixedSingle;

            Label modeTitle = new Label();
            modeTitle.Text = "运行模式选择";
            modeTitle.ForeColor = Color.FromArgb(28, 25, 23);
            modeTitle.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
            modeTitle.Location = new Point(14, 10);
            modeTitle.Size = new Size(550, 20);

            _managedRadio = new RadioButton();
            _managedRadio.Text = "免后台常驻 · 随 Antigravity 启动并自动退出（推荐）";
            _managedRadio.ForeColor = Color.FromArgb(41, 37, 36);
            _managedRadio.Location = new Point(14, 34);
            _managedRadio.Size = new Size(550, 22);
            _managedRadio.Checked = (initialMode == "managed");

            _daemonRadio = new RadioButton();
            _daemonRadio.Text = "开机自启 · 后台常驻监听";
            _daemonRadio.ForeColor = Color.FromArgb(41, 37, 36);
            _daemonRadio.Location = new Point(14, 60);
            _daemonRadio.Size = new Size(550, 22);
            _daemonRadio.Checked = (initialMode == "daemon");

            _desktopShortcutCheck = new CheckBox();
            _desktopShortcutCheck.Text = "在桌面创建「Antigravity (AGY Claude Style)」启动快捷方式";
            _desktopShortcutCheck.ForeColor = Color.FromArgb(87, 83, 78);
            _desktopShortcutCheck.Location = new Point(14, 86);
            _desktopShortcutCheck.Size = new Size(550, 22);
            _desktopShortcutCheck.Checked = opts.DesktopShortcut && !opts.NoDesktopShortcut;

            EventHandler onOptionChanged = (s, e) =>
            {
                if (!_busy) _actionBtn.Enabled = true;
            };
            _managedRadio.CheckedChanged += onOptionChanged;
            _daemonRadio.CheckedChanged += onOptionChanged;
            _desktopShortcutCheck.CheckedChanged += onOptionChanged;

            modePanel.Controls.Add(modeTitle);
            modePanel.Controls.Add(_managedRadio);
            modePanel.Controls.Add(_daemonRadio);
            modePanel.Controls.Add(_desktopShortcutCheck);
            Controls.Add(modePanel);

            Panel card = new Panel();
            card.Location = new Point(20, 212);
            card.Size = new Size(580, 112);
            card.BackColor = Color.White;
            card.BorderStyle = BorderStyle.FixedSingle;

            _statusHeadline = new Label();
            if (opts.Uninstall)
            {
                _statusHeadline.Text = "准备卸载并恢复原版界面...";
            }
            else if (isInstalled)
            {
                _statusHeadline.Text = string.Format("当前已安装（{0}）", initialMode == "daemon" ? "开机自启 · 常驻守护" : "免后台常驻 · 托管模式");
            }
            else
            {
                _statusHeadline.Text = "请选择运行模式后点击「开始安装」";
            }
            _statusHeadline.ForeColor = Color.FromArgb(28, 25, 23);
            _statusHeadline.Font = new Font("Microsoft YaHei UI", 11f, FontStyle.Bold);
            _statusHeadline.Location = new Point(14, 10);
            _statusHeadline.Size = new Size(552, 26);

            _statusDetail = new Label();
            _statusDetail.Text = opts.Uninstall
                ? "确认后将停止守护、清理快捷方式并恢复原版界面。"
                : "托管模式不注册开机自启，平时 0 进程常驻；常驻模式适合习惯直接点击原版图标的用户。";
            _statusDetail.ForeColor = Color.FromArgb(87, 83, 78);
            _statusDetail.Location = new Point(14, 40);
            _statusDetail.Size = new Size(552, 42);

            _metaLabel = new Label();
            _metaLabel.Text = "安装路径: " + _activeInstallDir;
            _metaLabel.ForeColor = Color.FromArgb(120, 113, 108);
            _metaLabel.Font = new Font("Microsoft YaHei UI", 8.2f, FontStyle.Regular);
            _metaLabel.Location = new Point(14, 86);
            _metaLabel.Size = new Size(552, 20);

            card.Controls.Add(_statusHeadline);
            card.Controls.Add(_statusDetail);
            card.Controls.Add(_metaLabel);
            Controls.Add(card);

            _progressBar = new ProgressBar();
            _progressBar.Location = new Point(20, 334);
            _progressBar.Size = new Size(580, 14);
            _progressBar.Minimum = 0;
            _progressBar.Maximum = 100;
            _progressBar.Value = 0;
            Controls.Add(_progressBar);

            _logBox = new TextBox();
            _logBox.Location = new Point(20, 358);
            _logBox.Size = new Size(580, 134);
            _logBox.Multiline = true;
            _logBox.ReadOnly = true;
            _logBox.ScrollBars = ScrollBars.Vertical;
            _logBox.BackColor = Color.FromArgb(252, 251, 249);
            _logBox.ForeColor = Color.FromArgb(41, 37, 36);
            _logBox.Font = new Font("Consolas", 8.8f, FontStyle.Regular);
            Controls.Add(_logBox);

            _actionBtn = new Button();
            _actionBtn.Text = isInstalled ? "应用模式 / 升级" : "开始安装";
            _actionBtn.Location = new Point(20, 506);
            _actionBtn.Size = new Size(124, 36);
            _actionBtn.Enabled = !opts.Uninstall;
            _actionBtn.FlatStyle = FlatStyle.System;
            _actionBtn.Click += async (s, e) =>
            {
                SyncOptionsFromUi();
                await ExecuteInstallAsync();
            };

            _uninstallBtn = new Button();
            _uninstallBtn.Text = "卸载并恢复";
            _uninstallBtn.Location = new Point(152, 506);
            _uninstallBtn.Size = new Size(98, 36);
            _uninstallBtn.Enabled = isInstalled && !opts.Uninstall;
            _uninstallBtn.FlatStyle = FlatStyle.System;
            _uninstallBtn.Click += async (s, e) => await HandleUninstallClickAsync();

            _openDirBtn = new Button();
            _openDirBtn.Text = "配置目录";
            _openDirBtn.Location = new Point(258, 506);
            _openDirBtn.Size = new Size(92, 36);
            _openDirBtn.Enabled = Directory.Exists(_activeInstallDir);
            _openDirBtn.FlatStyle = FlatStyle.System;
            _openDirBtn.Click += (s, e) =>
            {
                try
                {
                    if (Directory.Exists(_activeInstallDir)) Process.Start("explorer.exe", _activeInstallDir);
                }
                catch { }
            };

            _launchAgBtn = new Button();
            _launchAgBtn.Text = "启动 Antigravity";
            _launchAgBtn.Location = new Point(358, 506);
            _launchAgBtn.Size = new Size(140, 36);
            _launchAgBtn.Visible = false;
            _launchAgBtn.FlatStyle = FlatStyle.System;
            _launchAgBtn.Click += (s, e) => LaunchManagedAntigravity();

            _closeBtn = new Button();
            _closeBtn.Text = "关闭";
            _closeBtn.Location = new Point(506, 506);
            _closeBtn.Size = new Size(94, 36);
            _closeBtn.Enabled = true;
            _closeBtn.FlatStyle = FlatStyle.System;
            _closeBtn.Click += (s, e) => Close();

            Controls.Add(_actionBtn);
            Controls.Add(_uninstallBtn);
            Controls.Add(_openDirBtn);
            Controls.Add(_launchAgBtn);
            Controls.Add(_closeBtn);

            Shown += async (s, e) => await StartInitialActionAsync();
            FormClosing += (s, e) =>
            {
                if (_busy)
                {
                    e.Cancel = true;
                    return;
                }
                if (_selfDeleteOnClose)
                {
                    InstallerCore.ScheduleSelfDeleteIfNeeded(_activeInstallDir);
                }
            };
        }

        private void SyncOptionsFromUi()
        {
            _opts.RunMode = _daemonRadio.Checked ? "daemon" : "managed";
            _opts.ModeExplicit = true;
            _opts.DesktopShortcut = _desktopShortcutCheck.Checked;
            _opts.NoDesktopShortcut = !_desktopShortcutCheck.Checked;
        }

        private void LaunchManagedAntigravity()
        {
            string cleanDir = Path.GetFullPath(_activeInstallDir).TrimEnd('\\', '/');
            string watcherExe = Path.Combine(cleanDir, "agy-claude-style-watcher.exe");
            if (!File.Exists(watcherExe))
            {
                AppendLog("[!] 未找到托管启动器: " + watcherExe);
                return;
            }
            string launchArgs = "--launch" + (_needsCdpRelaunch ? " --relaunch" : "") + " --exit-on-host-close --dir \"" + cleanDir + "\"";
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = watcherExe;
                psi.Arguments = launchArgs;
                psi.WorkingDirectory = cleanDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(psi);
                _needsCdpRelaunch = false;
                _statusHeadline.Text = "已通过托管启动器拉起 Antigravity";
                _statusHeadline.ForeColor = Color.FromArgb(21, 128, 61);
                _statusDetail.Text = "已附带 --remote-debugging-port=0 启动并拉起按需监听，关闭 Antigravity 后将自动退出。";
                AppendLog("[✓] 已启动托管启动器: " + watcherExe + " " + launchArgs);
            }
            catch (Exception ex)
            {
                AppendLog("[!] 启动 Antigravity 失败: " + ex.Message);
            }
        }

        private void AppendLog(string msg)
        {
            if (IsDisposed || Disposing) return;
            if (InvokeRequired)
            {
                try { BeginInvoke(new Action<string>(AppendLog), msg); } catch { }
                return;
            }
            _logBox.AppendText(string.Format("[{0}] {1}\r\n", DateTime.Now.ToString("HH:mm:ss"), msg));
        }

        private void UpdateProgress(int pct, string msg)
        {
            if (IsDisposed || Disposing) return;
            if (InvokeRequired)
            {
                try { BeginInvoke(new Action<int, string>(UpdateProgress), pct, msg); } catch { }
                return;
            }
            _progressBar.Value = Math.Max(0, Math.Min(100, pct));
            AppendLog(msg);
        }

        private async Task StartInitialActionAsync()
        {
            if (_opts.Uninstall)
            {
                DialogResult dr = MessageBox.Show(
                    this,
                    "确认要卸载 AGY Claude Style 并恢复 Antigravity Desktop 原生界面吗？",
                    "卸载确认",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question
                );
                if (dr != DialogResult.Yes)
                {
                    Close();
                    return;
                }
                await ExecuteUninstallAsync();
                return;
            }

            bool isInstalled = Directory.Exists(_activeInstallDir) && File.Exists(Path.Combine(_activeInstallDir, "agy-claude-style-watcher.exe"));
            if (isInstalled)
            {
                try
                {
                    AntigravityDetectResult ag = await Task.Run(() => InstallerCore.DetectAntigravityDesktop());
                    int? port = CdpHelper.ReadPort(_opts.CdpPort);
                    bool cdpReachable = false;
                    if (port.HasValue)
                    {
                        try
                        {
                            List<CdpPageInfo> pages = await CdpHelper.ListPagesAsync(port.Value);
                            cdpReachable = (pages != null && pages.Count > 0);
                        }
                        catch { }
                    }
                    if (!_busy)
                    {
                        _antigravityExe = ag.ExePath;
                        _needsCdpRelaunch = ag.IsRunning && !cdpReachable;
                        _launchAgBtn.Text = _needsCdpRelaunch ? "以 CDP 模式重启" : "以 CDP 模式启动";
                        _launchAgBtn.Visible = !string.IsNullOrEmpty(_antigravityExe) && !cdpReachable;
                        _launchAgBtn.Enabled = _launchAgBtn.Visible;
                    }
                }
                catch { }
            }
        }

        private async Task ExecuteInstallAsync()
        {
            _busy = true;
            SetControlsEnabled(false);
            try
            {
                OperationResult res = await Task.Run(() => InstallerCore.RunInstall(_opts, UpdateProgress));
                _activeInstallDir = res.InstallDir;
                _antigravityExe = res.AntigravityExe;
                _needsCdpRelaunch = res.AntigravityRunningWithoutCdp;
                _statusHeadline.Text = res.Headline;
                _statusHeadline.ForeColor = res.AntigravityRunningWithoutCdp ? Color.FromArgb(180, 83, 9) : Color.FromArgb(21, 128, 61);
                _statusDetail.Text = res.Detail;
                _metaLabel.Text = "配置: " + res.ConfigSummary;
                _actionBtn.Text = "应用模式 / 升级";
                _openDirBtn.Enabled = Directory.Exists(_activeInstallDir);
                _uninstallBtn.Enabled = true;
                _launchAgBtn.Text = res.AntigravityRunningWithoutCdp ? "以 CDP 模式重启" : "以 CDP 模式启动";
                _launchAgBtn.Visible = (!string.IsNullOrEmpty(_antigravityExe) && res.InjectedPages.Count == 0);
                _launchAgBtn.Enabled = _launchAgBtn.Visible;
                _closeBtn.Text = "完成并关闭";
            }
            catch (Exception ex)
            {
                _statusHeadline.Text = "修补失败";
                _statusHeadline.ForeColor = Color.FromArgb(185, 28, 28);
                _statusDetail.Text = ex.Message;
                AppendLog("[✗] 错误: " + ex);
            }
            finally
            {
                _busy = false;
                _managedRadio.Enabled = true;
                _daemonRadio.Enabled = true;
                _desktopShortcutCheck.Enabled = true;
                _actionBtn.Enabled = true;
                _closeBtn.Enabled = true;
            }
        }

        private async Task HandleUninstallClickAsync()
        {
            DialogResult dr = MessageBox.Show(
                this,
                "确认卸载 AGY Claude Style、停止后台守护并立即恢复 Antigravity 原生界面？",
                "卸载并恢复原版",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question
            );
            if (dr != DialogResult.Yes) return;
            await ExecuteUninstallAsync();
        }

        private async Task ExecuteUninstallAsync()
        {
            _busy = true;
            SetControlsEnabled(false);
            try
            {
                OperationResult res = await Task.Run(() => InstallerCore.RunUninstall(_opts, UpdateProgress));
                _selfDeleteOnClose = res.SelfDeleteScheduled;
                _statusHeadline.Text = res.Headline;
                _statusHeadline.ForeColor = Color.FromArgb(3, 105, 161);
                _statusDetail.Text = res.Detail;
                _metaLabel.Text = "已清理目录: " + res.InstallDir;
                _actionBtn.Text = "开始安装";
                _openDirBtn.Enabled = false;
                _uninstallBtn.Enabled = false;
                _launchAgBtn.Visible = false;
            }
            catch (Exception ex)
            {
                _statusHeadline.Text = "卸载失败";
                _statusHeadline.ForeColor = Color.FromArgb(185, 28, 28);
                _statusDetail.Text = ex.Message;
                AppendLog("[✗] 错误: " + ex);
            }
            finally
            {
                _busy = false;
                _managedRadio.Enabled = true;
                _daemonRadio.Enabled = true;
                _desktopShortcutCheck.Enabled = true;
                _actionBtn.Enabled = true;
                _closeBtn.Enabled = true;
            }
        }

        private void SetControlsEnabled(bool enabled)
        {
            _managedRadio.Enabled = enabled;
            _daemonRadio.Enabled = enabled;
            _desktopShortcutCheck.Enabled = enabled;
            _actionBtn.Enabled = enabled;
            _uninstallBtn.Enabled = enabled;
            _openDirBtn.Enabled = enabled;
            _launchAgBtn.Enabled = enabled;
            _closeBtn.Enabled = enabled;
        }
    }

    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [STAThread]
        private static int Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch { }

            InstallerOptions opts = ParseArgs(args);

            if (opts.StatusOnly)
            {
                string dir = Path.GetFullPath(string.IsNullOrEmpty(opts.InstallDir) ? InstallerCore.GetDefaultInstallDir() : opts.InstallDir).TrimEnd('\\', '/');
                AntigravityDetectResult ag = InstallerCore.DetectAntigravityDesktop();
                int? port = CdpHelper.ReadPort(opts.CdpPort);
                string installedMode = InstallerCore.ReadInstalledMode(dir);
                string runMode = InstallerCore.ResolveRunMode(opts, dir);
                Dictionary<string, object> st = new Dictionary<string, object>(StringComparer.Ordinal);
                st["installed"] = Directory.Exists(dir) && File.Exists(Path.Combine(dir, "agy-claude-style-watcher.exe"));
                st["installDir"] = dir;
                st["installedMode"] = installedMode;
                st["runMode"] = runMode;
                st["watcherStarted"] = InstallerCore.IsWatcherRunningInDir(dir);
                st["startupShortcut"] = File.Exists(InstallerCore.GetStartupShortcutPath());
                st["startMenuShortcut"] = File.Exists(InstallerCore.GetStartMenuLauncherShortcutPath());
                st["desktopShortcut"] = File.Exists(InstallerCore.GetDesktopLauncherShortcutPath());
                st["launcherShortcut"] = File.Exists(Path.Combine(dir, "Antigravity (AGY Claude Style).lnk"));
                st["antigravityExe"] = ag.ExePath;
                st["antigravityVersion"] = ag.Version;
                st["antigravityRunning"] = ag.IsRunning;
                st["cdpPort"] = port.HasValue ? (object)port.Value : null;
                string json = MiniJson.Stringify(st, true);
                if (!string.IsNullOrEmpty(opts.OutFile)) File.WriteAllText(opts.OutFile, json, new UTF8Encoding(false));
                else Console.WriteLine(json);
                return 0;
            }

            if (opts.Silent)
            {
                try
                {
                    OperationResult res = opts.Uninstall
                        ? InstallerCore.RunUninstall(opts, null)
                        : InstallerCore.RunInstall(opts, null);
                    WriteOutFile(opts.OutFile, res);
                    if (opts.Popup)
                    {
                        MessageBox.Show(res.Detail, res.Headline, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                    if (res.SelfDeleteScheduled)
                    {
                        InstallerCore.ScheduleSelfDeleteIfNeeded(res.InstallDir);
                    }
                    return res.Ok ? 0 : 1;
                }
                catch (Exception ex)
                {
                    if (!string.IsNullOrEmpty(opts.OutFile))
                    {
                        Dictionary<string, object> err = new Dictionary<string, object>(StringComparer.Ordinal);
                        err["ok"] = false;
                        err["error"] = ex.Message;
                        File.WriteAllText(opts.OutFile, MiniJson.Stringify(err, true), new UTF8Encoding(false));
                    }
                    if (opts.Popup)
                    {
                        MessageBox.Show(ex.Message, "AGY Claude Style 操作失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }
                    return 1;
                }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm(opts));
            return 0;
        }

        private static InstallerOptions ParseArgs(string[] args)
        {
            InstallerOptions opts = new InstallerOptions();
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (a == "--uninstall") opts.Uninstall = true;
                else if (a == "--silent" || a == "/S" || a == "-s") opts.Silent = true;
                else if (a == "--popup") opts.Popup = true;
                else if (a == "--status") opts.StatusOnly = true;
                else if (a == "--no-autostart") opts.NoAutostart = true;
                else if (a == "--no-kill-legacy") opts.NoKillLegacy = true;
                else if (a == "--managed")
                {
                    opts.RunMode = "managed";
                    opts.ModeExplicit = true;
                }
                else if (a == "--daemon")
                {
                    opts.RunMode = "daemon";
                    opts.ModeExplicit = true;
                }
                else if (a == "--mode" && i + 1 < args.Length)
                {
                    string m = InstallerCore.NormalizeRunMode(args[++i]);
                    if (m != null)
                    {
                        opts.RunMode = m;
                        opts.ModeExplicit = true;
                    }
                }
                else if (a.StartsWith("--mode=", StringComparison.OrdinalIgnoreCase))
                {
                    string m = InstallerCore.NormalizeRunMode(a.Substring("--mode=".Length));
                    if (m != null)
                    {
                        opts.RunMode = m;
                        opts.ModeExplicit = true;
                    }
                }
                else if (a == "--desktop-shortcut")
                {
                    opts.DesktopShortcut = true;
                    opts.NoDesktopShortcut = false;
                }
                else if (a == "--no-desktop-shortcut")
                {
                    opts.DesktopShortcut = false;
                    opts.NoDesktopShortcut = true;
                }
                else if (a == "--install-dir" && i + 1 < args.Length) opts.InstallDir = args[++i];
                else if (a == "--cdp-port" && i + 1 < args.Length)
                {
                    int p;
                    if (int.TryParse(args[++i], out p) && p > 0) opts.CdpPort = p;
                }
                else if (a == "--out" && i + 1 < args.Length) opts.OutFile = args[++i];
            }
            return opts;
        }

        private static void WriteOutFile(string outFile, OperationResult res)
        {
            if (string.IsNullOrEmpty(outFile)) return;
            Dictionary<string, object> d = new Dictionary<string, object>(StringComparer.Ordinal);
            d["ok"] = res.Ok;
            d["mode"] = res.Mode;
            d["runMode"] = res.RunMode;
            d["watcherStarted"] = res.WatcherStarted;
            d["launcherShortcut"] = res.LauncherShortcutPath;
            d["desktopShortcut"] = res.DesktopShortcutPath;
            d["startupShortcut"] = res.StartupShortcutActive;
            d["headline"] = res.Headline;
            d["detail"] = res.Detail;
            d["installDir"] = res.InstallDir;
            d["antigravityExe"] = res.AntigravityExe;
            d["antigravityVersion"] = res.AntigravityVersion;
            d["antigravityRunningWithoutCdp"] = res.AntigravityRunningWithoutCdp;
            d["cdpPort"] = res.CdpPort.HasValue ? (object)res.CdpPort.Value : null;
            d["injectedPages"] = res.InjectedPages;
            d["preservedExistingConfig"] = res.PreservedExistingConfig;
            d["selfDeleteScheduled"] = res.SelfDeleteScheduled;
            File.WriteAllText(outFile, MiniJson.Stringify(d, true), new UTF8Encoding(false));
        }
    }
}
