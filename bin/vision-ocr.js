// 傳一張圖認字：stdin 給圖片（JPEG／PNG 的 base64），stdout 回 {"items":[{ text, x, y, w, h }]}（0–1、左上角原點），
// 圖解不開回 {"error":"..."}。認字設定在 vision.js（跟 AX 小幫手截視窗認字同一份）。
// 用法：base64 -i shot.png | osascript -l JavaScript bin/vision-ocr.js
// 平行沙盒桌面版用 scripts/sync-mac-ocr.sh 同步一份（vision.js 併進同一個檔），在 Mac 上認接管畫面那一格。
ObjC.import('Foundation');
ObjC.import('CoreGraphics');
ObjC.import('ImageIO');

// 跟 vision.js 放在一起時讀進來；同步出去的單一檔案已經併好了
if (typeof visionItems !== 'function') {
  const self = ObjC.unwrap($.NSProcessInfo.processInfo.arguments).map((a) => ObjC.unwrap(a)).find((a) => a.endsWith('vision-ocr.js'));
  eval(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(`${self.replace(/vision-ocr\.js$/, '')}vision.js`, $.NSUTF8StringEncoding, null)));
}

function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const base64 = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)).trim();
  const data = $.NSData.alloc.initWithBase64EncodedStringOptions($(base64), 1); // 忽略換行等非 base64 字元
  const source = data && !data.isNil() ? $.CGImageSourceCreateWithData(data, $()) : null;
  const image = source ? $.CGImageSourceCreateImageAtIndex(source, 0, $()) : null;
  if (!image) return JSON.stringify({ error: '圖片解不開' });
  return JSON.stringify({ items: visionItems(image) });
}
