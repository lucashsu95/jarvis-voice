// openai-compatible（vLLM）provider＋ai-log 資料鏈的契約測試：
// 請求體形狀（json_object、max_tokens 預設、extraBody 併進）、設定驗證與降級、
// ai-log.jsonl 的欄位與開關、correction 記錄自包含（不用靠時間對 ai-call）。
// 用本機假 vLLM，不打真實 endpoint。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const STATE = join(tmpdir(), `jv-compat-test-${process.pid}`);
const CFG = join(STATE, 'config.json');
rmSync(STATE, { recursive: true, force: true });
mkdirSync(STATE, { recursive: true });
process.env.VOICE_DICTATION_STATE_DIR = STATE;
process.env.VOICE_DICTATION_CONFIG = CFG;
delete process.env.VOICE_DICTATION_AI_LOG;

let body = null;
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => b += c);
  req.on('end', () => {
    body = { url: req.url, auth: req.headers.authorization, json: JSON.parse(b) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '{"mode":"insert","text":"ok","goal":"","app":"","message":""}' } }], usage: { total_tokens: 7 } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;

const { ownKeyService } = await import('../core/providers.mjs');
const { loadConfig } = await import('../bin/config.mjs');
const { editSegment, ask } = await import('../bin/editor.mjs');
const { createDecider, intentQuestion } = await import('../bin/decide.mjs');
const { createLearner } = await import('../core/learn.mjs');
const { aiLog } = await import('../bin/ai-log.mjs');

const aiLogPath = () => join(STATE, 'ai-log.jsonl');
const logLines = () => readFileSync(aiLogPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const resetLog = () => { try { rmSync(aiLogPath()); } catch { } };

test('compat：缺 baseUrl 要在 ownKeyService 就丟錯', () => {
  assert.throws(() => ownKeyService({ provider: 'openai-compatible', model: 'BIRC-LLM', apiKey: 'k' }), /baseUrls/);
});

test('compat：請求體 json_object＋max_tokens 預設＋extraBody 併進＋Authorization', async () => {
  resetLog();
  await editSegment({ provider: 'openai-compatible', model: 'BIRC-LLM', apiKey: 'k', baseUrl: URL,
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
    transcript: '測試', context: { app: 'Slack' } });
  assert.equal(body.auth, 'Bearer k');
  const j = body.json;
  assert.equal(j.model, 'BIRC-LLM');
  assert.deepEqual(j.response_format, { type: 'json_object' });
  assert.equal(j.max_tokens, 2048);
  assert.deepEqual(j.chat_template_kwargs, { enable_thinking: false });
  assert.ok(!('thinking' in j) && !('reasoning_effort' in j));
  const rec = logLines().find((l) => l.type === 'ai-call');
  assert.equal(rec.kind, 'edit');
  assert.equal(rec.model, 'BIRC-LLM');
  assert.equal(rec.error, null);
  assert.deepEqual(rec.usage, { total_tokens: 7 });
});

test('compat：extraBody 可以蓋掉 response_format（某些 vLLM 建法不支援 json_object）', async () => {
  await editSegment({ provider: 'openai-compatible', model: 'BIRC-LLM', apiKey: 'k', baseUrl: URL,
    extraBody: { response_format: { type: 'text' } },
    transcript: '測試' });
  assert.deepEqual(body.json.response_format, { type: 'text' });
});

test('loadConfig：compat 缺 baseUrl／model 要報錯並降級回預設 provider（不能每段都失敗）', () => {
  writeFileSync(CFG, JSON.stringify({ ai: { provider: 'openai-compatible', baseUrls: { 'openai-compatible': URL }, keys: { 'openai-compatible': 'k' } } }));
  let { config, error } = loadConfig();
  assert.match(error, /ai\.models/);
  assert.notEqual(config.ai.provider, 'openai-compatible');
  writeFileSync(CFG, JSON.stringify({ ai: { provider: 'openai-compatible', keys: { 'openai-compatible': 'k' } } }));
  ({ config, error } = loadConfig());
  assert.match(error, /baseUrls/);
  assert.notEqual(config.ai.provider, 'openai-compatible');
});

test('decider：compat 缺 baseUrl 時 available() 回 false，不丟錯（不能把整段話丟掉）', () => {
  const d = createDecider(() => ({ jevKey: '', jevModel: '',
    ai: { provider: 'openai-compatible', model: 'M', apiKey: 'k', baseUrl: undefined } }));
  assert.equal(d.available(), false);
  const d2 = createDecider(() => ({ jevKey: '', jevModel: '',
    ai: { provider: 'openai-compatible', model: 'M', apiKey: 'k', baseUrl: URL } }));
  assert.equal(d2.available(), true);
});

test('ai-log：off 開關、0600 權限、2 MB 輪轉', () => {
  resetLog();
  process.env.VOICE_DICTATION_AI_LOG = 'off';
  aiLog({ type: 't' });
  assert.ok(!require_fs_exists(aiLogPath()));
  delete process.env.VOICE_DICTATION_AI_LOG;
  writeFileSync(aiLogPath(), 'x'.repeat(2_000_001));
  aiLog({ type: 't' });
  assert.ok(require_fs_exists(aiLogPath() + '.1'));
  assert.equal(logLines().length, 1);
  assert.equal((statSync(aiLogPath()).mode & 0o777).toString(8), '600');
});

test('correction：自成一筆（raw／app／cleaned），長文（>1000 字）也照記', async () => {
  resetLog();
  const realNow = Date.now;
  let fake = realNow();
  Date.now = () => fake;
  const long = '甲'.repeat(1001);
  try {
    let stage = 1;
    const learner = createLearner({
      read: async () => (stage === 1 ? '丙'.repeat(1001) + '尾錨' : '訊息已送出'), // 第二次：欄位清空＝觀測結束
      log: () => {},
      settings: () => ({ enabled: false, complete: null }),
      promote: () => false,
      onCorrection: (c) => aiLog({ type: 'correction', ...c }),
    });
    learner.watch({ handle: 1, inserted: long, before: '', after: '尾錨', raw: '原稿字', app: 'Slack', window: '視窗', cleaned: true });
    fake += 3100;
    await learner.tick();
    fake += 3100;
    await learner.tick();
    stage = 2;
    fake += 3100;
    await learner.tick();
  } finally {
    Date.now = realNow;
  }
  const c = logLines().find((l) => l.type === 'correction');
  assert.ok(c, '長文改字也要記');
  assert.equal(c.raw, '原稿字');
  assert.equal(c.app, 'Slack');
  assert.equal(c.window, '視窗');
  assert.equal(c.cleaned, true);
  assert.equal(c.ai, long);
  assert.equal(c.final, '丙'.repeat(1001));
  assert.deepEqual(c.chunks, []); // 1000 字以上不比對，chunks 空但記錄在
});

test('inlineSystem：開時規則併進 user 訊息、system 留空（gateway 注入 system prompt 用）', async () => {
  resetLog();
  writeFileSync(CFG, JSON.stringify({ ai: { inlineSystem: true } }));
  try {
    await ask({ provider: 'openai-compatible', model: 'M', apiKey: 'k', baseUrl: URL, system: '規則R', user: '使用者內容' });
    const msgs = body.json.messages;
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[0].content, '');
    assert.equal(msgs[1].content, '規則R\n\n使用者內容');
    const rec = logLines().at(-1);
    assert.equal(rec.system, '');
    assert.equal(rec.user, '規則R\n\n使用者內容');
  } finally {
    writeFileSync(CFG, JSON.stringify({}));
  }
});

test('ai-call：kind 要分辨 edit／terms／other', async () => {
  resetLog();
  await ask({ provider: 'openai-compatible', model: 'M', apiKey: 'k', baseUrl: URL, system: 's', user: 'u',
    schema: { properties: { terms: { type: 'array' } } } });
  await ask({ provider: 'openai-compatible', model: 'M', apiKey: 'k', baseUrl: URL, system: 's', user: 'u' });
  const kinds = logLines().map((l) => l.kind);
  assert.deepEqual(kinds, ['terms', 'other']);
});

function require_fs_exists(p) {
  try { readFileSync(p); return true; } catch { return false; }
}

test.after(() => {
  server.close();
  rmSync(STATE, { recursive: true, force: true });
});
