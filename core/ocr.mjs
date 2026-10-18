// JarvisVoice 核心：截圖認字的結果怎麼變成給 AI 整理的「畫面上的字」。Mac 小程式（Vision）、平行沙盒（iPhone Vision、
// Android ML Kit、Electron）都用這一份：各平台只負責把圖認成一段段字和位置，排順序、接成文字、跟其他上下文合在字數內都在這裡。
// 位置用什麼單位都可以（螢幕點、像素、0–1），只要同一次辨識裡一致；原點在左上角。

// 由上往下、由左往右。上緣差不到半個字高的算同一行（不同平台、不同解析度都適用，不用固定像素）
export function readingOrder(items) {
  const list = (items ?? []).filter((i) => i && String(i.text ?? '').trim());
  const sameRow = (a, b) => Math.abs(a.y - b.y) < Math.min(a.h || 0, b.h || 0) / 2;
  return [...list].sort((a, b) => (sameRow(a, b) ? a.x - b.x : a.y - b.y));
}

// 認出來的字接成一段：同一行用空白接、換行分行；太長留最後 maxChars 個字（跟讀得到字的畫面一樣取最後面）
export function ocrText(items, { maxChars = 1500 } = {}) {
  const rows = [];
  let row = null;
  for (const item of readingOrder(items)) {
    const text = String(item.text).trim();
    if (row && Math.abs(item.y - row.y) < Math.min(item.h || 0, row.h || 0) / 2) row.parts.push(text);
    else rows.push(row = { y: item.y, h: item.h, parts: [text] });
  }
  return clipTail(rows.map((r) => r.parts.join(' ')).join('\n'), maxChars);
}

// 幾段上下文（例如箱子目標與步驟、截圖認出的字）合成一段，總長不超過 maxChars：超過就從長的段前面砍
// （先砍最長的，砍到跟次長的一樣長再一起砍），每段留最後面；空的段不放
export function joinScreen(sections, { maxChars = 1500 } = {}) {
  const parts = (sections ?? []).map((s) => String(s ?? '').trim()).filter(Boolean);
  const budget = maxChars - Math.max(0, parts.length - 1); // 段與段之間一個換行
  const fits = (cap) => parts.reduce((n, p) => n + Math.min(p.length, cap), 0) <= budget;
  let cap = Math.max(0, ...parts.map((p) => p.length));
  if (!fits(cap)) {
    let lo = 0;
    while (lo < cap) {
      const mid = Math.ceil((lo + cap) / 2);
      if (fits(mid)) lo = mid; else cap = mid - 1;
    }
  }
  return parts.map((p) => clipTail(p, cap)).filter(Boolean).join('\n');
}

const clipTail = (text, max) => (text.length > max ? text.slice(text.length - max) : text);
