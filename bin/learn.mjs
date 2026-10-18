// Mac 小程式的自動學詞：比對與流程在核心（core/learn.mjs），這裡用 AX 小幫手讀輸入框、用自己的 key 問 AI。

import { createLearner as coreCreateLearner } from '../core/learn.mjs';
import { ask } from './editor.mjs';

export { extractEdited, replacedChunks } from '../core/learn.mjs';

// settings() → { enabled, ai }；promote(詞, 'edit') 交給詞彙表自動更新
// onCorrection({ ai, final, chunks })：使用者改字時記一筆（ai-log，練 BIRC-LLM 用）
export function createLearner({ ax, log, settings, promote, onCorrection }) {
  return coreCreateLearner({
    read: async (handle) => (await ax.call('read', { handle })).value,
    log,
    settings: () => {
      const s = settings();
      return { enabled: s.enabled, complete: (req) => ask({ ...s.ai, ...req }) };
    },
    promote,
    onCorrection,
  });
}
