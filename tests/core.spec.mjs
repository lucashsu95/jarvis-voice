// 核心（core/）的測試：不能用 Node 專用的東西（要在 CubeLV、平行沙盒的瀏覽器裡跑）；接頭傳假的進去也要能動。

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as core from '../core/index.mjs';

const coreDir = join(import.meta.dirname, '..', 'core');

test('核心不用 Node 專用的東西：沒有 node: 模組、process、require、檔案', () => {
  for (const name of readdirSync(coreDir).filter((f) => f.endsWith('.mjs'))) {
    const src = readFileSync(join(coreDir, name), 'utf8');
    assert.doesNotMatch(src, /from ['"]node:|import\(['"]node:|\bprocess\.|\brequire\(|readFileSync|writeFileSync/, `${name} 用了 Node 專用的東西`);
    for (const [, spec] of src.matchAll(/from ['"]([^'"]+)['"]/g)) assert.match(spec, /^\.\//, `${name} 只能匯入核心裡的檔案：${spec}`);
  }
});

test('核心的 AI 整理：模型由外面傳 complete 進來', async () => {
  const seen = [];
  const complete = async (req) => { seen.push(req); return '{"mode":"insert","text":"我們明天四點開會。","goal":"","app":"","message":""}'; };
  const r = await core.editSegment({ complete, transcript: '嗯明天三點不對四點開會', context: { app: 'Slack', screen: '…' } });
  assert.equal(r.text, '我們明天四點開會。');
  assert.equal(seen[0].schema, core.SCHEMA);
  assert.match(seen[0].user, /<screen>…<\/screen>/);
  await assert.rejects(core.editSegment({ complete: async () => 'not json', transcript: 'x' }), /格式不對/);
});

test('核心的決策器：有 Jev 用 Jev；Jev 拿不準時改問 AI；都沒有就說做不了', async () => {
  const jev = async () => ({ intent: { choice: 'command', confidence: 0.9 } });
  const complete = async () => '{"answers":{"intent":{"choice":"dictation","confidence":0.8},"bad":{"choice":"zzz"}}}';
  const both = core.createDecider(() => ({ jev, complete }));
  assert.equal(both.engine(), 'Jev');
  assert.equal((await both.decide({}, { intent: core.intentQuestion() })).intent.choice, 'command');
  assert.equal(both.canEscalate(), true);
  assert.equal((await both.escalate({}, { intent: core.intentQuestion() })).intent.choice, 'dictation');
  const onlyAi = core.createDecider(() => ({ complete }));
  assert.equal(onlyAi.engine(), 'AI');
  assert.equal(onlyAi.canEscalate(), false);
  await assert.rejects(core.createDecider(() => ({})).decide({}, { intent: core.intentQuestion() }), /做不了決策/);
});

test('核心的指令：畫面接頭傳假的進去，一步步做到完成', async () => {
  let step = 0;
  const screens = [
    [{ handle: 1, role: 'AXButton', label: '設定', x: 0, y: 0, w: 50, h: 20 }],
    [{ handle: 2, role: 'AXButton', label: '通知', x: 0, y: 0, w: 50, h: 20 }],
  ];
  const acts = [];
  const screen = {
    elements: async () => ({ window: { title: `w${step}` }, elements: screens[Math.min(step, 1)] }),
    act: async (req) => { acts.push(req); step += 1; return { result: 'ok' }; },
  };
  const plan = ['click', 'done'];
  const decider = { engine: () => '假', canEscalate: () => false, decide: async (state) => ({ action: { choice: plan[state.done_steps.length], confidence: 0.9 }, target: { choice: 'e0', confidence: 0.9 } }) };
  const r = await core.runCommand({ screen, decider, goal: '打開設定' });
  assert.equal(r.ok, true);
  assert.deepEqual(acts, [{ handle: 1, action: 'press' }]);
});

test('核心的詞彙自動更新：存放接頭傳記憶體版也能用', () => {
  let vocab = 'CubeLV\n';
  let state = null;
  const store = { loadState: () => state, saveState: (s) => { state = JSON.parse(JSON.stringify(s)); }, readVocab: () => vocab, writeVocab: (t) => { vocab = t; } };
  const v = core.createVocabAuto({ store, settings: () => ({ complete: null }) });
  assert.equal(v.promote('JarvisVoice', 'edit'), true);
  assert.match(vocab, new RegExp(`${core.AUTO_HEADER.replace(/[()（）]/g, '.')}\\nJarvisVoice\\n$`));
  assert.ok(state.terms.JarvisVoice);
});

test('同步腳本：複製核心並在每個檔案寫上來源 commit', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync: read, readdirSync: list } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dest = mkdtempSync(join(tmpdir(), 'jarvis-core-'));
  try {
    execFileSync(join(import.meta.dirname, '..', 'scripts', 'sync-core.sh'), [dest], { stdio: 'pipe' });
  } catch (err) {
    // core/ 還有沒 commit 的改動時腳本會拒絕：開發中略過
    if (String(err.stderr).includes('還沒 commit')) return;
    throw err;
  }
  const sha = read(join(dest, 'CORE_COMMIT'), 'utf8').trim();
  assert.ok(list(dest).includes('index.mjs'));
  assert.match(read(join(dest, 'editor.mjs'), 'utf8'), new RegExp(`^// 從 jarvis-voice core@${sha} 同步`));
  const synced = await import(join(dest, 'index.mjs'));
  assert.equal(typeof synced.editSegment, 'function');
});
