using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Net.Http;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace AgyClaudeStyle
{
    public class CdpPageInfo
    {
        public string Id;
        public string Title;
        public string Url;
        public string WebSocketDebuggerUrl;
    }

    public class EnsureAntigravityResult
    {
        public bool Ok;
        public string Action;
        public int? Port;
        public string Message;
    }

    public class PluginManifest
    {
        public string Version;
        public string StyleId;
        public string SettingBinding;
        public List<string> Parts;
        public Dictionary<string, object> DefaultConfig;
        public Dictionary<string, object> Validators;
        public string RemoveExpression;

        public static PluginManifest Load(string baseDir)
        {
            string manifestPath = Path.Combine(baseDir, "manifest.json");
            Dictionary<string, object> raw = MiniJson.ParseObject(File.ReadAllText(manifestPath, Encoding.UTF8));
            PluginManifest m = new PluginManifest();
            m.Version = GetString(raw, "version", "2.2.0");
            m.StyleId = GetString(raw, "styleId", "ag-claude-style-css");
            m.SettingBinding = GetString(raw, "settingBinding", "__agClaudeStyleSetting");
            m.RemoveExpression = GetString(raw, "removeExpression", "");
            m.Parts = new List<string>();
            List<object> partsObj = raw.ContainsKey("parts") ? raw["parts"] as List<object> : null;
            if (partsObj != null)
            {
                for (int i = 0; i < partsObj.Count; i++)
                {
                    string s = partsObj[i] as string;
                    if (!string.IsNullOrEmpty(s)) m.Parts.Add(s);
                }
            }
            m.DefaultConfig = raw.ContainsKey("defaultConfig") && raw["defaultConfig"] is Dictionary<string, object>
                ? (Dictionary<string, object>)raw["defaultConfig"]
                : new Dictionary<string, object>(StringComparer.Ordinal);
            m.Validators = raw.ContainsKey("validators") && raw["validators"] is Dictionary<string, object>
                ? (Dictionary<string, object>)raw["validators"]
                : new Dictionary<string, object>(StringComparer.Ordinal);
            return m;
        }

        private static string GetString(Dictionary<string, object> d, string k, string fallback)
        {
            object v;
            if (d.TryGetValue(k, out v) && v is string) return (string)v;
            return fallback;
        }
    }

    public sealed class CdpSession : IDisposable
    {
        private readonly ClientWebSocket _ws;
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);
        private readonly ConcurrentDictionary<int, TaskCompletionSource<Dictionary<string, object>>> _pending =
            new ConcurrentDictionary<int, TaskCompletionSource<Dictionary<string, object>>>();
        private readonly Dictionary<string, List<Action<Dictionary<string, object>>>> _listeners =
            new Dictionary<string, List<Action<Dictionary<string, object>>>>(StringComparer.Ordinal);
        private readonly object _listenerLock = new object();
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private int _nextId = 0;
        private volatile bool _closed = false;

        public Action OnClose;

        private CdpSession(ClientWebSocket ws)
        {
            _ws = ws;
        }

        public static async Task<CdpSession> ConnectAsync(string wsUrl, int timeoutMs)
        {
            ClientWebSocket ws = new ClientWebSocket();
            CancellationTokenSource cts = new CancellationTokenSource(timeoutMs);
            try
            {
                await ws.ConnectAsync(new Uri(wsUrl), cts.Token).ConfigureAwait(false);
                CdpSession session = new CdpSession(ws);
                session.StartReceiveLoop();
                return session;
            }
            catch
            {
                try { ws.Dispose(); } catch { }
                throw;
            }
            finally
            {
                cts.Dispose();
            }
        }

        public void On(string method, Action<Dictionary<string, object>> callback)
        {
            lock (_listenerLock)
            {
                List<Action<Dictionary<string, object>>> list;
                if (!_listeners.TryGetValue(method, out list))
                {
                    list = new List<Action<Dictionary<string, object>>>();
                    _listeners[method] = list;
                }
                list.Add(callback);
            }
        }

        public async Task<Dictionary<string, object>> SendAsync(string method, Dictionary<string, object> parameters, int timeoutMs)
        {
            if (_closed) throw new InvalidOperationException("CDP connection closed");
            int id = Interlocked.Increment(ref _nextId);
            Dictionary<string, object> payload = new Dictionary<string, object>(StringComparer.Ordinal);
            payload["id"] = id;
            payload["method"] = method;
            payload["params"] = parameters ?? new Dictionary<string, object>(StringComparer.Ordinal);
            string json = MiniJson.Stringify(payload, false);
            byte[] bytes = Encoding.UTF8.GetBytes(json);

            TaskCompletionSource<Dictionary<string, object>> tcs =
                new TaskCompletionSource<Dictionary<string, object>>(TaskCreationOptions.RunContinuationsAsynchronously);
            _pending[id] = tcs;

            try
            {
                await _sendLock.WaitAsync(_cts.Token).ConfigureAwait(false);
                try
                {
                    if (_closed) throw new InvalidOperationException("CDP connection closed");
                    const int chunkSize = 65536;
                    int offset = 0;
                    while (offset < bytes.Length)
                    {
                        int count = Math.Min(chunkSize, bytes.Length - offset);
                        bool endOfMessage = (offset + count) >= bytes.Length;
                        await _ws.SendAsync(
                            new ArraySegment<byte>(bytes, offset, count),
                            WebSocketMessageType.Text,
                            endOfMessage,
                            _cts.Token
                        ).ConfigureAwait(false);
                        offset += count;
                    }
                }
                finally
                {
                    _sendLock.Release();
                }

                using (CancellationTokenSource delayCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token))
                {
                    Task delayTask = Task.Delay(timeoutMs, delayCts.Token);
                    Task completed = await Task.WhenAny(tcs.Task, delayTask).ConfigureAwait(false);
                    if (completed == tcs.Task)
                    {
                        delayCts.Cancel();
                        return await tcs.Task.ConfigureAwait(false);
                    }
                }
                TaskCompletionSource<Dictionary<string, object>> removed;
                _pending.TryRemove(id, out removed);
                if (_closed) throw new InvalidOperationException("CDP connection closed");
                throw new TimeoutException("CDP " + method + " timeout");
            }
            catch
            {
                TaskCompletionSource<Dictionary<string, object>> removed;
                _pending.TryRemove(id, out removed);
                throw;
            }
        }

        public async Task<object> EvaluateAsync(string expression, bool awaitPromise)
        {
            Dictionary<string, object> parameters = new Dictionary<string, object>(StringComparer.Ordinal);
            parameters["expression"] = expression;
            parameters["returnByValue"] = true;
            parameters["awaitPromise"] = awaitPromise;
            Dictionary<string, object> res = await SendAsync("Runtime.evaluate", parameters, 15000).ConfigureAwait(false);

            object exObj;
            if (res.TryGetValue("exceptionDetails", out exObj) && exObj is Dictionary<string, object>)
            {
                Dictionary<string, object> exDetails = (Dictionary<string, object>)exObj;
                string msg = null;
                object innerEx;
                if (exDetails.TryGetValue("exception", out innerEx) && innerEx is Dictionary<string, object>)
                {
                    object desc;
                    if (((Dictionary<string, object>)innerEx).TryGetValue("description", out desc) && desc is string)
                    {
                        msg = (string)desc;
                    }
                }
                if (string.IsNullOrEmpty(msg))
                {
                    object text;
                    if (exDetails.TryGetValue("text", out text) && text is string) msg = (string)text;
                }
                throw new Exception(msg ?? "Runtime.evaluate exception");
            }

            object resultObj;
            if (res.TryGetValue("result", out resultObj) && resultObj is Dictionary<string, object>)
            {
                object val;
                if (((Dictionary<string, object>)resultObj).TryGetValue("value", out val)) return val;
            }
            return null;
        }

        private void StartReceiveLoop()
        {
            Task.Run(async () =>
            {
                byte[] buffer = new byte[65536];
                MemoryStream ms = new MemoryStream();
                try
                {
                    while (!_cts.IsCancellationRequested && _ws.State == WebSocketState.Open)
                    {
                        ms.SetLength(0);
                        WebSocketReceiveResult result;
                        do
                        {
                            result = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), _cts.Token).ConfigureAwait(false);
                            if (result.MessageType == WebSocketMessageType.Close)
                            {
                                return;
                            }
                            if (result.Count > 0)
                            {
                                ms.Write(buffer, 0, result.Count);
                            }
                            else if (result.EndOfMessage && _ws.State != WebSocketState.Open)
                            {
                                return;
                            }
                        } while (!result.EndOfMessage);

                        if (result.MessageType == WebSocketMessageType.Text && ms.Length > 0)
                        {
                            string text = Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
                            HandleMessage(text);
                        }
                    }
                }
                catch
                {
                }
                finally
                {
                    ms.Dispose();
                    MarkClosed();
                }
            });
        }

        private void HandleMessage(string text)
        {
            Dictionary<string, object> msg;
            try
            {
                msg = MiniJson.ParseObject(text);
            }
            catch
            {
                return;
            }

            object methodObj;
            if (msg.TryGetValue("method", out methodObj) && methodObj is string)
            {
                string method = (string)methodObj;
                Dictionary<string, object> p = msg.ContainsKey("params") && msg["params"] is Dictionary<string, object>
                    ? (Dictionary<string, object>)msg["params"]
                    : new Dictionary<string, object>(StringComparer.Ordinal);
                List<Action<Dictionary<string, object>>> snapshot = null;
                lock (_listenerLock)
                {
                    List<Action<Dictionary<string, object>>> list;
                    if (_listeners.TryGetValue(method, out list) && list.Count > 0)
                    {
                        snapshot = new List<Action<Dictionary<string, object>>>(list);
                    }
                }
                if (snapshot != null)
                {
                    for (int i = 0; i < snapshot.Count; i++)
                    {
                        try { snapshot[i](p); } catch { }
                    }
                }
                return;
            }

            object idObj;
            if (msg.TryGetValue("id", out idObj) && idObj != null)
            {
                int id = Convert.ToInt32(idObj);
                TaskCompletionSource<Dictionary<string, object>> tcs;
                if (_pending.TryRemove(id, out tcs))
                {
                    object errObj;
                    if (msg.TryGetValue("error", out errObj) && errObj != null)
                    {
                        string errMsg = null;
                        Dictionary<string, object> errDict = errObj as Dictionary<string, object>;
                        if (errDict != null && errDict.ContainsKey("message")) errMsg = errDict["message"] as string;
                        if (string.IsNullOrEmpty(errMsg)) errMsg = MiniJson.Stringify(errObj, false);
                        tcs.TrySetException(new Exception(errMsg));
                    }
                    else
                    {
                        Dictionary<string, object> resDict = msg.ContainsKey("result") && msg["result"] is Dictionary<string, object>
                            ? (Dictionary<string, object>)msg["result"]
                            : new Dictionary<string, object>(StringComparer.Ordinal);
                        tcs.TrySetResult(resDict);
                    }
                }
            }
        }

        private void MarkClosed()
        {
            if (_closed) return;
            _closed = true;
            foreach (KeyValuePair<int, TaskCompletionSource<Dictionary<string, object>>> kv in _pending)
            {
                TaskCompletionSource<Dictionary<string, object>> tcs;
                if (_pending.TryRemove(kv.Key, out tcs))
                {
                    tcs.TrySetException(new Exception("CDP connection closed"));
                }
            }
            Action cb = OnClose;
            if (cb != null)
            {
                try { cb(); } catch { }
            }
        }

        public void Close()
        {
            MarkClosed();
            try { _cts.Cancel(); } catch { }
            try
            {
                if (_ws.State == WebSocketState.Open)
                {
                    _ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None).Wait(300);
                }
            }
            catch { }
            try { _ws.Dispose(); } catch { }
        }

        public void Dispose()
        {
            Close();
            try { _cts.Dispose(); } catch { }
            try { _sendLock.Dispose(); } catch { }
        }
    }

    public static class CdpHelper
    {
        public const int DefaultStartupGraceSeconds = 90;
        private const int SW_RESTORE = 9;
        private static readonly HttpClient SharedHttp = new HttpClient { Timeout = TimeSpan.FromMilliseconds(2000) };

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        public static string GetPortFilePath()
        {
            string appData = Environment.GetEnvironmentVariable("APPDATA");
            if (string.IsNullOrEmpty(appData))
            {
                appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            }
            return Path.Combine(appData, "Antigravity", "DevToolsActivePort");
        }

        public static int? ReadPort(int? overridePort)
        {
            if (overridePort.HasValue && overridePort.Value > 0) return overridePort.Value;
            string envPort = Environment.GetEnvironmentVariable("AG_CDP_PORT");
            if (!string.IsNullOrEmpty(envPort))
            {
                int p;
                if (int.TryParse(envPort.Trim(), out p) && p > 0) return p;
            }
            try
            {
                string portFile = GetPortFilePath();
                if (!File.Exists(portFile)) return null;
                string[] lines = File.ReadAllLines(portFile, Encoding.UTF8);
                if (lines.Length == 0) return null;
                int p;
                if (int.TryParse(lines[0].Trim(), out p) && p > 0) return p;
            }
            catch { }
            return null;
        }

        public static async Task<List<CdpPageInfo>> ListPagesAsync(int port)
        {
            string url = string.Format("http://127.0.0.1:{0}/json/list", port);
            string json = await SharedHttp.GetStringAsync(url).ConfigureAwait(false);
            List<object> targets = MiniJson.ParseArray(json);
            List<CdpPageInfo> pages = new List<CdpPageInfo>();
            for (int i = 0; i < targets.Count; i++)
            {
                Dictionary<string, object> t = targets[i] as Dictionary<string, object>;
                if (t == null) continue;
                string type = GetStr(t, "type");
                string wsUrl = GetStr(t, "webSocketDebuggerUrl");
                string pageUrl = GetStr(t, "url") ?? "";
                bool isPage = type == "page";
                bool isSwarmSidecar = type == "iframe" &&
                    pageUrl.StartsWith("plugin://swarm--", StringComparison.OrdinalIgnoreCase);
                if ((isPage || isSwarmSidecar) &&
                    !string.IsNullOrEmpty(wsUrl) &&
                    !pageUrl.StartsWith("devtools://", StringComparison.OrdinalIgnoreCase) &&
                    !pageUrl.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
                {
                    CdpPageInfo info = new CdpPageInfo();
                    info.Id = GetStr(t, "id") ?? wsUrl;
                    info.Title = GetStr(t, "title") ?? "";
                    info.Url = pageUrl;
                    info.WebSocketDebuggerUrl = wsUrl;
                    pages.Add(info);
                }
            }
            return pages;
        }

        public static Dictionary<string, object> ReadConfig(string baseDir, PluginManifest manifest)
        {
            Dictionary<string, object> cfg = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (KeyValuePair<string, object> kv in manifest.DefaultConfig)
            {
                cfg[kv.Key] = kv.Value;
            }
            try
            {
                string cfgPath = Path.Combine(baseDir, "config.json");
                if (File.Exists(cfgPath))
                {
                    Dictionary<string, object> userCfg = MiniJson.ParseObject(File.ReadAllText(cfgPath, Encoding.UTF8));
                    foreach (KeyValuePair<string, object> kv in userCfg)
                    {
                        cfg[kv.Key] = kv.Value;
                    }
                }
            }
            catch { }
            return cfg;
        }

        public static bool UpdateConfigSetting(string baseDir, PluginManifest manifest, string key, object value)
        {
            object rule;
            if (!manifest.Validators.TryGetValue(key, out rule)) return false;
            string ruleStr = rule as string;
            if (ruleStr == "boolean")
            {
                if (!(value is bool)) return false;
            }
            else if (rule is List<object>)
            {
                string strVal = value as string;
                if (strVal == null) return false;
                List<object> allowed = (List<object>)rule;
                bool matched = false;
                for (int i = 0; i < allowed.Count; i++)
                {
                    if (string.Equals(allowed[i] as string, strVal, StringComparison.Ordinal))
                    {
                        matched = true;
                        break;
                    }
                }
                if (!matched) return false;
            }
            else
            {
                return false;
            }

            Dictionary<string, object> next = ReadConfig(baseDir, manifest);
            next[key] = value;
            string cfgPath = Path.Combine(baseDir, "config.json");
            string tmpPath = cfgPath + ".tmp";
            string content = MiniJson.Stringify(next, true) + "\n";
            try
            {
                File.WriteAllText(tmpPath, content, new UTF8Encoding(false));
                if (File.Exists(cfgPath))
                {
                    File.Replace(tmpPath, cfgPath, null);
                }
                else
                {
                    File.Move(tmpPath, cfgPath);
                }
                return true;
            }
            catch
            {
                try { if (File.Exists(tmpPath)) File.Delete(tmpPath); } catch { }
                return false;
            }
        }

        public static string ComputeHash(string str)
        {
            unchecked
            {
                uint h = 2166136261u;
                for (int i = 0; i < str.Length; i++)
                {
                    h ^= (uint)str[i];
                    h *= 16777619u;
                }
                return ToBase36(h);
            }
        }

        private static string ToBase36(uint value)
        {
            const string digits = "0123456789abcdefghijklmnopqrstuvwxyz";
            if (value == 0) return "0";
            char[] buf = new char[8];
            int pos = buf.Length;
            while (value > 0)
            {
                buf[--pos] = digits[(int)(value % 36u)];
                value /= 36u;
            }
            return new string(buf, pos, buf.Length - pos);
        }

        public static string ReadRuntimeBundle(string baseDir, PluginManifest manifest)
        {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < manifest.Parts.Count; i++)
            {
                if (i > 0) sb.Append('\n');
                sb.Append(File.ReadAllText(Path.Combine(baseDir, manifest.Parts[i]), Encoding.UTF8));
            }
            return sb.ToString();
        }

        public static void ReadBundleAndCssHashes(string baseDir, PluginManifest manifest, out string codeHash, out string cssHash)
        {
            string css = File.ReadAllText(Path.Combine(baseDir, "style.css"), Encoding.UTF8);
            string bundle = ReadRuntimeBundle(baseDir, manifest);
            codeHash = ComputeHash(bundle);
            cssHash = ComputeHash(css);
        }

        public static string BuildConfigScriptExpression(string baseDir, PluginManifest manifest, string expectedCodeHash)
        {
            Dictionary<string, object> config = ReadConfig(baseDir, manifest);
            string expected = expectedCodeHash ?? "";
            Dictionary<string, object> payload = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (KeyValuePair<string, object> kv in config)
            {
                payload[kv.Key] = kv.Value;
            }
            payload["binding"] = manifest.SettingBinding;
            payload["codeHash"] = expected;

            string payloadJson = MiniJson.Stringify(payload, false);
            string hashJson = MiniJson.StringifyString(expected);
            string verJson = MiniJson.StringifyString(manifest.Version);
            return "(() => {\n" +
                "    const nextCfg = " + payloadJson + ";\n" +
                "    globalThis.__agCsOverrideConfig = nextCfg;\n" +
                "    if (\n" +
                "      window.__agClaudeStyle &&\n" +
                "      typeof window.__agClaudeStyle.refreshConfig === 'function' &&\n" +
                "      (!" + hashJson + " || window.__agClaudeStyle.codeHash === " + hashJson + ")\n" +
                "    ) {\n" +
                "      window.__agClaudeStyle.refreshConfig(nextCfg);\n" +
                "      return {\n" +
                "        version: " + verJson + ",\n" +
                "        status: 'refreshed',\n" +
                "        state: window.__agClaudeStyle.getState ? window.__agClaudeStyle.getState() : null,\n" +
                "      };\n" +
                "    }\n" +
                "    return null;\n" +
                "  })()";
        }

        public static string BuildInjectExpression(string baseDir, PluginManifest manifest)
        {
            Dictionary<string, object> config = ReadConfig(baseDir, manifest);
            string css = File.ReadAllText(Path.Combine(baseDir, "style.css"), Encoding.UTF8);
            string bundle = ReadRuntimeBundle(baseDir, manifest);
            string codeHash = ComputeHash(bundle);

            Dictionary<string, object> initCfg = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (KeyValuePair<string, object> kv in config)
            {
                initCfg[kv.Key] = kv.Value;
            }
            initCfg["binding"] = manifest.SettingBinding;
            initCfg["codeHash"] = codeHash;

            string styleIdJson = MiniJson.StringifyString(manifest.StyleId);
            StringBuilder sb = new StringBuilder(css.Length + bundle.Length + 4096);
            sb.Append("(() => {\n");
            sb.Append("    const css = ");
            sb.Append(MiniJson.StringifyString(css));
            sb.Append(";\n");
            sb.Append("    const applyStyle = () => {\n");
            sb.Append("      const targetParent = document.head || document.documentElement;\n");
            sb.Append("      if (!targetParent) return;\n");
            sb.Append("      let style = document.getElementById(").Append(styleIdJson).Append(");\n");
            sb.Append("      if (!style) {\n");
            sb.Append("        style = document.createElement('style');\n");
            sb.Append("        style.id = ").Append(styleIdJson).Append(";\n");
            sb.Append("      }\n");
            sb.Append("      if (style.textContent !== css) style.textContent = css;\n");
            sb.Append("      if (style.parentNode !== targetParent || targetParent.lastElementChild !== style) {\n");
            sb.Append("        targetParent.appendChild(style);\n");
            sb.Append("      }\n");
            sb.Append("    };\n\n");
            sb.Append("    let status = 'ok';\n");
            sb.Append("    let mounted = false;\n");
            sb.Append("    const mount = () => {\n");
            sb.Append("      if (mounted || !document.documentElement) return;\n");
            sb.Append("      mounted = true;\n");
            sb.Append("      try {\n");
            sb.Append("        const isSidecar = typeof location !== 'undefined' && location.protocol === 'plugin:';\n");
            sb.Append("        if (!isSidecar) {\n");
            sb.Append("          if (document.head) applyStyle();\n");
            sb.Append("          else document.addEventListener('DOMContentLoaded', applyStyle, { once: true });\n");
            sb.Append("        }\n");
            sb.Append("        ").Append(bundle).Append('\n');
            sb.Append("        if (typeof globalThis.__agCsUiMain === 'function') {\n");
            sb.Append("          const baseCfg = ").Append(MiniJson.Stringify(initCfg, false)).Append(";\n");
            sb.Append("          const ov = globalThis.__agCsOverrideConfig;\n");
            sb.Append("          const nextCfg = (ov && typeof ov === 'object' && ov.codeHash === baseCfg.codeHash) ? Object.assign({}, baseCfg, ov, { binding: baseCfg.binding, codeHash: baseCfg.codeHash }) : baseCfg;\n");
            sb.Append("          globalThis.__agCsUiMain(nextCfg);\n");
            sb.Append("        }\n");
            sb.Append("      } catch (e) {\n");
            sb.Append("        status = 'error: ' + (e && e.message ? e.message : String(e));\n");
            sb.Append("        if (typeof console !== 'undefined' && console.error) {\n");
            sb.Append("          console.error('[agy-claude-style] init error:', e);\n");
            sb.Append("        }\n");
            sb.Append("      }\n");
            sb.Append("    };\n\n");
            sb.Append("    if (document.documentElement) {\n");
            sb.Append("      mount();\n");
            sb.Append("    } else {\n");
            sb.Append("      status = 'deferred';\n");
            sb.Append("      const onReady = () => {\n");
            sb.Append("        if (document.documentElement) {\n");
            sb.Append("          document.removeEventListener('readystatechange', onReady);\n");
            sb.Append("          document.removeEventListener('DOMContentLoaded', onReady);\n");
            sb.Append("          mount();\n");
            sb.Append("        }\n");
            sb.Append("      };\n");
            sb.Append("      document.addEventListener('readystatechange', onReady);\n");
            sb.Append("      document.addEventListener('DOMContentLoaded', onReady);\n");
            sb.Append("    }\n");
            sb.Append("    const st = window.__agClaudeStyle && window.__agClaudeStyle.getState ? window.__agClaudeStyle.getState() : null;\n");
            sb.Append("    return {\n");
            sb.Append("      version: ").Append(MiniJson.StringifyString(manifest.Version)).Append(",\n");
            sb.Append("      status,\n");
            sb.Append("      state: st,\n");
            sb.Append("    };\n");
            sb.Append("  })()");
            return sb.ToString();
        }

        public static string ShortTitle(CdpPageInfo page)
        {
            string t = !string.IsNullOrEmpty(page.Title) ? page.Title : (page.Url ?? "");
            return t.Length > 60 ? t.Substring(0, 57) + "..." : t;
        }

        public enum WatcherPidStatus
        {
            Dead,
            Owned,
            Foreign,
            Unknown
        }

        public class WatcherPidClassification
        {
            public WatcherPidStatus Status;
            public int Pid;
            public string ExecutablePath;
            public string CommandLine;
        }

        public static List<string> SplitCommandArgs(string cmdLine)
        {
            List<string> args = new List<string>();
            if (string.IsNullOrWhiteSpace(cmdLine)) return args;
            StringBuilder cur = new StringBuilder();
            char quote = '\0';
            for (int i = 0; i < cmdLine.Length; i++)
            {
                char ch = cmdLine[i];
                if (quote != '\0')
                {
                    if (ch == '\\' && quote == '"' && i + 1 < cmdLine.Length && (cmdLine[i + 1] == '"' || cmdLine[i + 1] == '\\'))
                    {
                        cur.Append(cmdLine[++i]);
                    }
                    else if (ch == quote)
                    {
                        quote = '\0';
                    }
                    else
                    {
                        cur.Append(ch);
                    }
                    continue;
                }
                if (ch == '"' || ch == '\'')
                {
                    quote = ch;
                }
                else if (char.IsWhiteSpace(ch))
                {
                    if (cur.Length > 0)
                    {
                        args.Add(cur.ToString());
                        cur.Clear();
                    }
                }
                else
                {
                    cur.Append(ch);
                }
            }
            if (cur.Length > 0) args.Add(cur.ToString());
            return args;
        }

        public static string NormalizeWindowsPath(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return "";
            try
            {
                string full = Path.GetFullPath(path).TrimEnd('\\', '/');
                return full.ToLowerInvariant();
            }
            catch
            {
                return path.Trim().TrimEnd('\\', '/').ToLowerInvariant();
            }
        }

        public static WatcherPidStatus EvaluateWatcherOwnership(string exePath, string cmdLine, string baseDir)
        {
            if (string.IsNullOrWhiteSpace(cmdLine) || string.IsNullOrWhiteSpace(baseDir)) return WatcherPidStatus.Unknown;
            try
            {
                List<string> args = SplitCommandArgs(cmdLine);
                if (args.Count == 0) return WatcherPidStatus.Unknown;

                bool hasWatch = false;
                for (int i = 0; i < args.Count; i++)
                {
                    if (string.Equals(args[i], "--once", StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(args[i], "--remove", StringComparison.OrdinalIgnoreCase))
                    {
                        return WatcherPidStatus.Foreign;
                    }
                    if (string.Equals(args[i], "--watch", StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(args[i], "--managed", StringComparison.OrdinalIgnoreCase))
                    {
                        hasWatch = true;
                    }
                }

                string normDir = NormalizeWindowsPath(baseDir);
                string exeName = !string.IsNullOrEmpty(exePath) ? Path.GetFileName(exePath) : Path.GetFileName(args[0]);

                if (string.Equals(exeName, "agy-claude-style-watcher.exe", StringComparison.OrdinalIgnoreCase))
                {
                    for (int i = 1; i < args.Count; i++)
                    {
                        if (string.Equals(args[i], "--dir", StringComparison.OrdinalIgnoreCase))
                        {
                            if (i + 1 >= args.Count || string.IsNullOrEmpty(args[i + 1])) return WatcherPidStatus.Foreign;
                            if (!Path.IsPathRooted(args[i + 1])) return WatcherPidStatus.Unknown;
                            return string.Equals(NormalizeWindowsPath(args[i + 1]), normDir, StringComparison.OrdinalIgnoreCase)
                                ? WatcherPidStatus.Owned
                                : WatcherPidStatus.Foreign;
                        }
                        if (args[i].StartsWith("--dir=", StringComparison.OrdinalIgnoreCase))
                        {
                            string val = args[i].Substring(6);
                            if (string.IsNullOrEmpty(val)) return WatcherPidStatus.Foreign;
                            if (!Path.IsPathRooted(val)) return WatcherPidStatus.Unknown;
                            return string.Equals(NormalizeWindowsPath(val), normDir, StringComparison.OrdinalIgnoreCase)
                                ? WatcherPidStatus.Owned
                                : WatcherPidStatus.Foreign;
                        }
                    }
                    string resolvedExe = !string.IsNullOrEmpty(exePath) ? exePath : args[0];
                    if (string.IsNullOrEmpty(resolvedExe) || !Path.IsPathRooted(resolvedExe)) return WatcherPidStatus.Unknown;
                    return string.Equals(NormalizeWindowsPath(Path.GetDirectoryName(resolvedExe)), normDir, StringComparison.OrdinalIgnoreCase)
                        ? WatcherPidStatus.Owned
                        : WatcherPidStatus.Foreign;
                }

                if (!hasWatch) return WatcherPidStatus.Foreign;
                string lowerExe = (exeName ?? "").ToLowerInvariant();
                bool isNodeBin =
                    lowerExe == "node.exe" ||
                    lowerExe == "node" ||
                    lowerExe == "nodejs.exe" ||
                    lowerExe == "electron.exe" ||
                    lowerExe == "antigravity.exe";
                if (!isNodeBin) return WatcherPidStatus.Foreign;

                if (args.Count < 2 || string.IsNullOrEmpty(args[1])) return WatcherPidStatus.Foreign;
                string entryScript = args[1];
                if (entryScript.StartsWith("-", StringComparison.Ordinal))
                {
                    string lt = entryScript.ToLowerInvariant();
                    if (lt == "-e" || lt == "--eval" || lt == "-p" || lt == "--print" ||
                        lt == "-i" || lt == "--interactive" || lt == "-c" || lt == "--check" ||
                        lt == "-h" || lt == "--help" || lt == "-v" || lt == "--version")
                    {
                        return WatcherPidStatus.Foreign;
                    }
                    // Fail closed on unknown pre-script flags (e.g. --require / preload) without exhaustive Node CLI parsing.
                    return WatcherPidStatus.Unknown;
                }

                if (!string.Equals(Path.GetFileName(entryScript), "inject.js", StringComparison.OrdinalIgnoreCase))
                {
                    return WatcherPidStatus.Foreign;
                }
                if (!Path.IsPathRooted(entryScript))
                {
                    return WatcherPidStatus.Unknown;
                }
                string expectedScript = NormalizeWindowsPath(Path.Combine(normDir, "inject.js"));
                return string.Equals(NormalizeWindowsPath(entryScript), expectedScript, StringComparison.OrdinalIgnoreCase)
                    ? WatcherPidStatus.Owned
                    : WatcherPidStatus.Foreign;
            }
            catch
            {
                return WatcherPidStatus.Unknown;
            }
        }

        public static bool MatchesWatcherForDir(string exePath, string cmdLine, string baseDir)
        {
            return EvaluateWatcherOwnership(exePath, cmdLine, baseDir) == WatcherPidStatus.Owned;
        }

        public static WatcherPidClassification ClassifyWatcherPid(int pid, string baseDir)
        {
            WatcherPidClassification res = new WatcherPidClassification();
            res.Pid = pid;
            res.Status = WatcherPidStatus.Unknown;

            if (pid <= 0 || !IsProcessAlive(pid))
            {
                res.Status = WatcherPidStatus.Dead;
                return res;
            }

            string exePath = null;
            string cmdLine = null;
            bool queried = false;
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE ProcessId = " + pid))
                {
                    foreach (ManagementObject obj in searcher.Get())
                    {
                        try
                        {
                            queried = true;
                            exePath = obj["ExecutablePath"] as string;
                            cmdLine = obj["CommandLine"] as string;
                            break;
                        }
                        finally
                        {
                            obj.Dispose();
                        }
                    }
                }
            }
            catch
            {
                res.Status = IsProcessAlive(pid) ? WatcherPidStatus.Unknown : WatcherPidStatus.Dead;
                return res;
            }

            if (!queried || string.IsNullOrWhiteSpace(cmdLine))
            {
                res.Status = IsProcessAlive(pid) ? WatcherPidStatus.Unknown : WatcherPidStatus.Dead;
                return res;
            }

            res.ExecutablePath = exePath;
            res.CommandLine = cmdLine;
            res.Status = EvaluateWatcherOwnership(exePath, cmdLine, baseDir);
            return res;
        }

        public static bool IsProcessAlive(int pid)
        {
            if (pid <= 0) return false;
            try
            {
                using (Process p = Process.GetProcessById(pid))
                {
                    return !p.HasExited;
                }
            }
            catch
            {
                return false;
            }
        }

        public static List<int> GetAntigravityProcessIds()
        {
            List<int> pids = new List<int>();
            try
            {
                Process[] procs = Process.GetProcessesByName("Antigravity");
                for (int i = 0; i < procs.Length; i++)
                {
                    try
                    {
                        pids.Add(procs[i].Id);
                    }
                    catch { }
                    finally
                    {
                        try { procs[i].Dispose(); } catch { }
                    }
                }
            }
            catch { }
            pids.Sort();
            return pids;
        }

        public static bool HasAntigravityCdpFlag()
        {
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "SELECT CommandLine FROM Win32_Process WHERE Name = 'Antigravity.exe'"))
                using (ManagementObjectCollection results = searcher.Get())
                {
                    foreach (ManagementBaseObject obj in results)
                    {
                        try
                        {
                            string cmd = obj["CommandLine"] as string;
                            if (!string.IsNullOrEmpty(cmd) &&
                                cmd.IndexOf("--remote-debugging-port", StringComparison.OrdinalIgnoreCase) >= 0)
                            {
                                return true;
                            }
                        }
                        catch { }
                        finally
                        {
                            try { obj.Dispose(); } catch { }
                        }
                    }
                }
            }
            catch { }
            return false;
        }

        public static string FindAntigravityExePath()
        {
            try
            {
                Process[] procs = Process.GetProcessesByName("Antigravity");
                for (int i = 0; i < procs.Length; i++)
                {
                    try
                    {
                        string p = procs[i].MainModule.FileName;
                        if (!string.IsNullOrEmpty(p) && File.Exists(p)) return p;
                    }
                    catch { }
                    finally
                    {
                        try { procs[i].Dispose(); } catch { }
                    }
                }
            }
            catch { }

            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string progFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string progFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string[] candidates = new string[]
            {
                string.IsNullOrEmpty(localAppData) ? null : Path.Combine(localAppData, "Programs", "antigravity", "Antigravity.exe"),
                string.IsNullOrEmpty(progFiles) ? null : Path.Combine(progFiles, "Antigravity", "Antigravity.exe"),
                string.IsNullOrEmpty(progFilesX86) ? null : Path.Combine(progFilesX86, "Antigravity", "Antigravity.exe")
            };
            for (int i = 0; i < candidates.Length; i++)
            {
                if (!string.IsNullOrEmpty(candidates[i]) && File.Exists(candidates[i]))
                {
                    return candidates[i];
                }
            }
            return null;
        }

        public static void RemoveStalePortFile()
        {
            try
            {
                string portFile = GetPortFilePath();
                if (File.Exists(portFile)) File.Delete(portFile);
            }
            catch { }
        }

        public static bool ActivateAntigravityWindow()
        {
            bool activated = false;
            try
            {
                Process[] procs = Process.GetProcessesByName("Antigravity");
                for (int i = 0; i < procs.Length; i++)
                {
                    try
                    {
                        if (!activated)
                        {
                            IntPtr hWnd = procs[i].MainWindowHandle;
                            if (hWnd != IntPtr.Zero)
                            {
                                if (IsIconic(hWnd))
                                {
                                    ShowWindow(hWnd, SW_RESTORE);
                                }
                                SetForegroundWindow(hWnd);
                                activated = true;
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
            return activated;
        }

        public static bool LaunchAntigravityWithCdp(string exePath, int port)
        {
            string target = !string.IsNullOrEmpty(exePath) ? exePath : FindAntigravityExePath();
            if (string.IsNullOrEmpty(target) || !File.Exists(target)) return false;
            try
            {
                if (GetAntigravityProcessIds().Count == 0)
                {
                    RemoveStalePortFile();
                }
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = target;
                psi.Arguments = "--remote-debugging-port=" + Math.Max(0, port);
                psi.WorkingDirectory = Path.GetDirectoryName(target);
                psi.UseShellExecute = true;
                Process.Start(psi);
                return true;
            }
            catch
            {
                return false;
            }
        }

        public static bool RelaunchAntigravityWithCdp(string exePath, int port, int waitMs)
        {
            string target = !string.IsNullOrEmpty(exePath) ? exePath : FindAntigravityExePath();
            if (string.IsNullOrEmpty(target) || !File.Exists(target)) return false;

            try
            {
                Process[] procs = Process.GetProcessesByName("Antigravity");
                for (int i = 0; i < procs.Length; i++)
                {
                    try
                    {
                        if (procs[i].MainWindowHandle != IntPtr.Zero)
                        {
                            procs[i].CloseMainWindow();
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

            DateTime deadline = DateTime.UtcNow.AddMilliseconds(waitMs > 0 ? waitMs : 8000);
            while (DateTime.UtcNow < deadline)
            {
                if (GetAntigravityProcessIds().Count == 0) break;
                Thread.Sleep(250);
            }
            if (GetAntigravityProcessIds().Count > 0)
            {
                return false;
            }
            RemoveStalePortFile();
            return LaunchAntigravityWithCdp(target, port);
        }

        public static async Task<EnsureAntigravityResult> EnsureAntigravityWithCdpAsync(
            string exePath,
            bool allowRelaunch,
            int? overridePort,
            int waitMs)
        {
            EnsureAntigravityResult result = new EnsureAntigravityResult();
            int? port = ReadPort(overridePort);
            if (port.HasValue)
            {
                try
                {
                    List<CdpPageInfo> pages = await ListPagesAsync(port.Value).ConfigureAwait(false);
                    if (pages != null && pages.Count > 0)
                    {
                        ActivateAntigravityWindow();
                        result.Ok = true;
                        result.Action = "already-cdp";
                        result.Port = port.Value;
                        result.Message = "Antigravity 已在 CDP 调试模式运行 (端口 " + port.Value + ")";
                        return result;
                    }
                }
                catch { }
            }

            List<int> pids = GetAntigravityProcessIds();
            if (pids.Count > 0)
            {
                if (HasAntigravityCdpFlag())
                {
                    ActivateAntigravityWindow();
                    result.Ok = true;
                    result.Action = "waiting-cdp";
                    result.Port = null;
                    result.Message = "检测到 Antigravity 已携带 --remote-debugging-port 参数，正在等待调试端口就绪...";
                    return result;
                }
                if (allowRelaunch)
                {
                    bool relaunched = RelaunchAntigravityWithCdp(exePath, 0, waitMs);
                    if (relaunched)
                    {
                        result.Ok = true;
                        result.Action = "relaunched";
                        result.Port = null;
                        result.Message = "已温和重启 Antigravity 并启用 --remote-debugging-port=0";
                    }
                    else
                    {
                        result.Ok = false;
                        result.Action = "relaunch-failed";
                        result.Port = null;
                        result.Message = "未能自动重启正在运行的 Antigravity（可能存在未保存更改）。请先完全退出 Antigravity 后重试。";
                    }
                    return result;
                }
                result.Ok = false;
                result.Action = "running-without-cdp";
                result.Port = null;
                result.Message = CdpUnavailableMessage(true, port);
                return result;
            }

            bool launched = LaunchAntigravityWithCdp(exePath, 0);
            if (launched)
            {
                result.Ok = true;
                result.Action = "launched";
                result.Port = null;
                result.Message = "已以 --remote-debugging-port=0 启动 Antigravity";
            }
            else
            {
                result.Ok = false;
                result.Action = "executable-not-found";
                result.Port = null;
                result.Message = "未找到 Antigravity.exe，请确认已安装 Antigravity Desktop 后重试。";
            }
            return result;
        }

        public static string CdpUnavailableMessage(bool running, int? port)
        {
            if (running)
            {
                string portDesc = port.HasValue ? ("端口 " + port.Value + " 无响应") : "未生成 DevToolsActivePort";
                return "检测到 Antigravity 正在运行，但未开启远程调试端口（Antigravity 2.33.0+ 默认关闭 CDP，" + portDesc + "）。请完全退出后以 Antigravity.exe --remote-debugging-port=0 启动";
            }
            if (port.HasValue)
            {
                return "端口 " + port.Value + " 无响应：Antigravity 可能未运行。2.33.0+ 请以 --remote-debugging-port=0 启动";
            }
            return "未找到调试端口文件，Antigravity 未运行（2.33.0+ 请以 --remote-debugging-port=0 启动）";
        }

        private static string GetStr(Dictionary<string, object> d, string k)
        {
            object v;
            if (d.TryGetValue(k, out v) && v is string) return (string)v;
            return null;
        }
    }
}
