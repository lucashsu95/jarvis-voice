// Mac 的「傳一張圖認字」（bin/vision-ocr.js，跟 AX 小幫手共用 bin/vision.js）：畫一張有中英文的圖，看認不認得出來；
// 同步給平行沙盒桌面版的單一檔案（scripts/sync-mac-ocr.sh）也要一樣能用。只在 macOS 跑。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ocrText } from '../core/ocr.mjs';

const ROOT = join(import.meta.dirname, '..');
const skip = process.platform !== 'darwin' && '只有 macOS 有 Vision';
const work = mkdtempSync(join(tmpdir(), 'jarvis-vision-'));

function recognize(script, input) {
  const out = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', script], { input, timeout: 30_000 }).toString();
  return JSON.parse(out);
}

test('傳一張圖認字：中英文都認得出來，位置是 0–1、左上角原點，順序交給核心', { skip, timeout: 60_000 }, () => {
  const png = join(work, 'text.png');
  execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', join(ROOT, 'tests', 'fixtures', 'text-image.js'), png, '平行沙盒 驗收清單', 'Submit 送出']);
  const { items } = recognize(join(ROOT, 'bin', 'vision-ocr.js'), readFileSync(png).toString('base64'));
  const text = ocrText(items);
  assert.match(text, /平行沙盒/, text);
  assert.match(text, /驗收/, text);
  assert.match(text, /Submit/, text);
  assert.ok(text.indexOf('平行沙盒') < text.indexOf('Submit'), `上面那行先：${text}`);
  for (const i of items) assert.ok(i.x >= 0 && i.y >= 0 && i.x + i.w <= 1.001 && i.y + i.h <= 1.001, JSON.stringify(i));
  assert.deepEqual(recognize(join(ROOT, 'bin', 'vision-ocr.js'), 'not an image'), { error: '圖片解不開' });

  // 同步出去的單一檔案（vision.js 併進來）
  const synced = join(work, 'screen-text-macos.js');
  try {
    execFileSync(join(ROOT, 'scripts', 'sync-mac-ocr.sh'), [synced], { stdio: 'pipe' });
  } catch (err) {
    if (String(err.stderr).includes('還沒 commit')) return; // 開發中還沒 commit：略過同步這段
    throw err;
  }
  assert.match(readFileSync(synced, 'utf8'), /^\/\/ 從 jarvis-voice@\w+ 的 bin\/vision\.js/);
  assert.match(ocrText(recognize(synced, readFileSync(png).toString('base64')).items), /平行沙盒/);
});
