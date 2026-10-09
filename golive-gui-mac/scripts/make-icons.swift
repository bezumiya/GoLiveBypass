// Gera os ícones do app: resources/tray/iconTemplate(@2x).png e build/icon.icns.
// Uso: swift scripts/make-icons.swift   (na pasta golive-gui-mac)
import AppKit

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)

func png(_ size: Int, _ draw: (CGContext, CGFloat) -> Void) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                             bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                             colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  draw(NSGraphicsContext.current!.cgContext, CGFloat(size))
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

// Tela com um triângulo de "play" vazado: transmissão ao vivo.
func glyph(_ c: CGContext, _ s: CGFloat, color: CGColor, inset: CGFloat) {
  c.beginTransparencyLayer(auxiliaryInfo: nil)
  defer { c.endTransparencyLayer() }
  let w = s - inset * 2
  let screen = CGRect(x: inset, y: inset + w * 0.22, width: w, height: w * 0.62)
  c.setFillColor(color)
  c.addPath(CGPath(roundedRect: screen, cornerWidth: w * 0.12, cornerHeight: w * 0.12, transform: nil))
  c.fillPath()
  // Pé do monitor
  c.fill(CGRect(x: inset + w * 0.30, y: inset + w * 0.06, width: w * 0.40, height: w * 0.08))
  c.fill(CGRect(x: inset + w * 0.45, y: inset + w * 0.10, width: w * 0.10, height: w * 0.14))
  // Play vazado
  c.setBlendMode(.clear)
  let cx = screen.midX + w * 0.03, cy = screen.midY, r = w * 0.17
  c.move(to: CGPoint(x: cx - r * 0.75, y: cy + r))
  c.addLine(to: CGPoint(x: cx + r, y: cy))
  c.addLine(to: CGPoint(x: cx - r * 0.75, y: cy - r))
  c.closePath()
  c.fillPath()
  c.setBlendMode(.normal)
}

let tray = root.appendingPathComponent("resources/tray")
try FileManager.default.createDirectory(at: tray, withIntermediateDirectories: true)
for (name, size) in [("iconTemplate.png", 18), ("iconTemplate@2x.png", 36)] {
  try png(size) { c, s in glyph(c, s, color: CGColor(gray: 0, alpha: 1), inset: s * 0.04) }
    .write(to: tray.appendingPathComponent(name))
}

let iconset = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("GoLiveBypass.iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
func appIcon(_ c: CGContext, _ s: CGFloat) {
  // Fundo no padrão de ícone do macOS: quadrado arredondado com margem
  let m = s * 0.1, box = CGRect(x: m, y: m, width: s - 2 * m, height: s - 2 * m)
  c.addPath(CGPath(roundedRect: box, cornerWidth: box.width * 0.225, cornerHeight: box.width * 0.225, transform: nil))
  c.clip()
  let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
    CGColor(red: 0.98, green: 0.30, blue: 0.36, alpha: 1), CGColor(red: 0.62, green: 0.13, blue: 0.42, alpha: 1),
  ] as CFArray, locations: [0, 1])!
  c.drawLinearGradient(grad, start: CGPoint(x: box.minX, y: box.maxY), end: CGPoint(x: box.maxX, y: box.minY), options: [])
  c.resetClip()
  glyph(c, s, color: CGColor(gray: 1, alpha: 1), inset: s * 0.26)
}
for base in [16, 32, 128, 256, 512] {
  for scale in [1, 2] {
    let suffix = scale == 2 ? "@2x" : ""
    try png(base * scale, appIcon).write(to: iconset.appendingPathComponent("icon_\(base)x\(base)\(suffix).png"))
  }
}
let build = root.appendingPathComponent("build")
try FileManager.default.createDirectory(at: build, withIntermediateDirectories: true)
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", iconset.path, "-o", build.appendingPathComponent("icon.icns").path]
try p.run(); p.waitUntilExit()
guard p.terminationStatus == 0 else { fatalError("iconutil falhou") }
print("ícones gerados")
