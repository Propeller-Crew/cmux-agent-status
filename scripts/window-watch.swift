// Watches the height of cmux's main window and hands every new value to the sync
// script (`last-prompt-sync.py --window <points>`), so the sidebar's activity card
// follows a resize within about a second instead of waiting for the next sync run.
// A cmux sidebar can't pin anything to its bottom or read the window size itself.
// Compiled by install.sh to ~/.config/cmux/bin/cmux-window-watch, kept alive by launchd.
import CoreGraphics
import Foundation

let sync = (NSHomeDirectory() as NSString).appendingPathComponent(".config/cmux/last-prompt-sync.py")

func cmuxWindowHeight() -> Int? {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    return windows
        .filter { ($0[kCGWindowOwnerName as String] as? String) == "cmux" && ($0[kCGWindowLayer as String] as? Int) == 0 }
        .compactMap { ($0[kCGWindowBounds as String] as? [String: Any])?["Height"] as? Double }
        .max()
        .map { Int($0) }
}

var reported: Int?
var pending: (height: Int, since: Date)?
while true {
    if let h = cmuxWindowHeight(), h != reported {
        // Report once the size has held for a moment, not on every frame of a drag.
        if pending?.height != h {
            pending = (h, Date())
        } else if let p = pending, Date().timeIntervalSince(p.since) >= 0.3 {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            task.arguments = ["-I", sync, "--window", String(h)]
            try? task.run()
            task.waitUntilExit()
            reported = h
            pending = nil
        }
    }
    Thread.sleep(forTimeInterval: 0.25)
}
