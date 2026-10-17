// Mac 小程式的詞彙表自動更新：規則與上限在核心（core/vocab.mjs），這裡把狀態存在檔案、用自己的 key 從畫面挑詞。
// 狀態記在 <狀態資料夾>/vocabulary-auto.json；詞彙檔是設定檔的 openai.vocabularyFile。

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createVocabAuto as coreCreateVocabAuto } from '../core/vocab.mjs';
import { STATE_DIR } from './config.mjs';
import { ask } from './editor.mjs';

export { AUTO_HEADER, splitVocabulary, plausibleTerm, score } from '../core/vocab.mjs';

// settings() → { enabled, max, maxAuto, minSightings, vocabularyFile, ai（沒有就不從畫面挑） }
export function createVocabAuto({ log = () => {}, settings, storeFile = join(STATE_DIR, 'vocabulary-auto.json') }) {
  const vocabPath = () => settings().vocabularyFile.replace(/^~(?=\/)/, homedir());
  const store = {
    loadState: () => {
      try { return JSON.parse(readFileSync(storeFile, 'utf8')); } catch { return null; }
    },
    saveState: (state) => {
      const tmp = `${storeFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 1));
      renameSync(tmp, storeFile);
    },
    readVocab: () => (existsSync(vocabPath()) ? readFileSync(vocabPath(), 'utf8') : ''),
    writeVocab: (text) => writeFileSync(vocabPath(), text),
  };
  return coreCreateVocabAuto({
    log,
    store,
    settings: () => {
      const s = settings();
      return { ...s, complete: s.ai?.apiKey ? (req) => ask({ ...s.ai, ...req }) : null };
    },
  });
}
