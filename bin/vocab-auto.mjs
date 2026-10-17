// 詞彙表自動更新：從畫面上的字和使用者自己的改字，挑出新的專有名詞加進詞彙檔的「自動學到」區。
// 不是看到就加：
//   - 畫面上的詞先當候選，要在 3 次不同的時候（相隔 10 分鐘以上）都看到，或使用者真的講出來了（AI 整理後的字裡有它），才加。
//   - 使用者貼上後自己改字改出來的專有名詞，直接加。
// 有上限：整張詞彙表最多 max 個、自動學到的最多 maxAuto 個；滿了先拿掉最少用到、最久沒用到的自動詞。
// 使用者自己寫的詞永遠不動。狀態記在 <狀態資料夾>/vocabulary-auto.json。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { STATE_DIR } from './config.mjs';
import { ask } from './editor.mjs';

export const AUTO_HEADER = '# 自動學到（JarvisVoice 自動維護：從畫面和你的改字學到的專有名詞，有上限，不要的直接刪掉）';
const OLD_HEADERS = ['# 自動學到（貼上後你自己改過的詞，不要的直接刪掉）'];
const OCCASION_MS = 10 * 60_000; // 相隔這麼久才算另一次看到
const EXTRACT_EVERY_MS = 2 * 60_000; // 最多這麼久從畫面挑一次詞
const MAX_CANDIDATES = 300;
const PRIORITY = { edit: 30, heard: 20, screen: 0 };

const DEFAULTS = { enabled: true, max: 250, maxAuto: 80, minSightings: 3 };

const norm = (t) => t.trim().toLowerCase();

// 詞彙檔拆成「使用者自己寫的」和「自動學到的」兩段
export function splitVocabulary(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trim() === AUTO_HEADER || OLD_HEADERS.includes(l.trim()));
  const manualLines = at < 0 ? lines : lines.slice(0, at);
  const autoLines = at < 0 ? [] : lines.slice(at + 1);
  const words = (ls) => ls.map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  return { manualText: manualLines.join('\n').replace(/\n+$/, ''), manual: words(manualLines), auto: words(autoLines) };
}

// 看起來像能講出口的專有名詞才收：不要網址、email、路徑、純數字、太長太短
export function plausibleTerm(term) {
  const t = String(term ?? '').trim();
  if (t.length < 2 || t.length > 40) return false;
  if (/[<>\n@]|https?:|www\.|\/|\\|^\d+$|^[\d\s.,:%-]+$/.test(t)) return false;
  return /[\p{L}]/u.test(t);
}

export function score(entry, now = Date.now()) {
  const last = entry.lastHit ?? entry.addedAt ?? 0;
  const days = (now - last) / 86_400_000;
  return (entry.hits ?? 0) * 10 + (PRIORITY[entry.source] ?? 0) - Math.min(days, 60);
}

const EXTRACT_PROMPT = `從 <screen>（使用者電腦畫面上看得到的字）裡挑出使用者可能會用講的提到的專有名詞：產品、公司、專案、人名、技術名詞、縮寫。
只挑名字本身（例如「JarvisVoice」「DeepSeek」「Route 53」），不要一般詞、句子、網址、email、檔案路徑、數字、介面按鈕上的一般字（例如「設定」「搜尋」「New session」）。
最多 15 個；沒有就給空陣列。只輸出 JSON：{"terms": ["..."]}`;

const TERMS_SCHEMA = {
  type: 'object',
  properties: { terms: { type: 'array', items: { type: 'string' } } },
  required: ['terms'],
  additionalProperties: false,
};

// settings() → { enabled, max, maxAuto, minSightings, vocabularyFile, ai（editor.ask 的參數，沒有就不從畫面挑） }
export function createVocabAuto({ log = () => {}, settings, storeFile = join(STATE_DIR, 'vocabulary-auto.json') }) {
  let store = null;
  let lastExtractAt = 0;
  let lastScreenHash = '';
  let extracting = false;

  const conf = () => ({ ...DEFAULTS, ...settings() });
  const vocabPath = () => conf().vocabularyFile.replace(/^~(?=\/)/, homedir());

  function readVocab() {
    const path = vocabPath();
    return splitVocabulary(existsSync(path) ? readFileSync(path, 'utf8') : '');
  }

  function load() {
    if (store) return store;
    try { store = JSON.parse(readFileSync(storeFile, 'utf8')); } catch { store = null; }
    store ??= { terms: {}, candidates: {} };
    store.terms ??= {};
    store.candidates ??= {};
    // 舊版直接寫進詞彙檔的自動詞，搬進來當「改字學到的」
    for (const word of readVocab().auto) {
      if (!Object.keys(store.terms).some((k) => norm(k) === norm(word))) store.terms[word] = { source: 'edit', addedAt: Date.now(), hits: 0 };
    }
    return store;
  }

  function save() {
    const tmp = `${storeFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 1));
    renameSync(tmp, storeFile);
  }

  // 只重寫詞彙檔最後的「自動學到」區，使用者自己寫的那段原封不動
  function writeVocab() {
    const { manualText } = readVocab();
    const words = Object.entries(store.terms).sort((a, b) => (a[1].addedAt ?? 0) - (b[1].addedAt ?? 0)).map(([w]) => w);
    const body = words.length ? `\n\n${AUTO_HEADER}\n${words.join('\n')}\n` : '\n';
    writeFileSync(vocabPath(), `${manualText}${body}`);
  }

  const known = (word) => {
    const n = norm(word);
    return readVocab().manual.some((w) => norm(w) === n) || Object.keys(load().terms).some((w) => norm(w) === n);
  };

  // 加一個詞；滿了就拿掉分數最低的自動詞（比新詞分數低才拿）。回傳有沒有加進去
  function promote(word, source, now = Date.now()) {
    const term = String(word ?? '').trim();
    if (!plausibleTerm(term) || known(term)) return false;
    const c = conf();
    const s = load();
    const manualCount = readVocab().manual.length;
    if (manualCount >= c.max) {
      log(`詞彙表滿了（你自己寫的就有 ${manualCount} 個，上限 ${c.max}），不加「${term}」`);
      return false;
    }
    const fresh = { source, addedAt: now, hits: source === 'heard' ? 1 : 0, lastHit: source === 'heard' ? now : undefined };
    const room = () => Object.keys(s.terms).length < Math.min(c.maxAuto, c.max - manualCount);
    if (!room()) {
      const [weakest, entry] = Object.entries(s.terms).sort((a, b) => score(a[1], now) - score(b[1], now))[0] ?? [];
      if (!weakest || score(entry, now) >= score(fresh, now)) {
        log(`自動學到的詞滿了（上限 ${Math.min(c.maxAuto, c.max - manualCount)}），「${term}」不夠優先，先不加`);
        return false;
      }
      delete s.terms[weakest];
      log(`自動學到的詞滿了，拿掉最少用到的「${weakest}」`);
    }
    s.terms[term] = fresh;
    for (const k of Object.keys(s.candidates)) if (norm(k) === norm(term)) delete s.candidates[k];
    save();
    writeVocab();
    log(`詞彙表自動加入「${term}」（${{ edit: '你自己改的字', heard: '你講到了', screen: '畫面上一直出現' }[source]}）`);
    return true;
  }

  // 畫面上看到這些詞：記一次（相隔 10 分鐘以上才算新的一次），夠多次就加
  function observe(terms, now = Date.now()) {
    const s = load();
    for (const raw of terms) {
      const term = String(raw ?? '').trim();
      if (!plausibleTerm(term) || known(term)) continue;
      const key = Object.keys(s.candidates).find((k) => norm(k) === norm(term)) ?? term;
      const c = s.candidates[key] ?? { seen: 0, first: now, last: 0 };
      if (now - c.last >= OCCASION_MS) c.seen += 1;
      c.last = now;
      s.candidates[key] = c;
      if (c.seen >= conf().minSightings) promote(key, 'screen', now);
    }
    // 候選太多就丟掉最久沒看到的
    const keys = Object.keys(s.candidates);
    if (keys.length > MAX_CANDIDATES) {
      keys.sort((a, b) => s.candidates[a].last - s.candidates[b].last).slice(0, keys.length - MAX_CANDIDATES).forEach((k) => delete s.candidates[k]);
    }
    save();
  }

  // 寫進去的字裡用到了哪些自動詞：記一筆（分數靠這個，滿了先拿掉沒在用的）
  function noteHits(text, now = Date.now()) {
    if (!text) return;
    const s = load();
    const lower = text.toLowerCase();
    let changed = false;
    for (const [word, entry] of Object.entries(s.terms)) {
      if (lower.includes(norm(word))) { entry.hits = (entry.hits ?? 0) + 1; entry.lastHit = now; changed = true; }
    }
    if (changed) save();
  }

  // 候選詞被講出來了（寫進去的字裡有它）：直接加
  function promoteHeard(text, now = Date.now()) {
    if (!text) return;
    const lower = text.toLowerCase();
    for (const word of Object.keys(load().candidates)) {
      if (lower.includes(norm(word))) promote(word, 'heard', now);
    }
  }

  async function extract(screen) {
    const raw = await ask({
      ...conf().ai, system: EXTRACT_PROMPT, schema: TERMS_SCHEMA, user: `<screen>${screen}</screen>`, timeoutMs: 10_000,
    });
    const terms = JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0] ?? '{}').terms ?? [];
    return terms.filter(plausibleTerm).slice(0, 15);
  }

  return {
    promote,
    observe,
    noteHits,
    promoteHeard,
    // 一段寫完之後叫：先記用到的詞，再（不太頻繁地）從畫面挑候選
    async afterSegment({ screen = '', text = '' }, now = Date.now()) {
      const c = conf();
      if (!c.enabled) return;
      try {
        noteHits(text, now);
        promoteHeard(text, now);
        if (!screen || !c.ai?.apiKey || extracting || now - lastExtractAt < EXTRACT_EVERY_MS) return;
        const hash = createHash('sha1').update(screen).digest('hex');
        if (hash === lastScreenHash) return;
        extracting = true;
        lastExtractAt = now;
        lastScreenHash = hash;
        const terms = await extract(screen);
        observe(terms, now);
        promoteHeard(text, now); // 剛成為候選、這段又講到的，直接加
      } catch (err) {
        log(`從畫面挑詞失敗：${err.message}`);
      } finally {
        extracting = false;
      }
    },
  };
}
