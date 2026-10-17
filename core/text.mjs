// JarvisVoice 核心：轉寫結果的小工具。

// 只有標點、空白的逐字稿（雜音常轉出這種）不貼。
export function isSpeech(text) {
  return /[\p{L}\p{N}]/u.test(text);
}

// 英文句尾補一個空白，下一句才不會黏在一起；中文不用。
export const withSpacing = (text) => (/[A-Za-z0-9.,!?;:)]$/.test(text) ? `${text} ` : text);
