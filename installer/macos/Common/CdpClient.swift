import Foundation
#if canImport(Darwin)
import Darwin
#endif

struct CdpPageInfo {
    let id: String
    let title: String
    let url: String
    let webSocketDebuggerUrl: String
}

struct EnsureAntigravityResult {
    let ok: Bool
    let action: String
    let port: Int?
    let message: String
}

struct CdpError: Error, LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { return message }
}

final class PluginManifest {
    let version: String
    let styleId: String
    let settingBinding: String
    let parts: [String]
    let defaultConfig: [String: JsonValue]
    let validators: [String: JsonValue]
    let removeExpression: String

    init(
        version: String,
        styleId: String,
        settingBinding: String,
        parts: [String],
        defaultConfig: [String: JsonValue],
        validators: [String: JsonValue],
        removeExpression: String
    ) {
        self.version = version
        self.styleId = styleId
        self.settingBinding = settingBinding
        self.parts = parts
        self.defaultConfig = defaultConfig
        self.validators = validators
        self.removeExpression = removeExpression
    }

    static func load(baseDir: String) throws -> PluginManifest {
        let manifestPath = (baseDir as NSString).appendingPathComponent("manifest.json")
        let text = try String(contentsOfFile: manifestPath, encoding: .utf8)
        let raw = try MiniJson.parseObject(text)
        let version = raw["version"]?.stringValue ?? "2.2.0"
        let styleId = raw["styleId"]?.stringValue ?? "ag-claude-style-css"
        let settingBinding = raw["settingBinding"]?.stringValue ?? "__agClaudeStyleSetting"
        let removeExpression = raw["removeExpression"]?.stringValue ?? ""
        var parts: [String] = []
        if let arr = raw["parts"]?.arrayValue {
            for item in arr {
                if let s = item.stringValue, !s.isEmpty {
                    parts.append(s)
                }
            }
        }
        let defaultConfig = raw["defaultConfig"]?.objectValue ?? [:]
        let validators = raw["validators"]?.objectValue ?? [:]
        return PluginManifest(
            version: version,
            styleId: styleId,
            settingBinding: settingBinding,
            parts: parts,
            defaultConfig: defaultConfig,
            validators: validators,
            removeExpression: removeExpression
        )
    }
}

final class CdpSession: NSObject, URLSessionWebSocketDelegate {
    private var urlSession: URLSession!
    private var wsTask: URLSessionWebSocketTask!
    private let lock = NSLock()
    private let sendQueue = DispatchQueue(label: "io.github.0dnancy.agy-claude-style.cdp.send")
    private var nextId: Int = 0
    private var pending: [Int: (Result<[String: JsonValue], Error>) -> Void] = [:]
    private var listeners: [String: [([String: JsonValue]) -> Void]] = [:]
    private var closed = false
    private var opened = false
    private var openCallback: ((Error?) -> Void)?

    var onClose: (() -> Void)?

    private override init() {
        super.init()
    }

    static func connect(wsUrl: String, timeoutMs: Int = 3000) throws -> CdpSession {
        guard let url = URL(string: wsUrl) else {
            throw CdpError("Invalid WebSocket URL: \(wsUrl)")
        }
        let session = CdpSession()
        let cfg = URLSessionConfiguration.ephemeral
        cfg.connectionProxyDictionary = [:]
        cfg.timeoutIntervalForRequest = max(1.0, Double(timeoutMs) / 1000.0)
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        delegateQueue.name = "io.github.0dnancy.agy-claude-style.cdp.ws"

        let sem = DispatchSemaphore(value: 0)
        var connectErr: Error?

        session.lock.lock()
        session.openCallback = { err in
            connectErr = err
            sem.signal()
        }
        session.lock.unlock()

        let urlSession = URLSession(configuration: cfg, delegate: session, delegateQueue: delegateQueue)
        let task = urlSession.webSocketTask(with: url)
        task.maximumMessageSize = 64 * 1024 * 1024
        session.urlSession = urlSession
        session.wsTask = task
        task.resume()

        let waitResult = sem.wait(timeout: .now() + .milliseconds(timeoutMs))
        if waitResult == .timedOut {
            session.lock.lock()
            session.openCallback = nil
            session.lock.unlock()
            session.close()
            throw CdpError("CDP connect timeout")
        }
        if let err = connectErr {
            session.close()
            throw err
        }
        return session
    }

    func on(_ method: String, callback: @escaping ([String: JsonValue]) -> Void) {
        lock.lock()
        var list = listeners[method] ?? []
        list.append(callback)
        listeners[method] = list
        lock.unlock()
    }

    func send(_ method: String, params: [String: JsonValue]? = nil, timeoutMs: Int = 5000) throws -> [String: JsonValue] {
        lock.lock()
        if closed {
            lock.unlock()
            throw CdpError("CDP connection closed")
        }
        nextId += 1
        let id = nextId
        let sem = DispatchSemaphore(value: 0)
        var outcome: Result<[String: JsonValue], Error>?
        pending[id] = { res in
            outcome = res
            sem.signal()
        }
        lock.unlock()

        let payload: JsonValue = .object([
            "id": .int(Int64(id)),
            "method": .string(method),
            "params": .object(params ?? [:])
        ])
        let json = MiniJson.stringify(payload, pretty: false)

        sendQueue.async { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            let isClosed = self.closed
            let task = self.wsTask
            self.lock.unlock()
            if isClosed || task == nil { return }
            task!.send(.string(json)) { [weak self] err in
                if let err = err {
                    self?.failPending(id: id, error: err)
                }
            }
        }

        let waitRes = sem.wait(timeout: .now() + .milliseconds(timeoutMs))
        if waitRes == .timedOut {
            lock.lock()
            pending.removeValue(forKey: id)
            let wasClosed = closed
            lock.unlock()
            if wasClosed {
                throw CdpError("CDP connection closed")
            }
            throw CdpError("CDP \(method) timeout")
        }

        switch outcome {
        case .success(let val):
            return val
        case .failure(let err):
            throw err
        case .none:
            throw CdpError("CDP \(method) failed")
        }
    }

    func evaluate(_ expression: String, awaitPromise: Bool = false) throws -> JsonValue {
        let res = try send("Runtime.evaluate", params: [
            "expression": .string(expression),
            "returnByValue": .bool(true),
            "awaitPromise": .bool(awaitPromise)
        ], timeoutMs: 15000)

        if let exDetails = res["exceptionDetails"]?.objectValue {
            var msg = exDetails["exception"]?.objectValue?["description"]?.stringValue
            if msg == nil || msg!.isEmpty {
                msg = exDetails["text"]?.stringValue
            }
            throw CdpError(msg ?? "Runtime.evaluate exception")
        }

        if let resultObj = res["result"]?.objectValue, let val = resultObj["value"] {
            return val
        }
        return .null
    }

    func close() {
        markClosed()
        lock.lock()
        let task = wsTask
        let session = urlSession
        lock.unlock()
        task?.cancel(with: .normalClosure, reason: nil)
        session?.invalidateAndCancel()
    }

    private func failPending(id: Int, error: Error) {
        lock.lock()
        let cb = pending.removeValue(forKey: id)
        lock.unlock()
        cb?(.failure(error))
    }

    private func startReceiveLoop() {
        lock.lock()
        let isClosed = closed
        let task = wsTask
        lock.unlock()
        if isClosed || task == nil { return }

        task!.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleMessage(text)
                    }
                @unknown default:
                    break
                }
                self.startReceiveLoop()
            case .failure:
                self.markClosed()
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let msg = try? MiniJson.parseObject(text) else { return }

        if let method = msg["method"]?.stringValue {
            let params = msg["params"]?.objectValue ?? [:]
            lock.lock()
            let callbacks = listeners[method] ?? []
            lock.unlock()
            for cb in callbacks {
                cb(params)
            }
            return
        }

        if let id = msg["id"]?.intValue {
            lock.lock()
            let cb = pending.removeValue(forKey: id)
            lock.unlock()
            guard let callback = cb else { return }
            if let errVal = msg["error"], case .null = errVal {
                // error is null -> treat as success
            } else if let errVal = msg["error"] {
                let errMsg = errVal.objectValue?["message"]?.stringValue ?? MiniJson.stringify(errVal, pretty: false)
                callback(.failure(CdpError(errMsg)))
                return
            }
            let resDict = msg["result"]?.objectValue ?? [:]
            callback(.success(resDict))
        }
    }

    private func markClosed() {
        lock.lock()
        if closed {
            lock.unlock()
            return
        }
        closed = true
        let pendingCallbacks = pending
        pending.removeAll()
        let closeHandler = onClose
        let openCb = openCallback
        openCallback = nil
        lock.unlock()

        openCb?(CdpError("CDP connection closed"))
        for (_, cb) in pendingCallbacks {
            cb(.failure(CdpError("CDP connection closed")))
        }
        closeHandler?()
    }

    // MARK: - URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        lock.lock()
        opened = true
        let cb = openCallback
        openCallback = nil
        lock.unlock()
        startReceiveLoop()
        cb?(nil)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        markClosed()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let wasOpened = opened
        let cb = openCallback
        openCallback = nil
        lock.unlock()
        if !wasOpened, let cb = cb {
            cb(error ?? CdpError("CDP connect failed"))
        }
        markClosed()
    }
}

enum CdpHelper {
    static let defaultStartupGraceSeconds: Double = 90.0

    static func getPortFilePath() -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return ((home as NSString)
            .appendingPathComponent("Library/Application Support/Antigravity/DevToolsActivePort"))
    }

    static func readPort(overridePort: Int?) -> Int? {
        if let p = overridePort, p > 0 { return p }
        if let envPort = ProcessInfo.processInfo.environment["AG_CDP_PORT"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !envPort.isEmpty,
           let p = Int(envPort), p > 0 {
            return p
        }
        let portFile = getPortFilePath()
        guard let text = try? String(contentsOfFile: portFile, encoding: .utf8) else { return nil }
        let firstLine = text.components(separatedBy: CharacterSet.newlines).first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let p = Int(firstLine), p > 0 {
            return p
        }
        return nil
    }

    static func listPages(port: Int) throws -> [CdpPageInfo] {
        guard let url = URL(string: "http://127.0.0.1:\(port)/json/list") else {
            throw CdpError("Invalid CDP HTTP URL")
        }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.connectionProxyDictionary = [:]
        cfg.timeoutIntervalForRequest = 2.0
        cfg.timeoutIntervalForResource = 2.0
        let session = URLSession(configuration: cfg)
        defer { session.finishTasksAndInvalidate() }

        let sem = DispatchSemaphore(value: 0)
        var fetchedData: Data?
        var fetchedError: Error?

        let task = session.dataTask(with: url) { data, _, err in
            fetchedData = data
            fetchedError = err
            sem.signal()
        }
        task.resume()

        if sem.wait(timeout: .now() + .milliseconds(2500)) == .timedOut {
            task.cancel()
            throw CdpError("CDP /json/list timeout")
        }
        if let err = fetchedError {
            throw err
        }
        guard let data = fetchedData, let jsonText = String(data: data, encoding: .utf8) else {
            throw CdpError("Empty response from /json/list")
        }

        let targets = try MiniJson.parseArray(jsonText)
        var pages: [CdpPageInfo] = []
        for targetVal in targets {
            guard let t = targetVal.objectValue else { continue }
            let type = t["type"]?.stringValue ?? ""
            let wsUrl = t["webSocketDebuggerUrl"]?.stringValue ?? ""
            let pageUrl = t["url"]?.stringValue ?? ""
            let lowerUrl = pageUrl.lowercased()
            let isPage = type == "page"
            let isSwarmSidecar = type == "iframe" && lowerUrl.hasPrefix("plugin://swarm--")
            if (isPage || isSwarmSidecar) && !wsUrl.isEmpty && !lowerUrl.hasPrefix("devtools://") && !lowerUrl.hasPrefix("data:") {
                let id = t["id"]?.stringValue ?? wsUrl
                let title = t["title"]?.stringValue ?? ""
                pages.append(CdpPageInfo(id: id, title: title, url: pageUrl, webSocketDebuggerUrl: wsUrl))
            }
        }
        return pages
    }

    static func computeHash(_ str: String) -> String {
        var h: UInt32 = 2166136261
        for unit in str.utf16 {
            h ^= UInt32(unit)
            h = h &* 16777619
        }
        return String(h, radix: 36)
    }

    static func readConfig(baseDir: String, manifest: PluginManifest) -> [String: JsonValue] {
        var cfg = manifest.defaultConfig
        let cfgPath = (baseDir as NSString).appendingPathComponent("config.json")
        if let text = try? String(contentsOfFile: cfgPath, encoding: .utf8),
           let userCfg = try? MiniJson.parseObject(text) {
            for (k, v) in userCfg {
                cfg[k] = v
            }
        }
        return cfg
    }

    static func updateConfigSetting(baseDir: String, manifest: PluginManifest, key: String, value: JsonValue) -> Bool {
        guard let rule = manifest.validators[key] else { return false }
        if let ruleStr = rule.stringValue, ruleStr == "boolean" {
            guard case .bool = value else { return false }
        } else if let allowed = rule.arrayValue {
            guard let strVal = value.stringValue else { return false }
            let matched = allowed.contains { $0.stringValue == strVal }
            if !matched { return false }
        } else {
            return false
        }

        var next = readConfig(baseDir: baseDir, manifest: manifest)
        next[key] = value
        let cfgPath = (baseDir as NSString).appendingPathComponent("config.json")
        let tmpPath = cfgPath + ".tmp"
        let content = MiniJson.stringify(.object(next), pretty: true) + "\n"
        do {
            try content.write(toFile: tmpPath, atomically: false, encoding: .utf8)
            if rename(tmpPath, cfgPath) != 0 {
                try? FileManager.default.removeItem(atPath: tmpPath)
                return false
            }
            return true
        } catch {
            try? FileManager.default.removeItem(atPath: tmpPath)
            return false
        }
    }

    static func readRuntimeBundle(baseDir: String, manifest: PluginManifest) throws -> String {
        var partsContent: [String] = []
        partsContent.reserveCapacity(manifest.parts.count)
        for part in manifest.parts {
            let p = (baseDir as NSString).appendingPathComponent(part)
            partsContent.append(try String(contentsOfFile: p, encoding: .utf8))
        }
        return partsContent.joined(separator: "\n")
    }

    static func readBundleAndCssHashes(baseDir: String, manifest: PluginManifest) throws -> (codeHash: String, cssHash: String) {
        let cssPath = (baseDir as NSString).appendingPathComponent("style.css")
        let css = try String(contentsOfFile: cssPath, encoding: .utf8)
        let bundle = try readRuntimeBundle(baseDir: baseDir, manifest: manifest)
        return (computeHash(bundle), computeHash(css))
    }

    static func buildConfigScriptExpression(baseDir: String, manifest: PluginManifest, expectedCodeHash: String) -> String {
        var payload = readConfig(baseDir: baseDir, manifest: manifest)
        payload["binding"] = .string(manifest.settingBinding)
        payload["codeHash"] = .string(expectedCodeHash)
        let payloadJson = MiniJson.stringify(.object(payload), pretty: false)
        let hashJson = MiniJson.stringifyString(expectedCodeHash)
        let verJson = MiniJson.stringifyString(manifest.version)
        return """
        (() => {
          const nextCfg = \(payloadJson);
          globalThis.__agCsOverrideConfig = nextCfg;
          if (
            window.__agClaudeStyle &&
            typeof window.__agClaudeStyle.refreshConfig === 'function' &&
            (!\(hashJson) || window.__agClaudeStyle.codeHash === \(hashJson))
          ) {
            window.__agClaudeStyle.refreshConfig(nextCfg);
            return {
              version: \(verJson),
              status: 'refreshed',
              state: window.__agClaudeStyle.getState ? window.__agClaudeStyle.getState() : null,
            };
          }
          return null;
        })()
        """
    }

    static func buildInjectExpression(baseDir: String, manifest: PluginManifest) throws -> String {
        let config = readConfig(baseDir: baseDir, manifest: manifest)
        let cssPath = (baseDir as NSString).appendingPathComponent("style.css")
        let css = try String(contentsOfFile: cssPath, encoding: .utf8)
        let bundle = try readRuntimeBundle(baseDir: baseDir, manifest: manifest)
        let codeHash = computeHash(bundle)

        var initCfg = config
        initCfg["binding"] = .string(manifest.settingBinding)
        initCfg["codeHash"] = .string(codeHash)

        let styleIdJson = MiniJson.stringifyString(manifest.styleId)
        var sb = ""
        sb.reserveCapacity(css.count + bundle.count + 4096)
        sb.append("(() => {\n")
        sb.append("    const css = ")
        sb.append(MiniJson.stringifyString(css))
        sb.append(";\n")
        sb.append("    const applyStyle = () => {\n")
        sb.append("      const targetParent = document.head || document.documentElement;\n")
        sb.append("      if (!targetParent) return;\n")
        sb.append("      let style = document.getElementById(")
        sb.append(styleIdJson)
        sb.append(");\n")
        sb.append("      if (!style) {\n")
        sb.append("        style = document.createElement('style');\n")
        sb.append("        style.id = ")
        sb.append(styleIdJson)
        sb.append(";\n")
        sb.append("      }\n")
        sb.append("      if (style.textContent !== css) style.textContent = css;\n")
        sb.append("      if (style.parentNode !== targetParent || targetParent.lastElementChild !== style) {\n")
        sb.append("        targetParent.appendChild(style);\n")
        sb.append("      }\n")
        sb.append("    };\n\n")
        sb.append("    let status = 'ok';\n")
        sb.append("    let mounted = false;\n")
        sb.append("    const mount = () => {\n")
        sb.append("      if (mounted || !document.documentElement) return;\n")
        sb.append("      mounted = true;\n")
        sb.append("      try {\n")
        sb.append("        const isSidecar = typeof location !== 'undefined' && location.protocol === 'plugin:';\n")
        sb.append("        if (!isSidecar) {\n")
        sb.append("          if (document.head) applyStyle();\n")
        sb.append("          else document.addEventListener('DOMContentLoaded', applyStyle, { once: true });\n")
        sb.append("        }\n")
        sb.append("        ")
        sb.append(bundle)
        sb.append("\n")
        sb.append("        if (typeof globalThis.__agCsUiMain === 'function') {\n")
        sb.append("          const baseCfg = ")
        sb.append(MiniJson.stringify(.object(initCfg), pretty: false))
        sb.append(";\n")
        sb.append("          const ov = globalThis.__agCsOverrideConfig;\n")
        sb.append("          const nextCfg = (ov && typeof ov === 'object' && ov.codeHash === baseCfg.codeHash) ? Object.assign({}, baseCfg, ov, { binding: baseCfg.binding, codeHash: baseCfg.codeHash }) : baseCfg;\n")
        sb.append("          globalThis.__agCsUiMain(nextCfg);\n")
        sb.append("        }\n")
        sb.append("      } catch (e) {\n")
        sb.append("        status = 'error: ' + (e && e.message ? e.message : String(e));\n")
        sb.append("        if (typeof console !== 'undefined' && console.error) {\n")
        sb.append("          console.error('[agy-claude-style] init error:', e);\n")
        sb.append("        }\n")
        sb.append("      }\n")
        sb.append("    };\n\n")
        sb.append("    if (document.documentElement) {\n")
        sb.append("      mount();\n")
        sb.append("    } else {\n")
        sb.append("      status = 'deferred';\n")
        sb.append("      const onReady = () => {\n")
        sb.append("        if (document.documentElement) {\n")
        sb.append("          document.removeEventListener('readystatechange', onReady);\n")
        sb.append("          document.removeEventListener('DOMContentLoaded', onReady);\n")
        sb.append("          mount();\n")
        sb.append("        }\n")
        sb.append("      };\n")
        sb.append("      document.addEventListener('readystatechange', onReady);\n")
        sb.append("      document.addEventListener('DOMContentLoaded', onReady);\n")
        sb.append("    }\n")
        sb.append("    const st = window.__agClaudeStyle && window.__agClaudeStyle.getState ? window.__agClaudeStyle.getState() : null;\n")
        sb.append("    return {\n")
        sb.append("      version: ")
        sb.append(MiniJson.stringifyString(manifest.version))
        sb.append(",\n")
        sb.append("      status,\n")
        sb.append("      state: st,\n")
        sb.append("    };\n")
        sb.append("  })()")
        return sb
    }

    static func shortTitle(_ page: CdpPageInfo) -> String {
        let t = !page.title.isEmpty ? page.title : page.url
        if t.count > 60 {
            return String(t.prefix(57)) + "..."
        }
        return t
    }

    enum WatcherPidStatus {
        case dead
        case owned
        case foreign
        case unknown
    }

    struct WatcherPidClassification {
        let status: WatcherPidStatus
        let pid: Int32
        let command: String?
    }

    static func normalizePath(_ p: String) -> String {
        var resolved = URL(fileURLWithPath: p).standardizedFileURL.path
        if resolved.count > 1 && resolved.hasSuffix("/") {
            resolved = String(resolved.dropLast())
        }
        for prefix in ["/private/var", "/private/tmp", "/private/etc"] {
            if resolved == prefix || resolved.hasPrefix(prefix + "/") {
                resolved = String(resolved.dropFirst("/private".count))
                break
            }
        }
        return resolved
    }

    private static func runPsQuery(pid: Int32, field: String) -> String? {
        guard pid > 0 else { return nil }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/ps")
        proc.arguments = ["-p", String(pid), "-o", field]
        let outPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = FileHandle.nullDevice
        proc.standardInput = FileHandle.nullDevice
        do {
            try proc.run()
            let data = outPipe.fileHandleForReading.readDataToEndOfFile()
            proc.waitUntilExit()
            guard proc.terminationStatus == 0,
                  let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !text.isEmpty else {
                return nil
            }
            return text
        } catch {
            return nil
        }
    }

    static func inspectProcessCommand(pid: Int32) -> String? {
        return runPsQuery(pid: pid, field: "command=")
    }

    static func inspectProcessInfo(pid: Int32) -> (cmd: String, exePath: String?)? {
        guard let cmd = runPsQuery(pid: pid, field: "command=") else { return nil }
        let exePath = runPsQuery(pid: pid, field: "comm=")
        return (cmd, exePath)
    }

    private static func hasStandaloneFlag(_ cmd: String, _ flag: String) -> Bool {
        let escaped = NSRegularExpression.escapedPattern(for: flag)
        let pattern = "(?:^|\\s)" + escaped + "(?=\\s|$)"
        return cmd.range(of: pattern, options: .regularExpression) != nil
    }

    private static func hasPathBoundaryToken(_ haystack: String, _ targetPath: String) -> Bool {
        guard !haystack.isEmpty && !targetPath.isEmpty else { return false }
        let scalars: Set<Character> = [" ", "\t", "\n", "\r", "\"", "'"]
        var searchStart = haystack.startIndex
        while let range = haystack.range(of: targetPath, range: searchStart..<haystack.endIndex) {
            let beforeOk = range.lowerBound == haystack.startIndex || scalars.contains(haystack[haystack.index(before: range.lowerBound)])
            let afterOk = range.upperBound == haystack.endIndex || scalars.contains(haystack[range.upperBound])
            if beforeOk && afterOk {
                return true
            }
            searchStart = range.upperBound
        }
        return false
    }

    private static func extractDirFlagPath(_ cmd: String) -> (present: Bool, raw: String?, path: String?) {
        guard hasStandaloneFlag(cmd, "--dir") || cmd.range(of: "(?:^|\\s)--dir=", options: .regularExpression) != nil else {
            return (false, nil, nil)
        }
        let pattern = "(?:^|\\s)--dir(?:=|\\s+)(?:\"([^\"]+)\"|'([^']+)'|(.+?))(?=\\s+--[a-zA-Z0-9-]+(?:=|\\s|$)|$)"
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else { return (true, nil, nil) }
        let nsRange = NSRange(cmd.startIndex..<cmd.endIndex, in: cmd)
        guard let match = regex.firstMatch(in: cmd, options: [], range: nsRange) else { return (true, nil, nil) }
        for idx in 1...3 {
            let r = match.range(at: idx)
            if r.location != NSNotFound, let swiftRange = Range(r, in: cmd) {
                let raw = String(cmd[swiftRange]).trimmingCharacters(in: .whitespacesAndNewlines)
                if !raw.isEmpty {
                    let norm = raw.hasPrefix("/") ? normalizePath(raw) : nil
                    return (true, raw, norm)
                }
            }
        }
        return (true, nil, nil)
    }

    private static func isNodeBinaryName(_ tokenOrPath: String) -> Bool {
        let base = (tokenOrPath as NSString).lastPathComponent.lowercased()
        return base == "node" || base == "nodejs" || base.hasPrefix("electron") || base.hasPrefix("antigravity")
    }

    static func evaluateWatcherOwnership(command rawCmd: String, exePath: String? = nil, baseDir: String) -> WatcherPidStatus {
        let cmd = rawCmd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cmd.isEmpty, !baseDir.isEmpty else { return .unknown }
        if hasStandaloneFlag(cmd, "--once") || hasStandaloneFlag(cmd, "--remove") {
            return .foreign
        }
        let normDir = normalizePath(baseDir)
        let nativeExeName = "agy-claude-style-watcher"
        let expectedNativeExe = normalizePath((normDir as NSString).appendingPathComponent(nativeExeName))

        let exePrefix = (cmd.components(separatedBy: " --").first ?? cmd)
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\"'")))
        let leadingToken = exePrefix.split(separator: " ").first.map(String.init) ?? ""

        let exeMatchesNative: Bool
        if let ep = exePath, !ep.isEmpty {
            exeMatchesNative = (ep as NSString).lastPathComponent.lowercased() == nativeExeName
        } else {
            let normPrefix = exePrefix.hasPrefix("/") ? normalizePath(exePrefix) : exePrefix
            exeMatchesNative =
                (normPrefix == expectedNativeExe) ||
                (!exePrefix.contains(" ") && (exePrefix as NSString).lastPathComponent.lowercased() == nativeExeName)
        }

        if exeMatchesNative {
            let dirFlag = extractDirFlagPath(cmd)
            if dirFlag.present {
                if let resolved = dirFlag.path {
                    return resolved == normDir ? .owned : .foreign
                }
                return (dirFlag.raw != nil) ? .unknown : .foreign
            }
            if let ep = exePath, !ep.isEmpty, ep.hasPrefix("/") {
                let epDir = normalizePath((ep as NSString).deletingLastPathComponent)
                return epDir == normDir ? .owned : .foreign
            }
            if exePrefix.hasPrefix("/") {
                return normalizePath(exePrefix) == expectedNativeExe ? .owned : .foreign
            }
            return .unknown
        }

        guard hasStandaloneFlag(cmd, "--watch") || hasStandaloneFlag(cmd, "--managed") else { return .foreign }

        var launcherTok = exePath ?? ""
        var rest = ""
        if let ep = exePath, !ep.isEmpty {
            if cmd.hasPrefix(ep) {
                rest = String(cmd.dropFirst(ep.count)).trimmingCharacters(in: .whitespacesAndNewlines)
            } else {
                let baseEp = (ep as NSString).lastPathComponent
                if cmd.hasPrefix(baseEp) {
                    rest = String(cmd.dropFirst(baseEp.count)).trimmingCharacters(in: .whitespacesAndNewlines)
                } else {
                    rest = String(cmd.dropFirst(leadingToken.count)).trimmingCharacters(in: .whitespacesAndNewlines)
                }
            }
        } else {
            launcherTok = leadingToken
            rest = String(cmd.dropFirst(leadingToken.count)).trimmingCharacters(in: .whitespacesAndNewlines)
        }

        guard isNodeBinaryName(launcherTok), !rest.isEmpty else { return .foreign }
        if rest.hasPrefix("-") {
            let firstFlag = (rest.split(separator: " ").first.map(String.init) ?? "").lowercased()
            if ["-e", "--eval", "-p", "--print", "-i", "--interactive", "-c", "--check", "-h", "--help", "-v", "--version"].contains(firstFlag) {
                return .foreign
            }
            return .unknown
        }

        let expectedScript = normalizePath((normDir as NSString).appendingPathComponent("inject.js"))
        let rawUnquotedRest = rest.hasPrefix("\"") || rest.hasPrefix("'") ? String(rest.dropFirst()) : rest
        var unquotedRest = rawUnquotedRest
        for prefix in ["/private/var", "/private/tmp", "/private/etc"] {
            if rawUnquotedRest.hasPrefix(prefix) {
                let afterPrefix = rawUnquotedRest.dropFirst(prefix.count)
                if afterPrefix.isEmpty || afterPrefix.first == "/" || afterPrefix.first == " " || afterPrefix.first == "\t" || afterPrefix.first == "\"" || afterPrefix.first == "'" {
                    unquotedRest = String(rawUnquotedRest.dropFirst("/private".count))
                }
                break
            }
        }
        if unquotedRest.hasPrefix(expectedScript) {
            let after = unquotedRest.dropFirst(expectedScript.count)
            if after.isEmpty || after.first == " " || after.first == "\t" || after.first == "\"" || after.first == "'" {
                return .owned
            }
        }
        let firstArg = unquotedRest.split(whereSeparator: { $0.isWhitespace || $0 == "\"" || $0 == "'" }).first.map(String.init) ?? ""
        if firstArg.hasPrefix("/") {
            return normalizePath(firstArg) == expectedScript ? .owned : .foreign
        }
        return (firstArg as NSString).lastPathComponent.lowercased() == "inject.js" ? .unknown : .foreign
    }

    static func matchesWatcherForDir(command rawCmd: String, exePath: String? = nil, baseDir: String) -> Bool {
        return evaluateWatcherOwnership(command: rawCmd, exePath: exePath, baseDir: baseDir) == .owned
    }

    static func classifyWatcherPid(_ pid: Int32, baseDir: String) -> WatcherPidClassification {
        guard pid > 0 else { return WatcherPidClassification(status: .dead, pid: pid, command: nil) }
        guard isProcessAlive(pid) else { return WatcherPidClassification(status: .dead, pid: pid, command: nil) }
        guard let info = inspectProcessInfo(pid: pid) else {
            if !isProcessAlive(pid) {
                return WatcherPidClassification(status: .dead, pid: pid, command: nil)
            }
            return WatcherPidClassification(status: .unknown, pid: pid, command: nil)
        }
        let status = evaluateWatcherOwnership(command: info.cmd, exePath: info.exePath, baseDir: baseDir)
        return WatcherPidClassification(status: status, pid: pid, command: info.cmd)
    }

    static func isProcessAlive(_ pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        if kill(pid, 0) == 0 { return true }
        return errno == EPERM
    }

    static func detectAntigravityProcessPids() -> [Int32] {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/ps")
        proc.arguments = ["-ax", "-o", "pid=,comm="]
        let outPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = FileHandle.nullDevice
        proc.standardInput = FileHandle.nullDevice
        do {
            try proc.run()
            let data = outPipe.fileHandleForReading.readDataToEndOfFile()
            proc.waitUntilExit()
            guard let text = String(data: data, encoding: .utf8) else { return [] }
            var pids: [Int32] = []
            for rawLine in text.components(separatedBy: CharacterSet.newlines) {
                let line = rawLine.trimmingCharacters(in: .whitespaces)
                if line.isEmpty { continue }
                let parts = line.split(maxSplits: 1, omittingEmptySubsequences: true, whereSeparator: { $0.isWhitespace })
                guard parts.count == 2, let pid = Int32(parts[0]) else { continue }
                let comm = String(parts[1]).trimmingCharacters(in: .whitespaces).lowercased()
                if comm.hasSuffix("/antigravity.app/contents/macos/antigravity") || comm == "antigravity" {
                    pids.append(pid)
                }
            }
            return pids.sorted()
        } catch {
            return []
        }
    }

    static func findAntigravityAppPath() -> String? {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        let candidates = [
            "/Applications/Antigravity.app",
            (home as NSString).appendingPathComponent("Applications/Antigravity.app"),
        ]
        for path in candidates {
            if fm.fileExists(atPath: path) { return path }
        }
        return nil
    }

    static func detectRunningAntigravityAppPath() -> String? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/ps")
        proc.arguments = ["-ax", "-o", "comm="]
        let outPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = FileHandle.nullDevice
        proc.standardInput = FileHandle.nullDevice
        do {
            try proc.run()
            let data = outPipe.fileHandleForReading.readDataToEndOfFile()
            proc.waitUntilExit()
            guard let text = String(data: data, encoding: .utf8) else { return nil }
            let suffix = "/contents/macos/antigravity"
            for rawLine in text.components(separatedBy: CharacterSet.newlines) {
                let comm = rawLine.trimmingCharacters(in: .whitespaces)
                let lower = comm.lowercased()
                if lower.hasSuffix(".app" + suffix) && comm.count > suffix.count {
                    let endIdx = comm.index(comm.endIndex, offsetBy: -suffix.count)
                    let appPath = String(comm[..<endIdx])
                    if FileManager.default.fileExists(atPath: appPath) {
                        return appPath
                    }
                }
            }
        } catch {}
        return nil
    }

    static func hasAntigravityCdpFlag(pids: [Int32]) -> Bool {
        guard !pids.isEmpty else { return false }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/ps")
        proc.arguments = ["-p", pids.map { String($0) }.joined(separator: ","), "-o", "args="]
        let outPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = FileHandle.nullDevice
        proc.standardInput = FileHandle.nullDevice
        do {
            try proc.run()
            let data = outPipe.fileHandleForReading.readDataToEndOfFile()
            proc.waitUntilExit()
            guard let text = String(data: data, encoding: .utf8) else { return false }
            return text.lowercased().contains("--remote-debugging-port")
        } catch {
            return false
        }
    }

    static func removeStalePortFile() {
        let portFile = getPortFilePath()
        if FileManager.default.fileExists(atPath: portFile) {
            try? FileManager.default.removeItem(atPath: portFile)
        }
    }

    @discardableResult
    static func activateAntigravityApp(appPath: String? = nil) -> Bool {
        if ProcessInfo.processInfo.environment["AGY_CS_NO_UI"] == "1" {
            return false
        }
        let target = (appPath?.isEmpty == false)
            ? appPath!
            : (detectRunningAntigravityAppPath() ?? findAntigravityAppPath() ?? "Antigravity")
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        proc.arguments = ["-a", target]
        proc.standardInput = FileHandle.nullDevice
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
            return proc.terminationStatus == 0
        } catch {
            return false
        }
    }

    @discardableResult
    static func launchAntigravityWithCdp(appPath: String? = nil, port: Int = 0) -> Bool {
        if detectAntigravityProcessPids().isEmpty {
            removeStalePortFile()
        }
        let target = (appPath?.isEmpty == false) ? appPath! : (findAntigravityAppPath() ?? "Antigravity")
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        proc.arguments = ["-a", target, "--args", "--remote-debugging-port=\(max(0, port))"]
        proc.standardInput = FileHandle.nullDevice
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
            return proc.terminationStatus == 0
        } catch {
            return false
        }
    }

    @discardableResult
    static func relaunchAntigravityWithCdp(appPath: String? = nil, port: Int = 0, waitSeconds: Double = 8.0) -> Bool {
        let resolvedApp = (appPath?.isEmpty == false) ? appPath! : (detectRunningAntigravityAppPath() ?? findAntigravityAppPath())
        guard let targetApp = resolvedApp, FileManager.default.fileExists(atPath: targetApp) else {
            return false
        }
        let initialPids = detectAntigravityProcessPids()
        for pid in initialPids {
            if pid > 0 && pid != getpid() {
                _ = kill(pid, SIGTERM)
            }
        }

        let deadline = Date().addingTimeInterval(waitSeconds)
        while Date() < deadline {
            if detectAntigravityProcessPids().isEmpty { break }
            Thread.sleep(forTimeInterval: 0.2)
        }
        let remaining = detectAntigravityProcessPids()
        if !remaining.isEmpty {
            return false
        }
        removeStalePortFile()
        Thread.sleep(forTimeInterval: 0.35)
        return launchAntigravityWithCdp(appPath: targetApp, port: port)
    }

    static func ensureAntigravityWithCdp(
        appPath: String? = nil,
        allowRelaunch: Bool = false,
        overridePort: Int? = nil,
        waitSeconds: Double = 8.0
    ) -> EnsureAntigravityResult {
        if let port = readPort(overridePort: overridePort),
           let pages = try? listPages(port: port),
           !pages.isEmpty {
            activateAntigravityApp(appPath: appPath)
            return EnsureAntigravityResult(
                ok: true,
                action: "already-cdp",
                port: port,
                message: "Antigravity 已开启 CDP（端口 \(port)，\(pages.count) 个窗口）"
            )
        }

        let pids = detectAntigravityProcessPids()
        if !pids.isEmpty {
            if hasAntigravityCdpFlag(pids: pids) {
                activateAntigravityApp(appPath: appPath)
                return EnsureAntigravityResult(
                    ok: true,
                    action: "waiting-cdp",
                    port: nil,
                    message: "Antigravity 已携带 CDP 参数运行，正在等待调试端口就绪..."
                )
            }
            if allowRelaunch {
                if relaunchAntigravityWithCdp(appPath: appPath, port: 0, waitSeconds: waitSeconds) {
                    return EnsureAntigravityResult(
                        ok: true,
                        action: "relaunched",
                        port: nil,
                        message: "已温和重启 Antigravity 并附加 --remote-debugging-port=0"
                    )
                }
                return EnsureAntigravityResult(
                    ok: false,
                    action: "relaunch-failed",
                    port: nil,
                    message: "未能自动关闭当前运行中的 Antigravity，请先按 Cmd+Q 完全退出后重试"
                )
            }
            return EnsureAntigravityResult(
                ok: false,
                action: "running-without-cdp",
                port: nil,
                message: cdpUnavailableMessage(running: true, port: readPort(overridePort: overridePort))
            )
        }

        if launchAntigravityWithCdp(appPath: appPath, port: 0) {
            return EnsureAntigravityResult(
                ok: true,
                action: "launched",
                port: nil,
                message: "已以 --remote-debugging-port=0 启动 Antigravity"
            )
        }
        return EnsureAntigravityResult(
            ok: false,
            action: "executable-not-found",
            port: nil,
            message: "未找到 Antigravity Desktop，请确认已安装 Antigravity.app"
        )
    }

    static func cdpUnavailableMessage(running: Bool, port: Int?) -> String {
        if running {
            let portDesc = port != nil ? "端口 \(port!) 无响应" : "未生成 DevToolsActivePort"
            return "检测到 Antigravity 正在运行，但未开启远程调试端口（Antigravity 2.33.0+ 默认关闭 CDP，\(portDesc)）。请完全退出后执行：open -a Antigravity --args --remote-debugging-port=0"
        }
        if let port = port {
            return "端口 \(port) 无响应：Antigravity 可能未运行。2.33.0+ 请以 --remote-debugging-port=0 启动"
        }
        return "未找到调试端口文件，Antigravity 未运行（2.33.0+ 请执行 open -a Antigravity --args --remote-debugging-port=0 启动）"
    }
}
