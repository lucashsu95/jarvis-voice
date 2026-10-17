// 轉出來的字貼上前的整理：繁簡轉換、固定替換、句尾空白。

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let toTaiwan = null;
let toSimplified = null;

// 只有標點、空白的逐字稿（雜音常轉出這種）不貼。
export function isSpeech(text) {
  return /[\p{L}\p{N}]/u.test(text);
}

function convert(text, output) {
  if (output === 'traditional') {
    toTaiwan ??= require('opencc-js').Converter({ from: 'cn', to: 'twp' });
    return toTaiwan(text);
  }
  if (output === 'simplified') {
    toSimplified ??= require('opencc-js').Converter({ from: 'twp', to: 'cn' });
    return toSimplified(text);
  }
  return text;
}

// 英文句尾補一個空白，下一句才不會黏在一起；中文不用。
export const withSpacing = (text) => (/[A-Za-z0-9.,!?;:)]$/.test(text) ? `${text} ` : text);

// { output, replacements, alreadyTraditional }：平行沙盒的繁中帳號伺服器已經轉好，不再轉一次。
export function finishText(text, { output = 'traditional', replacements = {}, alreadyTraditional = false } = {}) {
  let result = text.trim();
  if (!(alreadyTraditional && output === 'traditional')) result = convert(result, output);
  for (const [from, to] of Object.entries(replacements)) {
    if (from) result = result.split(from).join(to);
  }
  return result;
}
