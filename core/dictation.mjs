// JarvisVoice 核心：輸入框聽寫（按下錄音、停下後寫進輸入框或送出）的寫回規則。CubeLV、平行沙盒的輸入框共用這一份。
// 停下後整段原稿先用 editSegment 整理（第二層：去贅字、改口只留結果、條列、標點、專有名詞），再照這裡的規則
// 併進輸入框原本的字、決定要不要送出、留不留「換回原文」。

import { editSegment } from './editor.mjs';
import { isSpeech } from './text.mjs';

export const POLISH_TIMEOUT_MS = 6000;

// polishTranscript —— 整理一段原稿。不會丟錯：
//   { kind: 'polished', text }：整理好的字（只有新講的這段，不含輸入框原本的字）
//   { kind: 'empty' }：整段只有語氣詞（嗯、呃、um 這類），不寫
//   { kind: 'raw', reason }：照原稿寫；reason 是 unsupported（不像人話、模型回了這裡不處理的 mode）、timeout、failed
// complete({ system, user, schema, signal })：打模型，逾時會 abort signal。只開 insert／replace_selection（不開指令模式）。
export async function polishTranscript({ transcript, complete, context = {}, vocabulary, timeoutMs = POLISH_TIMEOUT_MS, log }) {
  if (!isSpeech(transcript)) return { kind: 'raw', reason: 'unsupported' };
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve('timeout'); }, timeoutMs);
  });
  try {
    const result = await Promise.race([
      editSegment({ complete: (request) => complete({ ...request, signal: controller.signal }), transcript, context, vocabulary, commands: false }),
      timeout,
    ]);
    if (result === 'timeout') {
      log?.(`AI 整理超過 ${timeoutMs} ms，照原稿`);
      return { kind: 'raw', reason: 'timeout' };
    }
    // 沒給 <selected>，模型回 replace_selection 也只當成要插入的字
    if (result.mode !== 'insert' && result.mode !== 'replace_selection') return { kind: 'raw', reason: 'unsupported' };
    const text = result.text.trim();
    if (!text) return { kind: 'empty' };
    return { kind: 'polished', text };
  } catch (error) {
    if (controller.signal.aborted) return { kind: 'raw', reason: 'timeout' };
    log?.(`AI 整理沒成功，照原稿：${error?.message ?? error}`);
    return { kind: 'raw', reason: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

// mergeTranscript —— 原稿接在輸入框原本的字後面（中間空一格）。照原稿寫時用它。
export function mergeTranscript(base, transcript) {
  if (!transcript) return base;
  return base ? `${base} ${transcript}` : transcript;
}

// joinPolished —— 整理後的字接在原本的字後面：AI 已經看過 <before>，中文接中文直接接；
// 英文、數字與中文交界、或 AI 自己要空白時空一格；原本的字結尾已經有空白、換行就不再補。
export function joinPolished(base, text) {
  const body = String(text ?? '').trim();
  if (!base) return body;
  if (!body) return base;
  if (/\s$/.test(base)) return base + body;
  const last = base.slice(-1);
  const space = /^[ \t]/.test(text)
    || /[A-Za-z0-9.,!?;:)]/.test(last)
    || (/^[A-Za-z0-9]/.test(body) && !/[　-〿＀-￯]/.test(last));
  return base + (space ? ' ' : '') + body;
}

// changedWords —— 整理有沒有動到字（不算標點、空白、大小寫）；只補了標點就不用再請人看一次。
export function changedWords(raw, text) {
  const squash = (value) => String(value).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  return squash(raw) !== squash(text);
}

// 換回原文要的東西：base 是錄音前輸入框的字，raw 是原稿，text 是整理後的字（空字串＝AI 判斷只有語氣詞、沒寫），
// written 是寫進去的整段。

// revertPolish —— 「換回原文」之後輸入框該是什麼；找不到整理後的那段（已經被改掉）回 null。
// readBack：寫進去之後輸入框讀回來的值（輸入框可能把空白、換行正規化），跟 written 一樣算「還沒動過」。
export function revertPolish(current, revert, readBack) {
  if (current === revert.written || (readBack !== undefined && current === readBack)) return mergeTranscript(revert.base, revert.raw);
  if (!revert.text) return mergeTranscript(current, revert.raw);
  const at = current.lastIndexOf(revert.text);
  if (at < 0) return null;
  return current.slice(0, at) + revert.raw + current.slice(at + revert.text.length);
}

// applyPolish —— 停下後輸入框要寫成什麼（input）、要不要送出（send）、留不留換回原文（revert）、
// 要不要先讓人看一次（review，回報編輯器用）、要不要提示（notice）：
//   polished：整理後的字接在原本的字後面；插入時有改到才留換回原文，改到字（不只標點）才要人再看一次。送出就直接送。
//   empty：整段只有語氣詞，不寫也不送，留換回原文以防判斷錯。
//   raw：照原稿（跟沒有 AI 整理時一樣）；失敗、逾時另外提示一句。
export function applyPolish(base, raw, outcome, action) {
  if (outcome.kind === 'raw') {
    return { input: mergeTranscript(base, raw), send: action === 'send', revert: null, review: false, notice: outcome.reason === 'unsupported' ? '' : 'voicePolishFailed' };
  }
  if (outcome.kind === 'empty') {
    return { input: base, send: false, revert: { base, raw, text: '', written: base }, review: true, notice: '' };
  }
  const written = joinPolished(base, outcome.text);
  if (action === 'send') return { input: written, send: true, revert: null, review: false, notice: '' };
  const revert = outcome.text !== raw ? { base, raw, text: outcome.text, written } : null;
  return { input: written, send: false, revert, review: !!revert && changedWords(raw, outcome.text), notice: '' };
}
