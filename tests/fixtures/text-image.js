// 測試用：把幾行字畫成一張白底 PNG（給 Vision 認字測試）。
// 用法：osascript -l JavaScript text-image.js <輸出.png> <第一行> [第二行…]
ObjC.import('Cocoa');

function run(argv) {
  const [out, ...lines] = argv;
  const W = 900;
  const H = 120 + lines.length * 70;
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, W, H, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  $.NSColor.whiteColor.set;
  $.NSBezierPath.fillRect($.NSMakeRect(0, 0, W, H));
  const attrs = $.NSDictionary.dictionaryWithObjectsForKeys(
    $([$.NSFont.systemFontOfSize(40), $.NSColor.blackColor]), $([$.NSFontAttributeName, $.NSForegroundColorAttributeName]));
  lines.forEach((line, i) => $(line).drawAtPointWithAttributes($.NSMakePoint(40, H - 100 - i * 70), attrs));
  $.NSGraphicsContext.restoreGraphicsState;
  rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically($(out), true);
  return out;
}
