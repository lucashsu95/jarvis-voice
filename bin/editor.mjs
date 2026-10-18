// Mac 小程式的 AI 整理：規則和解析在核心（core/editor.mjs），這裡接「自己的 key」（core/providers.mjs）。
// 測試可以用環境變數把各家的網址換成本機假伺服器。

import { editSegment as coreEditSegment, parseResult, SCHEMA } from '../core/editor.mjs';
import { PROVIDERS, PROVIDER_NAMES, ownKeyService } from '../core/providers.mjs';
import { aiLog } from './ai-log.mjs';

export { MODES, SCHEMA, buildPrompt, parseResult } from '../core/editor.mjs';
export { PROVIDERS, DEFAULT_MODELS, PROVIDER_NAMES } from '../core/providers.mjs';

const envUrls = () => Object.fromEntries(Object.entries({
  openai: process.env.VOICE_DICTATION_OPENAI_CHAT_URL,
  deepseek: process.env.VOICE_DICTATION_DEEPSEEK_URL,
  claude: process.env.VOICE_DICTATION_ANTHROPIC_URL,
  jev: process.env.VOICE_DICTATION_JEV_URL,
}).filter(([, v]) => v));

// 自己的 key 的服務：{ model, complete, jev }；baseUrl／extraBody 是 openai-compatible（vLLM）用
export function service({ provider = 'openai', model, apiKey, timeoutMs, jevKey, jevModel, baseUrl, extraBody } = {}) {
  const urls = { ...envUrls(), ...(baseUrl ? { [provider]: baseUrl } : {}) };
  const svc = ownKeyService({ provider, model, apiKey, timeoutMs, jevKey, jevModel, urls, extraBody });
  if (!svc.complete) return svc;
  // 每次打 AI 都記一筆（bin/ai-log.mjs）：prompt、原樣回傳、耗時、token 用量。
  // kind 分三種：edit（整理）、terms（學詞）、other（決策等）；parsed 只有 edit 才有意義
  const kindOf = (req) => (req.schema === SCHEMA ? 'edit' : req.schema?.properties?.terms ? 'terms' : 'other');
  const complete = svc.complete;
  svc.complete = async (req) => {
    const started = Date.now();
    let meta = {};
    let raw = '';
    let error = null;
    try {
      raw = await complete({ ...req, onMeta: (m) => { meta = m; } });
      return raw;
    } catch (err) {
      error = err.message;
      throw err;
    } finally {
      const kind = kindOf(req);
      aiLog({ type: 'ai-call', kind, provider, model: svc.model, ms: Date.now() - started, system: req.system ?? '', user: req.user ?? '',
        raw, ...(kind === 'edit' ? { parsed: parseResult(raw, { commands: true }) } : {}),
        usage: meta.usage ?? null, status: meta.status ?? null, error });
    }
  };
  return svc;
}

function check(provider, apiKey, what) {
  if (!PROVIDERS.includes(provider)) throw new Error(`ai.provider 只能是 ${PROVIDERS.join('、')}`);
  if (!apiKey) throw new Error(`${what}沒有 ${PROVIDER_NAMES[provider]} API key`);
}

// 通用：照 system／user 問一次，回模型吐的字（要 JSON 的話自己 parse）
export async function ask({ provider = 'openai', model, apiKey, timeoutMs = 6000, system, user, schema = null, baseUrl, extraBody }) {
  check(provider, apiKey, 'AI ');
  return service({ provider, model, apiKey, timeoutMs, baseUrl, extraBody }).complete({ system, user, schema });
}

// 回傳 { mode, text, ms, model }；失敗丟錯，呼叫端改貼原稿
export async function editSegment({ provider = 'openai', model, apiKey, timeoutMs = 6000, baseUrl, extraBody, ...input }) {
  check(provider, apiKey, 'AI 編輯');
  const svc = service({ provider, model, apiKey, timeoutMs, baseUrl, extraBody });
  return { ...(await coreEditSegment({ complete: svc.complete, ...input })), model: svc.model };
}
