// smcp-nightlight: warms every screen by scaling its gamma table, the same public CoreGraphics call
// that f.lux and Night Shift style tools rely on (CGSetDisplayTransferByTable).
//
// SMCP.app starts it and talks to it over stdin, one JSON object per line:
//   {"r":1,"g":0.53,"b":0.0,"fade":2}   glide to these channel gains (0...1) over `fade` seconds
//   {"off":true,"fade":1}               glide back to normal, then exit
// It prints one JSON line per change: {"ok":true,"displays":2} or {"ok":false,"error":"..."}.
//
// macOS undoes a gamma change when the process that made it exits, so a crash or a quit of SMCP
// always leaves the screen as it was. When stdin closes the helper restores the colors and exits.
// macOS also resets gamma after sleep, display changes and ColorSync updates; the helper re-applies.
import AppKit
import CoreGraphics
import Foundation

let tableSize = 256
let maxDisplays: UInt32 = 16
let frameSeconds = 1.0 / 30.0

struct Gains: Equatable {
    var r: Double
    var g: Double
    var b: Double

    static let white = Gains(r: 1, g: 1, b: 1)

    func mixed(toward other: Gains, by t: Double) -> Gains {
        Gains(r: r + (other.r - r) * t, g: g + (other.g - g) * t, b: b + (other.b - b) * t)
    }
}

struct Ramp {
    var red: [CGGammaValue]
    var green: [CGGammaValue]
    var blue: [CGGammaValue]
}

final class NightLight {
    /// Each display's own calibration, read before the helper ever touches it.
    var original: [CGDirectDisplayID: Ramp] = [:]
    var current = Gains.white
    var start = Gains.white
    var target = Gains.white
    var fadeStart = Date()
    var fadeSeconds = 0.0
    var exitWhenDone = false
    var timer: Timer?

    func activeDisplays() -> [CGDirectDisplayID] {
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(maxDisplays))
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(maxDisplays, &ids, &count) == .success else { return [] }
        return Array(ids.prefix(Int(count)))
    }

    func originalRamp(_ display: CGDirectDisplayID) -> Ramp {
        if let ramp = original[display] { return ramp }
        let capacity = Int(CGDisplayGammaTableCapacity(display))
        let size = capacity > 0 ? min(capacity, 1024) : tableSize
        var red = [CGGammaValue](repeating: 0, count: size)
        var green = [CGGammaValue](repeating: 0, count: size)
        var blue = [CGGammaValue](repeating: 0, count: size)
        var sampled: UInt32 = 0
        let ramp: Ramp
        if CGGetDisplayTransferByTable(display, UInt32(size), &red, &green, &blue, &sampled) == .success, sampled > 1 {
            let n = Int(sampled)
            ramp = Ramp(red: Array(red.prefix(n)), green: Array(green.prefix(n)), blue: Array(blue.prefix(n)))
        } else {
            let linear = (0..<tableSize).map { CGGammaValue(Double($0) / Double(tableSize - 1)) }
            ramp = Ramp(red: linear, green: linear, blue: linear)
        }
        original[display] = ramp
        return ramp
    }

    @discardableResult
    func apply(_ gains: Gains) -> Int {
        var applied = 0
        for display in activeDisplays() {
            let base = originalRamp(display)
            let red = base.red.map { $0 * CGGammaValue(gains.r) }
            let green = base.green.map { $0 * CGGammaValue(gains.g) }
            let blue = base.blue.map { $0 * CGGammaValue(gains.b) }
            if CGSetDisplayTransferByTable(display, UInt32(red.count), red, green, blue) == .success { applied += 1 }
        }
        current = gains
        return applied
    }

    func glide(to gains: Gains, seconds: Double) {
        start = current
        target = gains
        fadeStart = Date()
        fadeSeconds = max(0, seconds)
        timer?.invalidate()
        if fadeSeconds == 0 {
            finishFade()
            return
        }
        timer = Timer.scheduledTimer(withTimeInterval: frameSeconds, repeats: true) { [weak self] _ in self?.step() }
    }

    func step() {
        let t = min(1, Date().timeIntervalSince(fadeStart) / fadeSeconds)
        // Ease in and out so the start and the end of the fade are not noticeable.
        let eased = t * t * (3 - 2 * t)
        apply(start.mixed(toward: target, by: eased))
        if t >= 1 { finishFade() }
    }

    func finishFade() {
        timer?.invalidate()
        timer = nil
        let displays = apply(target)
        if exitWhenDone { restoreAndExit() }
        report(["ok": true, "displays": displays])
    }

    /// macOS resets gamma after sleep or when a screen is plugged in; put the warmth back.
    func reapply() {
        guard timer == nil, current != .white else { return }
        apply(current)
    }

    func restoreAndExit() -> Never {
        CGDisplayRestoreColorSyncSettings()
        report(["ok": true, "restored": true])
        exit(0)
    }

    func handle(line: String) {
        guard let data = line.data(using: .utf8),
              let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else {
            report(["ok": false, "error": "Not a valid message."])
            return
        }
        let fade = min(max((message["fade"] as? NSNumber)?.doubleValue ?? 1, 0), 60)
        if message["off"] as? Bool == true {
            exitWhenDone = true
            glide(to: .white, seconds: fade)
            return
        }
        func channel(_ key: String) -> Double? {
            guard let value = (message[key] as? NSNumber)?.doubleValue, value.isFinite else { return nil }
            return min(max(value, 0), 1)
        }
        guard let r = channel("r"), let g = channel("g"), let b = channel("b") else {
            report(["ok": false, "error": "r, g and b must be numbers from 0 to 1."])
            return
        }
        // Never let the screen go fully black: the brightest channel keeps at least 10%.
        guard max(r, g, b) >= 0.1 else {
            report(["ok": false, "error": "That would leave the screen almost black."])
            return
        }
        // A new color while fading out to quit means the night light is wanted again.
        exitWhenDone = false
        glide(to: Gains(r: r, g: g, b: b), seconds: fade)
    }
}

func report(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write((text + "\n").data(using: .utf8)!)
    }
}

let light = NightLight()

if CommandLine.arguments.contains("--check") {
    report(["ok": true, "displays": light.activeDisplays().count])
    exit(0)
}

// Whatever ends the helper, give the screens their colors back first.
for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig) { _ in
        CGDisplayRestoreColorSyncSettings()
        exit(0)
    }
}

CGDisplayRegisterReconfigurationCallback({ _, flags, _ in
    if flags.contains(.beginConfigurationFlag) { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { light.reapply() }
}, nil)

NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in
    light.reapply()
}
NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main) { _ in
    light.reapply()
}

// A slow safety net for anything else that resets the gamma table (ColorSync, other apps).
Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in light.reapply() }

// stdin is read on its own thread; every message is handled on the main thread.
Thread.detachNewThread {
    while let line = readLine() {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { continue }
        DispatchQueue.main.async { light.handle(line: trimmed) }
    }
    // SMCP closed the pipe (it quit or crashed): leave the screens as they were.
    DispatchQueue.main.async { light.restoreAndExit() }
}

report(["ok": true, "ready": true, "displays": light.activeDisplays().count])
RunLoop.main.run()
