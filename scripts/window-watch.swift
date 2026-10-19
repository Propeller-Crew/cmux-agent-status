// Watches two things for the sidebar and hands them to the sync script:
// - the newest file in ~/Downloads (`--download <epoch> <path>`), so a screenshot
//   AirDropped from the iPhone can be pasted into Claude with one click;
// - the height of cmux's main window (`--window <points>`), so the sidebar's activity card
// follows a resize within a second or two instead of waiting for the next sync run.
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

// Battery: look once a second while nothing changes, five times a second for a few
// seconds after a change (a drag is usually still going on).
let downloads = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Downloads")
let partial: Set<String> = ["download", "crdownload", "part", "tmp"]

/// The file most recently added to ~/Downloads (by "date added", which AirDrop sets
/// on arrival; a screenshot keeps the creation date it had on the phone).
func newestDownload() -> (added: Date, path: String)? {
    let keys: Set<URLResourceKey> = [.addedToDirectoryDateKey]
    guard let items = try? FileManager.default.contentsOfDirectory(
        at: downloads, includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles]) else { return nil }
    var best: (added: Date, path: String)?
    for url in items where !partial.contains(url.pathExtension.lowercased()) {
        guard let added = try? url.resourceValues(forKeys: keys).addedToDirectoryDate else { continue }
        if best == nil || added > best!.added { best = (added, url.path) }
    }
    return best
}

func runSync(_ args: [String]) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
    task.arguments = ["-I", sync] + args
    try? task.run()
    task.waitUntilExit()
}

var downloadsStamp: Date?
var recheckDownloads = 0
var reportedDownload: String?
var reported: Int?
var pending: (height: Int, since: Date)?
var lastChange = Date.distantPast
while true {
    if let h = cmuxWindowHeight(), h != reported {
        lastChange = Date()
        // Report once the size has held for a moment, not on every frame of a drag.
        if pending?.height != h {
            pending = (h, Date())
        } else if let p = pending, Date().timeIntervalSince(p.since) >= 0.3 {
            runSync(["--window", String(h)])
            reported = h
            pending = nil
        }
    }
    // Downloads: only the folder's modification date is read each pass; the listing
    // happens when something arrived.
    // A screenshot appears as a hidden temp file first and is renamed a moment later,
    // so after any change look again on the next few passes.
    let stamp = (try? downloads.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
    if stamp != downloadsStamp {
        downloadsStamp = stamp
        recheckDownloads = 5
    }
    if recheckDownloads > 0 {
        recheckDownloads -= 1
        if let newest = newestDownload(), newest.path != reportedDownload {
            runSync(["--download", String(Int(newest.added.timeIntervalSince1970)), newest.path])
            reportedDownload = newest.path
            FileHandle.standardError.write("download: \(newest.path)\n".data(using: .utf8)!)
        }
    }
    Thread.sleep(forTimeInterval: Date().timeIntervalSince(lastChange) < 3 ? 0.2 : 1.0)
}
