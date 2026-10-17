// 轉出來的字貼上前的整理：繁簡轉換、固定替換、句尾空白。

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let toTaiwan = null;
let toSimplified = null;

export { isSpeech, withSpacing } from '../core/text.mjs';

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

// { output, replacements, alreadyTraditional }：平行沙盒的繁中帳號伺服器已經轉好，不再轉一次。
export function finishText(text, { output = 'traditional', replacements = {}, alreadyTraditional = false } = {}) {
  let result = text.trim();
  if (!(alreadyTraditional && output === 'traditional')) result = convert(result, output);
  for (const [from, to] of Object.entries(replacements)) {
    if (from) result = result.split(from).join(to);
  }
  return result;
}
