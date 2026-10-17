// 本機歷史：每段寫進去的原稿、AI 整理後的字、app、時間，一行一個 JSON（只存在這台電腦）。
// 超過 2 MB 換一個檔，留一份舊的。

import { appendFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './config.mjs';

export const HISTORY = join(STATE_DIR, 'history.jsonl');
const MAX_BYTES = 2_000_000;

export function appendHistory(entry) {
  try {
    if (statSync(HISTORY).size > MAX_BYTES) renameSync(HISTORY, join(STATE_DIR, 'history.1.jsonl'));
  } catch { /* 還沒有檔案 */ }
  try {
    appendFileSync(HISTORY, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch { /* 寫不進就算了 */ }
}
