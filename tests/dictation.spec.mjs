// 核心的輸入框聽寫寫回規則（core/dictation.mjs）：CubeLV、平行沙盒的輸入框共用。模型用假的。

import assert from 'node:assert/strict';
import { test } from 'node:test';

const core = await import('../core/index.mjs');

const answer = (body) => async () => JSON.stringify({ goal: '', app: '', message: '', ...body });

test('AI 整理：上下文和原稿交給共用規則，回整理好的字', async () => {
  let seen = null;
  const outcome = await core.polishTranscript({
    transcript: '嗯那個這個按鈕太小了',
    context: { app: '平行沙盒', window: '驗收 CubeLV', screen: '箱子目標：上架', field: { editable: true, before: '請看' } },
    complete: async (request) => { seen = request; return JSON.stringify({ mode: 'insert', text: ' 這個按鈕太小了。', goal: '', app: '', message: '' }); },
  });
  assert.deepEqual(outcome, { kind: 'polished', text: '這個按鈕太小了。' });
  assert.match(seen.user, /<app>平行沙盒/);
  assert.match(seen.user, /<before>請看<\/before>/);
  assert.match(seen.user, /<screen>箱子目標：上架<\/screen>/);
  assert.ok(seen.signal instanceof AbortSignal);
});

test('AI 整理：模型失敗、格式不對、回指令或 delete_last 都照原稿；只有標點不問模型', async () => {
  assert.deepEqual(await core.polishTranscript({ transcript: '好', complete: async () => { throw new Error('500'); } }), { kind: 'raw', reason: 'failed' });
  assert.deepEqual(await core.polishTranscript({ transcript: '好', complete: async () => 'not json' }), { kind: 'raw', reason: 'failed' });
  assert.deepEqual(await core.polishTranscript({ transcript: '刪掉剛剛那句', complete: answer({ mode: 'delete_last', text: '' }) }), { kind: 'raw', reason: 'unsupported' });
  assert.deepEqual(await core.polishTranscript({ transcript: '打開設定', complete: answer({ mode: 'command', text: '', goal: '打開設定' }) }), { kind: 'raw', reason: 'failed' });
  let asked = false;
  assert.deepEqual(await core.polishTranscript({ transcript: '。。', complete: async () => { asked = true; return ''; } }), { kind: 'raw', reason: 'unsupported' });
  assert.equal(asked, false);
});

test('AI 整理：逾時就放棄、abort 請求，照原稿', async () => {
  let signal = null;
  const outcome = await core.polishTranscript({
    transcript: '這個按鈕太小了',
    timeoutMs: 20,
    complete: ({ signal: s }) => { signal = s; return new Promise(() => {}); },
  });
  assert.deepEqual(outcome, { kind: 'raw', reason: 'timeout' });
  assert.equal(signal.aborted, true);
});

test('AI 整理：整段只有語氣詞才回 empty；把真的話整理成空的照原稿', async () => {
  assert.deepEqual(await core.polishTranscript({ transcript: '嗯，呃', complete: answer({ mode: 'insert', text: '' }) }), { kind: 'empty' });
  assert.deepEqual(await core.polishTranscript({ transcript: '哈囉', complete: answer({ mode: 'insert', text: '' }) }), { kind: 'polished', text: '哈囉' });
  assert.deepEqual(await core.polishTranscript({ transcript: '改正式', complete: answer({ mode: 'replace_selection', text: '請改得正式一點。' }) }), { kind: 'polished', text: '請改得正式一點。' });
});

test('寫回：整理後的字接在原本的字後面，插入時留換回原文，改到字才要人再看一次；送出就直接送', () => {
  const w = core.applyPolish('先打的字', '嗯這個按鈕太小', { kind: 'polished', text: '這個按鈕太小。' }, 'insert');
  assert.deepEqual(w, { input: '先打的字這個按鈕太小。', send: false, revert: { base: '先打的字', raw: '嗯這個按鈕太小', text: '這個按鈕太小。', written: '先打的字這個按鈕太小。' }, review: true, notice: '' });
  assert.equal(core.applyPolish('', 'hello world', { kind: 'polished', text: 'Hello, world.' }, 'insert').review, false);
  assert.deepEqual(core.applyPolish('', '好', { kind: 'polished', text: '好。' }, 'send'), { input: '好。', send: true, revert: null, review: false, notice: '' });
});

test('寫回：只有語氣詞不寫也不送、可以換回；整理失敗照原稿並提示', () => {
  assert.deepEqual(core.applyPolish('先打的字', '嗯', { kind: 'empty' }, 'send'), { input: '先打的字', send: false, revert: { base: '先打的字', raw: '嗯', text: '', written: '先打的字' }, review: true, notice: '' });
  assert.deepEqual(core.applyPolish('先打的字', '原稿', { kind: 'raw', reason: 'timeout' }, 'send'), { input: '先打的字 原稿', send: true, revert: null, review: false, notice: 'voicePolishFailed' });
  assert.equal(core.applyPolish('', '原稿', { kind: 'raw', reason: 'unsupported' }, 'insert').notice, '');
});

test('換回原文：還沒動過整段換回；後來又打了字只換整理過的那段；找不到就放棄；AI 沒寫的補回去', () => {
  const revert = { base: '請看', raw: '嗯這個按鈕', text: '這個按鈕。', written: '請看這個按鈕。' };
  assert.equal(core.revertPolish('請看這個按鈕。', revert), '請看 嗯這個按鈕');
  assert.equal(core.revertPolish('請看 這個按鈕。', revert, '請看 這個按鈕。'), '請看 嗯這個按鈕');
  assert.equal(core.revertPolish('請看這個按鈕。還有標題', revert), '請看嗯這個按鈕還有標題');
  assert.equal(core.revertPolish('全部改掉了', revert), null);
  assert.equal(core.revertPolish('先打的字', { base: '先打的字', raw: '其實有講話', text: '', written: '先打的字' }), '先打的字 其實有講話');
});

test('接字：中文接中文直接接，英文、數字與中文交界空一格，已經有空白不重複', () => {
  assert.equal(core.joinPolished('', ' 你好。'), '你好。');
  assert.equal(core.joinPolished('今天', '天氣很好。'), '今天天氣很好。');
  assert.equal(core.joinPolished('Hello', 'world.'), 'Hello world.');
  assert.equal(core.joinPolished('用 React', '寫'), '用 React 寫');
  assert.equal(core.joinPolished('請看', 'Button'), '請看 Button');
  assert.equal(core.joinPolished('好。', 'OK'), '好。OK');
  assert.equal(core.joinPolished('Hi ', 'there'), 'Hi there');
  assert.equal(core.joinPolished('第一行\n', '第二行'), '第一行\n第二行');
  assert.equal(core.joinPolished('另外', ' 這個'), '另外 這個');
  assert.equal(core.mergeTranscript('先打的字', '原稿'), '先打的字 原稿');
  assert.equal(core.mergeTranscript('', '原稿'), '原稿');
  assert.equal(core.changedWords('hello world', 'Hello, world.'), false);
  assert.equal(core.changedWords('鵝滿', '額滿'), true);
});
