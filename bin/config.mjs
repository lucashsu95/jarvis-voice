// 設定：~/.voice-dictation/config.json（VOICE_DICTATION_CONFIG 可指定別的檔），沒寫的照預設。
//
// {
//   "engine": "local",                 // local（本機 SenseVoice，免費）| openai（自己的 OpenAI key）| parallelsandbox
//   "apps": ["*"],                     // 這些 app 在最前面時才收音（bundle id）；"*" 是全部
//   "excludeApps": ["us.zoom.xos"],    // 這些 app 在最前面時不收音（開會、通話用的 app）
//   "output": "traditional",           // traditional（台灣正體）| simplified | original
//   "replacements": { "部屬": "部署" }, // 轉出來的字固定替換，給常錯的專有名詞用
//   "local": { "model": "<模型資料夾>", "language": "auto", "threads": 2 },
//   "openai": { "apiKey": "", "apiKeyFile": "", "model": "gpt-transcribe", "languages": [], "prompt": "",
//               "keywords": [], "vocabularyFile": "<狀態資料夾>/vocabulary.txt" },
//                                      // model 是 gpt-transcribe（一般，講完一句整句轉，預設）或 gpt-live-transcribe（即時）
//                                      // apiKeyFile：key 放在別的檔案時填路徑（純 key，或含 OPENAI_API_KEY= 的 .env）
//                                      // prompt：一兩句話講這是什麼場合；keywords／vocabularyFile：會講到的專有名詞，一行一個
//                                      // languages：預期的語言（例如 ["zh", "en"]）；舊的 language 單一字串也接受
//   "parallelsandbox": { "apiKey": "", "apiUrl": "https://api.parallelsandbox.com" }
// }

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STATE_DIR = process.env.VOICE_DICTATION_STATE_DIR || join(homedir(), '.voice-dictation');
export const CONFIG_PATH = process.env.VOICE_DICTATION_CONFIG || join(STATE_DIR, 'config.json');
export const DEFAULT_MODEL = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
export const ENGINES = ['local', 'openai', 'parallelsandbox'];

export function defaults() {
  return {
    engine: 'local',
    apps: ['*'],
    // 開會、通話時講的話不該被貼出去；選單列小程式自己也排除
    excludeApps: [
      'us.zoom.xos', 'com.microsoft.teams', 'com.microsoft.teams2', 'com.apple.FaceTime',
      'Cisco-Systems.Spark', 'com.cisco.webexmeetingsapp', 'com.urusa.voice-dictation',
    ],
    output: 'traditional',
    replacements: {},
    local: { model: join(STATE_DIR, 'models', DEFAULT_MODEL), language: 'auto', threads: 2 },
    openai: {
      apiKey: '', apiKeyFile: '', model: 'gpt-transcribe', languages: [], language: '', prompt: '',
      keywords: [], vocabularyFile: join(STATE_DIR, 'vocabulary.txt'),
    },
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

// key 放在別的檔案：整個檔案就是 key，或是 .env 裡的 OPENAI_API_KEY=
function keyFromFile(file) {
  if (!file) return '';
  try {
    const text = readFileSync(file.replace(/^~(?=\/)/, homedir()), 'utf8');
    const line = text.match(/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*["']?([^"'\s]+)/m);
    return line ? line[1] : text.trim();
  } catch {
    return '';
  }
}

// 詞彙檔：一行一個詞，# 開頭是註解；OpenAI 不收含 < 或 > 的詞
export function readVocabulary(file) {
  if (!file) return [];
  try {
    return readFileSync(file.replace(/^~(?=\/)/, homedir()), 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function cleanKeywords(words) {
  const seen = new Set();
  return words
    .map((w) => String(w).replace(/[<>\r\n]/g, '').trim())
    .filter((w) => w && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()));
}

// 這個 app 在最前面時要不要收音
export function appAllowed(config, bundle) {
  if (!bundle || config.excludeApps.includes(bundle)) return false;
  return config.apps.includes('*') || config.apps.includes(bundle);
}

// 即時模型走 Realtime 連線，其他走一般轉寫（整句上傳）
export const isLiveModel = (model) => /live|realtime/i.test(model ?? '');

const mtime = (file) => {
  try { return statSync(file.replace(/^~(?=\/)/, homedir())).mtimeMs; } catch { return 0; }
};

// 設定檔或詞彙檔有改就換新設定
export function configMtime(config) {
  return `${mtime(CONFIG_PATH)}:${config?.openai?.vocabularyFile ? mtime(config.openai.vocabularyFile) : 0}`;
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
  if (!Array.isArray(config.excludeApps)) config.excludeApps = base.excludeApps;
  config.openai.apiKey = config.openai.apiKey || keyFromFile(config.openai.apiKeyFile) || process.env.OPENAI_API_KEY || '';
  if (config.openai.apiKeyFile && !config.openai.apiKey) error = `讀不到 openai.apiKeyFile：${config.openai.apiKeyFile}`;
  config.openai.keywords = cleanKeywords([...(config.openai.keywords ?? []), ...readVocabulary(config.openai.vocabularyFile)]);
  const langs = Array.isArray(config.openai.languages) ? config.openai.languages : [];
  config.openai.languages = langs.length ? langs : config.openai.language ? [config.openai.language] : [];
  const ps = parallelSandboxFromClaudeJson();
  config.parallelsandbox.apiKey = config.parallelsandbox.apiKey || process.env.PARALLELSANDBOX_API_KEY || ps.apiKey || '';
  config.parallelsandbox.apiUrl = (process.env.PARALLELSANDBOX_API_URL || ps.apiUrl || config.parallelsandbox.apiUrl).replace(/\/+$/, '');
  return { config, error };
}
