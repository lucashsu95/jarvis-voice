// JarvisVoice 核心：轉寫結果的小工具。

// 只有標點、空白的逐字稿（雜音常轉出這種）不貼。
export function isSpeech(text) {
  return /[\p{L}\p{N}]/u.test(text);
}

// 整段只有語氣詞（嗯、呃、啊、欸、um、uh 這類）和標點：AI 整理只有這種情況可以不寫。
const FILLER_ZH = /[嗯呃啊欸]/gu;
const FILLER_EN = /\b(?:u+m+|u+h+m*|e+r+m*|a+h+|h+m+|m+)\b/giu;
export function onlyFiller(text) {
  return !isSpeech(String(text ?? '').replace(FILLER_EN, '').replace(FILLER_ZH, ''));
}

// 英文句尾補一個空白，下一句才不會黏在一起；中文不用。
export const withSpacing = (text) => (/[A-Za-z0-9.,!?;:)]$/.test(text) ? `${text} ` : text);
