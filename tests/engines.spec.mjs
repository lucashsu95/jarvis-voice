// 常駐程式的零件測試：node --test tests/*.spec.mjs
// OpenAI 直連用本機假伺服器；本機辨識用模型附的 test_wavs/zh.wav（沒裝模型就跳過）。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

const stateDir = mkdtempSync(join(tmpdir(), 'voice-dictation-test-'));
process.env.VOICE_DICTATION_STATE_DIR = stateDir;

const { finishText, isSpeech, withSpacing } = await import('../bin/text.mjs');
const { loadConfig, DEFAULT_MODEL } = await import('../bin/config.mjs');
const { createRealtimeEngine, openaiConnector } = await import('../bin/engines/realtime.mjs');
const { createLocalEngine } = await import('../bin/engines/local.mjs');
const { findFfmpeg } = await import('../bin/common.mjs');

test('簡體轉台灣正體、固定替換、平行沙盒已轉好的不再轉', () => {
  assert.equal(finishText('帮我看一下部署表，顺便把测试跑完。'), '幫我看一下部署表，順便把測試跑完。');
  assert.equal(finishText('打开软件', { output: 'traditional' }), '開啟軟體');
  assert.equal(finishText('幫我把測籃改掉', { replacements: { 測籃: '側欄' } }), '幫我把側欄改掉');
  assert.equal(finishText('部屬到 dev', { alreadyTraditional: true, replacements: { 部屬: '部署' } }), '部署到 dev');
  assert.equal(finishText('幫我看一下', { output: 'simplified' }), '帮我看一下');
  assert.equal(finishText('  原樣  ', { output: 'original' }), '原樣');
});

test('雜音轉出的純標點不貼；英文句尾補空白', () => {
  assert.equal(isSpeech('。，'), false);
  assert.equal(isSpeech('好'), true);
  assert.equal(withSpacing('run the build.'), 'run the build. ');
  assert.equal(withSpacing('跑完了。'), '跑完了。');
});

test('設定檔：沒寫的照預設，engine 寫錯退回本機並說明', () => {
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ engine: 'whisper', openai: { model: 'x' } }));
  const { config, error } = loadConfig();
  assert.equal(config.engine, 'local');
  assert.match(error, /engine 只能是/);
  assert.equal(config.openai.model, 'x');
  assert.equal(config.output, 'traditional');
  assert.ok(config.local.model.endsWith(DEFAULT_MODEL));
  writeFileSync(join(stateDir, 'config.json'), '{ 壞掉');
  assert.match(loadConfig().error, /設定檔讀不懂/);
});

test('OpenAI 直連：帶自己的 key、先送 session 設定，再送音訊與 commit，收到定稿', async () => {
  const wss = new WebSocketServer({ port: 0 });
  const seen = { auth: '', first: null, appends: 0 };
  wss.on('connection', (socket, req) => {
    seen.auth = req.headers.authorization;
    socket.on('message', (raw) => {
      const event = JSON.parse(String(raw));
      if (!seen.first) seen.first = event;
      if (event.type === 'input_audio_buffer.append') seen.appends += 1;
      if (event.type === 'input_audio_buffer.commit') {
        socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'item_1' }));
        socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', delta: '你好' }));
        socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', transcript: '你好，世界' }));
      }
    });
  });
  await new Promise((r) => wss.on('listening', r));
  process.env.VOICE_DICTATION_OPENAI_URL = `ws://127.0.0.1:${wss.address().port}`;
  try {
    const finals = [];
    const errors = [];
    const engine = createRealtimeEngine({
      connector: openaiConnector({ apiKey: 'sk-test', model: 'gpt-live-transcribe', language: 'zh' }),
      onFinal: (text) => finals.push(text),
      onError: (message) => errors.push(message),
      log: () => {},
    });
    engine.append(Buffer.alloc(4800));
    engine.commit();
    for (let i = 0; i < 50 && !finals.length; i += 1) {
      engine.flush();
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(finals, ['你好，世界']);
    assert.equal(seen.auth, 'Bearer sk-test');
    assert.equal(seen.first.type, 'session.update');
    assert.equal(seen.first.session.audio.input.transcription.model, 'gpt-live-transcribe');
    assert.deepEqual(seen.first.session.audio.input.transcription.languages, ['zh']);
    assert.equal(seen.first.session.audio.input.format.rate, 24000);
    assert.equal(seen.appends, 1);
    for (let i = 0; i < 10 && engine.busy(); i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(engine.busy(), false);
    engine.close();
  } finally {
    delete process.env.VOICE_DICTATION_OPENAI_URL;
    wss.close();
  }
});

test('OpenAI 直連：沒有 key 時直接說要設定', async () => {
  const errors = [];
  const engine = createRealtimeEngine({
    connector: openaiConnector({ apiKey: '', model: 'gpt-live-transcribe' }),
    onFinal: () => {},
    onError: (message) => errors.push(message),
    log: () => {},
  });
  engine.append(Buffer.alloc(4800));
  engine.commit();
  for (let i = 0; i < 20 && !errors.length; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.match(errors[0], /沒有 OpenAI API key/);
  engine.close();
});

const model = join(process.env.HOME, '.claude', 'voice-dictation', 'models', DEFAULT_MODEL);
test('本機辨識：模型附的中文範例聽得出來', { skip: !existsSync(join(model, 'tokens.txt')) && '沒裝本機模型' }, async () => {
  const raw = execFileSync(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-i', join(model, 'test_wavs', 'zh.wav'),
    '-ac', '1', '-ar', '24000', '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 26 });
  const finals = [];
  const engine = createLocalEngine({ model, onFinal: (t) => finals.push(t), onError: (m) => assert.fail(m), log: () => {} });
  engine.append(raw);
  engine.commit();
  for (let i = 0; i < 100 && !finals.length; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(finals.length, 1);
  assert.match(finals[0], /[一-鿿]{4,}/);
  engine.close();
});

test('本機辨識：找不到模型時說要重跑 install.sh', () => {
  const errors = [];
  createLocalEngine({ model: join(stateDir, 'nope'), onFinal: () => {}, onError: (m) => errors.push(m), log: () => {} });
  assert.match(errors[0], /找不到本機模型/);
});
