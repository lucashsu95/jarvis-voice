// 自動學個人字典（Typeless 的「自動加詞」）：AI 整理後的字貼進去，接下來 30 秒每 3 秒讀一次那個輸入框，
// 看使用者有沒有自己改字。有改到某些字（不是只在後面多打），請 AI 挑出被改正的專有名詞，加進詞彙檔，
// 下次轉寫和整理都會照這個寫法。

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { ask } from './editor.mjs';
import { readVocabulary } from './config.mjs';

const WATCH_MS = 30_000;
const POLL_MS = 3_000;
const ANCHOR = 20;
const HEADER = '# 自動學到（貼上後你自己改過的詞，不要的直接刪掉）';

// 從輸入框現在的字裡，找出原本貼進去那段現在長怎樣：用貼上時游標前後的字當錨點
export function extractEdited(value, before = '', after = '') {
  if (typeof value !== 'string') return null;
  const head = before.slice(-ANCHOR);
  const tail = after.slice(0, ANCHOR);
  const at = head ? value.indexOf(head) : 0;
  if (at < 0) return null;
  const start = at + head.length;
  const end = tail ? value.indexOf(tail, start) : value.length;
  if (end < 0) return null;
  return value.slice(start, end);
}

// 逐字比對 a → b，回傳被換掉的片段 [{ from, to }]（只在後面多打、只刪掉的不算）
export function replacedChunks(a, b) {
  if (a.length > 1000 || b.length > 1000) return [];
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const chunks = [];
  let from = '';
  let to = '';
  const flush = () => {
    if (from.trim() && to.trim()) chunks.push({ from, to });
    from = '';
    to = '';
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i += 1; j += 1; } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { to += b[j]; j += 1; } else { from += a[i]; i += 1; }
  }
  flush();
  return chunks;
}

// 加進詞彙檔（已經有的不重複加）
export function appendVocabulary(file, terms) {
  const path = file.replace(/^~(?=\/)/, homedir());
  const have = new Set(readVocabulary(path).map((w) => w.toLowerCase()));
  const fresh = [...new Set(terms.map((t) => t.trim()).filter((t) => t && t.length <= 40 && !/[<>\n]/.test(t)))]
    .filter((t) => !have.has(t.toLowerCase()));
  if (!fresh.length) return [];
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lead = text && !text.endsWith('\n') ? '\n' : '';
  appendFileSync(path, `${lead}${text.includes(HEADER) ? '' : `\n${HEADER}\n`}${fresh.join('\n')}\n`);
  return fresh;
}

const LEARN_PROMPT = `使用者用語音輸入貼上了 <pasted> 這段字，之後自己動手改成 <edited>。
找出使用者改正的專有名詞或特殊寫法（人名、產品名、公司名、技術名詞、縮寫、大小寫或拼法固定的詞），列出改正後的寫法。
一般用字、語氣、標點、加減內容的修改都不算。沒有就給空陣列。只輸出 JSON：{"terms": ["..."]}`;

const TERMS_SCHEMA = {
  type: 'object',
  properties: { terms: { type: 'array', items: { type: 'string' } } },
  required: ['terms'],
  additionalProperties: false,
};

// 盯著一段剛貼的字：{ handle, inserted, before, after }。tick() 由常駐程式每半秒叫一次
export function createLearner({ ax, log, settings }) {
  let watch = null;

  async function finish(w) {
    const edited = w.latest;
    if (edited === null || edited === w.inserted) return;
    const chunks = replacedChunks(w.inserted.trim(), edited.trim());
    if (!chunks.length) return;
    const s = settings();
    if (!s.enabled) return;
    try {
      const raw = await ask({
        ...s.ai, system: LEARN_PROMPT, schema: TERMS_SCHEMA,
        user: `<pasted>${w.inserted}</pasted>\n<edited>${edited}</edited>`,
      });
      const terms = JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0] ?? '{}').terms ?? [];
      const added = appendVocabulary(s.vocabularyFile, terms);
      log(added.length ? `自動學到新詞：${added.join('、')}（寫進詞彙檔）` : `看到改字（${chunks.map((c) => `${c.from}→${c.to}`).join('、')}），沒有要學的專有名詞`);
    } catch (err) {
      log(`自動學詞失敗：${err.message}`);
    }
  }

  return {
    watch(next) {
      if (watch) void finish(watch);
      watch = { ...next, latest: null, until: Date.now() + WATCH_MS, nextAt: Date.now() + POLL_MS, busy: false };
    },
    async tick() {
      const w = watch;
      if (!w || w.busy || Date.now() < w.nextAt) return;
      w.busy = true;
      try {
        const { value } = await ax.call('read', { handle: w.handle });
        const edited = extractEdited(value, w.before, w.after);
        // 欄位清空（訊息送出了）或錨點不見了，就用最後一次看到的版本
        const gone = edited === null || (!edited.trim() && w.latest !== null);
        if (!gone) w.latest = edited;
        if (gone || Date.now() >= w.until) {
          if (watch === w) watch = null;
          await finish(w);
          return;
        }
      } catch {
        if (watch === w) watch = null;
        return;
      } finally {
        w.busy = false;
      }
      w.nextAt = Date.now() + POLL_MS;
    },
  };
}
