// 資料記錄：一行一個 JSON 到 <狀態資料夾>/ai-log.jsonl，之後拿去 SFT／DPO 練 BIRC-LLM。
//   type:"ai-call"    每次打 AI 的一筆：kind（edit／terms／other）、prompt、模型原樣回傳、耗時、token 用量
//   type:"correction" AI 貼上的字被使用者自己改過：ai（貼上的版本）vs final（你的最終版）、chunks（被換掉的片段）、
//                     以及這段話的原始上下文（raw 原稿、app、window、cleaned 是不是 AI 整理過的）——自成一筆，不用去對時間
// 超過 2 MB 輪轉成 ai-log.jsonl.1（上一代覆蓋）。環境變數 VOICE_DICTATION_AI_LOG=off 關掉。寫檔失敗不影響主流程。
// 注意：user 欄位含螢幕上看得到的字（視窗文字、網址），這份檔等同螢幕錄影的文字版，不要外流、別讓備份外流。
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './config.mjs';

const MAX_BYTES = 2_000_000;

export function aiLog(record) {
  if (process.env.VOICE_DICTATION_AI_LOG === 'off') return;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const file = join(STATE_DIR, 'ai-log.jsonl');
    try { if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`); } catch { /* 第一次寫沒有檔 */ }
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
  } catch { /* 記不到就算了，不打斷輸入 */ }
}
