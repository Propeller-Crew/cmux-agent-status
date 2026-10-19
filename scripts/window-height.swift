// Prints the height (points) of cmux's main window, so the sidebar can push its
// activity card to the bottom: a cmux sidebar can't pin anything there itself.
// Compiled by install.sh to ~/.config/cmux/bin/cmux-window-height.
import CoreGraphics

let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []
let heights = windows
    .filter { ($0[kCGWindowOwnerName as String] as? String) == "cmux" && ($0[kCGWindowLayer as String] as? Int) == 0 }
    .compactMap { ($0[kCGWindowBounds as String] as? [String: Any])?["Height"] as? Double }
if let tallest = heights.max() { print(Int(tallest)) }
