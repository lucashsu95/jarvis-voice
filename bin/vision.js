// 蘋果 Vision 認字（JXA）：Mac 小程式的 AX 小幫手（截視窗）和 vision-ocr.js（傳一張圖進來，平行沙盒桌面版同步一份去用）
// 共用這一份設定。精準模式（快速模式認不出中文）、繁中＋簡中＋英文、開語言校正。圖片只在記憶體裡，認完就丟。
// visionItems(cgImage) → [{ text, x, y, w, h }]：位置是 0–1、左上角原點；排順序、接成文字在核心（core/ocr.mjs）。
ObjC.import('Vision');

function visionItems(image) {
  const handler = $.VNImageRequestHandler.alloc.initWithCGImageOptions(image, $.NSDictionary.dictionary);
  const request = $.VNRecognizeTextRequest.alloc.init;
  request.setRecognitionLevel(0); // 精準
  request.setRecognitionLanguages($(['zh-Hant', 'zh-Hans', 'en-US']));
  request.setUsesLanguageCorrection(true);
  handler.performRequestsError($([request]), null);
  const items = [];
  const results = request.results;
  for (let i = 0; results && i < results.count; i += 1) {
    const obs = results.objectAtIndex(i);
    const text = (ObjC.unwrap(obs.topCandidates(1).objectAtIndex(0).string) || '').trim();
    const b = obs.boundingBox; // 0–1，左下角原點
    if (!text) continue;
    items.push({ text, x: b.origin.x, y: 1 - b.origin.y - b.size.height, w: b.size.width, h: b.size.height });
  }
  return items;
}
