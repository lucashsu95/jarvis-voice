// 設定：~/.claude/voice-dictation/config.json（VOICE_DICTATION_CONFIG 可指定別的檔），沒寫的照預設。
//
// {
//   "engine": "local",                 // local（本機 SenseVoice，免費）| openai（自己的 OpenAI key）| parallelsandbox
//   "apps": ["com.anthropic.claudefordesktop"],   // 這些 app 在最前面時才收音（bundle id）
//   "output": "traditional",           // traditional（台灣正體）| simplified | original
//   "replacements": { "部屬": "部署" }, // 轉出來的字固定替換，給常錯的專有名詞用
//   "local": { "model": "<模型資料夾>", "language": "auto", "threads": 2 },
//   "openai": { "apiKey": "", "model": "gpt-live-transcribe", "language": "" },
//   "parallelsandbox": { "apiKey": "", "apiUrl": "https://api.parallelsandbox.com" }
// }

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STATE_DIR = process.env.VOICE_DICTATION_STATE_DIR || join(homedir(), '.claude', 'voice-dictation');
export const CONFIG_PATH = process.env.VOICE_DICTATION_CONFIG || join(STATE_DIR, 'config.json');
export const DEFAULT_MODEL = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
export const ENGINES = ['local', 'openai', 'parallelsandbox'];

export function defaults() {
  return {
    engine: 'local',
    apps: ['com.anthropic.claudefordesktop'],
    output: 'traditional',
    replacements: {},
    local: { model: join(STATE_DIR, 'models', DEFAULT_MODEL), language: 'auto', threads: 2 },
    openai: { apiKey: '', model: 'gpt-live-transcribe', language: '' },
    parallelsandbox: { apiKey: '', apiUrl: 'https://api.parallelsandbox.com' },
  };
}

// 平行沙盒的 key 沒寫在設定檔時，借用 ~/.claude.json 裡 parallelsandbox MCP 的設定。
function parallelSandboxFromClaudeJson() {
  const files = [];
  if (process.env.CLAUDE_CONFIG_DIR) files.push(join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'));
  files.push(join(homedir(), '.claude.json'));
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const config = JSON.parse(readFileSync(file, 'utf8'));
      const servers = [config.mcpServers, ...Object.values(config.projects ?? {}).map((p) => p?.mcpServers)];
      const env = servers.find((s) => s?.parallelsandbox?.env?.PARALLELSANDBOX_API_KEY)?.parallelsandbox.env;
      if (env) return { apiKey: env.PARALLELSANDBOX_API_KEY, apiUrl: env.PARALLELSANDBOX_API_URL };
    } catch { /* 壞檔就看下一個 */ }
  }
  return {};
}

export function configMtime() {
  try { return statSync(CONFIG_PATH).mtimeMs; } catch { return 0; }
}

// 回傳 { config, error }：設定檔壞掉時照預設跑，error 說哪裡壞。
export function loadConfig() {
  const base = defaults();
  let file = {};
  let error = '';
  if (existsSync(CONFIG_PATH)) {
    try { file = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch (err) { error = `設定檔讀不懂：${err.message}`; }
  }
  const config = {
    ...base,
    ...file,
    local: { ...base.local, ...file.local },
    openai: { ...base.openai, ...file.openai },
    parallelsandbox: { ...base.parallelsandbox, ...file.parallelsandbox },
    replacements: { ...base.replacements, ...file.replacements },
  };
  if (!ENGINES.includes(config.engine)) {
    error = `engine 只能是 ${ENGINES.join('、')}，設定檔寫的是「${config.engine}」`;
    config.engine = 'local';
  }
  if (!Array.isArray(config.apps) || !config.apps.length) config.apps = base.apps;
  config.openai.apiKey = config.openai.apiKey || process.env.OPENAI_API_KEY || '';
  const ps = parallelSandboxFromClaudeJson();
  config.parallelsandbox.apiKey = config.parallelsandbox.apiKey || process.env.PARALLELSANDBOX_API_KEY || ps.apiKey || '';
  config.parallelsandbox.apiUrl = (process.env.PARALLELSANDBOX_API_URL || ps.apiUrl || config.parallelsandbox.apiUrl).replace(/\/+$/, '');
  return { config, error };
}
