// Copies cmux's own Claude agent icon (the one on Claude tabs) to a PNG for the
// tab-bar button. Extracted at install time instead of shipping someone else's logo.
// Usage: swift extract-claude-icon.swift <out.png>
import AppKit

guard let bundle = Bundle(path: "/Applications/cmux.app"),
      let image = bundle.image(forResource: "AgentIcons/Claude") else {
    print("cmux's Claude icon not found"); exit(1)
}
let side = 56
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                           bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
image.draw(in: NSRect(x: 0, y: 0, width: side, height: side))
NSGraphicsContext.restoreGraphicsState()
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
