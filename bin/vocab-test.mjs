#!/usr/bin/env node
// 專有名詞測試：每句「不加詞彙」「加詞彙」各轉一次，比對原文，順便查有沒有跑出沒講的詞。
//   node bin/vocab-test.mjs                 用 macOS 合成語音念測試句（不用人在旁邊）
//   node bin/vocab-test.mjs --mic           你自己念：每句先印出來，念完停一下就換下一句（真人聲音最準）
//   node bin/vocab-test.mjs --sentences <檔> --voice <say 的聲音>
// 測試句預設讀 ~/.voice-dictation/test-sentences.txt（一行一句，# 是註解）。
// 用的引擎與詞彙照 config.json；local 引擎沒有詞彙提示，只比較 replacements 的效果。

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioTurnDetector, BATCH_BYTES, findFfmpeg } from './common.mjs';
import { STATE_DIR, isLiveModel, loadConfig } from './config.mjs';
import { createBatchEngine } from './engines/batch.mjs';
import { createLocalEngine } from './engines/local.mjs';
import { createRealtimeEngine, openaiConnector, parallelSandboxConnector } from './engines/realtime.mjs';
import { finishText } from './text.mjs';

const PLAIN = '今天中午我們去吃牛肉麵，吃完再去買咖啡。'; // 不含任何專有名詞，拿來查代造詞

export function normalize(text) {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

export function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

// 字錯誤率：去掉空白標點、不分大小寫後的編輯距離 ÷ 原文字數
export function charErrorRate(reference, hypothesis) {
  const ref = normalize(reference);
  return ref.length ? editDistance(ref, normalize(hypothesis)) / ref.length : 0;
}

// 轉出來有、原文沒有的詞彙＝代造詞
export function phantomTerms(reference, hypothesis, terms) {
  const ref = normalize(reference);
  const hyp = normalize(hypothesis);
  return terms.filter((t) => {
    const n = normalize(t);
    return n.length >= 2 && hyp.includes(n) && !ref.includes(n);
  });
}

export function readSentences(file) {
  return readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
}

function pickVoice(wanted) {
  const list = execFileSync('/usr/bin/say', ['-v', '?'], { encoding: 'utf8' });
  if (wanted) return wanted;
  const tw = list.split('\n').filter((l) => /zh_TW/.test(l)).map((l) => l.split(/\s{2,}/)[0].trim());
  return tw.find((v) => /meijia/i.test(v)) || tw[0] || '';
}

function pcmFromFile(file) {
  return execFileSync(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '24000', '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 28 });
}

function synthesize(text, voice, dir, index) {
  const file = join(dir, `s${index}.aiff`);
  execFileSync('/usr/bin/say', [...(voice ? ['-v', voice] : []), '-o', file, text]);
  return pcmFromFile(file);
}

function pinkNoise(dir) {
  const file = join(dir, 'noise.wav');
  execFileSync(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.06:duration=3', '-ar', '24000', '-ac', '1', file]);
  return pcmFromFile(file);
}

// 錄一句：等開口，講完停 0.85 秒就收（最多 20 秒）
function recordOne() {
  return new Promise((resolve, reject) => {
    const ff = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'avfoundation', '-i', ':default', '-ac', '1', '-ar', '24000', '-f', 's16le', 'pipe:1']);
    const detector = new AudioTurnDetector();
    const chunks = [];
    let carry = Buffer.alloc(0);
    let samples = 0;
    let started = false;
    const finish = () => { ff.kill('SIGKILL'); resolve(Buffer.concat(chunks)); };
    const limit = setTimeout(finish, 20_000);
    ff.on('error', reject);
    ff.stdout.on('data', (data) => {
      carry = Buffer.concat([carry, data]);
      while (carry.length >= BATCH_BYTES) {
        const chunk = Buffer.from(carry.subarray(0, BATCH_BYTES));
        carry = carry.subarray(BATCH_BYTES);
        const turn = detector.push(new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2), samples / 24);
        samples += BATCH_BYTES / 2;
        if (detector.speaking) started = true;
        if (started) chunks.push(chunk);
        if (turn) { clearTimeout(limit); finish(); return; }
      }
    });
  });
}

// 用設定的引擎轉一段音訊；withVocab=false 時拿掉詞彙、提示與替換
function transcribe(config, pcm, withVocab) {
  return new Promise((resolve) => {
    let done = false;
    const texts = [];
    const errors = [];
    const finishOnce = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      engine.close();
      const raw = texts.join('');
      resolve({
        text: finishText(raw, {
          output: config.output,
          replacements: withVocab ? config.replacements : {},
          alreadyTraditional: config.engine === 'parallelsandbox',
        }),
        error: errors[0] || '',
      });
    };
    const callbacks = {
      log: () => {},
      onFinal: (t) => { texts.push(t); setTimeout(() => { if (!engine.busy()) finishOnce(); }, 50); },
      onError: (m) => { errors.push(m); },
    };
    const openai = withVocab ? config.openai : { ...config.openai, keywords: [], prompt: '' };
    let engine;
    if (config.engine === 'local') engine = createLocalEngine({ ...config.local, ...callbacks });
    else if (config.engine === 'openai' && isLiveModel(openai.model)) engine = createRealtimeEngine({ connector: openaiConnector(openai), ...callbacks });
    else if (config.engine === 'openai') engine = createBatchEngine({ ...openai, ...callbacks });
    else engine = createRealtimeEngine({ connector: parallelSandboxConnector(config.parallelsandbox), ...callbacks });
    const timer = setTimeout(finishOnce, 30_000);
    engine.append(pcm);
    engine.commit();
    // 沒聲音被判成雜音、或引擎出錯時不會有 onFinal：輪詢到不忙就收
    const poll = setInterval(() => {
      engine.flush();
      if (done) { clearInterval(poll); return; }
      if (!engine.busy() && (texts.length || errors.length)) { clearInterval(poll); finishOnce(); }
    }, 200);
    setTimeout(() => { if (!engine.busy() && !texts.length) { clearInterval(poll); finishOnce(); } }, 3000);
  });
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ''; };
  const useMic = argv.includes('--mic');
  const file = opt('--sentences') || join(STATE_DIR, 'test-sentences.txt');
  if (!existsSync(file)) {
    console.error(`找不到測試句：${file}（一行一句，用你平常講話的口氣，每句帶一兩個專有名詞）`);
    process.exit(2);
  }
  const sentences = readSentences(file);
  const { config, error } = loadConfig();
  if (error) console.error(`設定檔：${error}`);
  const terms = config.openai.keywords;
  const voice = useMic ? '' : pickVoice(opt('--voice'));
  console.log(`引擎：${config.engine}${config.engine === 'openai' ? `（${config.openai.model}）` : ''}　詞彙：${terms.length} 個　替換：${Object.keys(config.replacements).length} 條　測試句：${sentences.length} 句　聲音：${useMic ? '你自己念' : voice || '系統預設'}`);
  if (config.engine === 'local' && terms.length) console.log('（local 引擎不吃詞彙，只比較 replacements）');

  const dir = mkdtempSync(join(tmpdir(), 'vocab-test-'));
  const rows = [];
  try {
    const cases = [...sentences.map((s) => ({ ref: s })), { ref: PLAIN, check: 'plain' }, ...(useMic ? [] : [{ ref: '', check: 'noise' }])];
    for (const [i, c] of cases.entries()) {
      let pcm;
      if (c.check === 'noise') pcm = pinkNoise(dir);
      else if (useMic) {
        console.log(`\n請念（${i + 1}/${cases.length}）：${c.ref}`);
        pcm = await recordOne();
      } else pcm = synthesize(c.ref, voice, dir, i);
      const without = await transcribe(config, pcm, false);
      const withVocab = await transcribe(config, pcm, true);
      const row = {
        ...c,
        without: without.text,
        with: withVocab.text,
        error: withVocab.error || without.error,
        cerWithout: charErrorRate(c.ref, without.text),
        cerWith: charErrorRate(c.ref, withVocab.text),
        phantom: phantomTerms(c.ref, withVocab.text, terms),
      };
      rows.push(row);
      const mark = (cer) => (cer === 0 ? '✓' : '✗');
      const label = c.check === 'noise' ? '雜音（應該沒有字）' : c.check === 'plain' ? `一般句：${c.ref}` : c.ref;
      console.log(`\n${i + 1}. ${label}`);
      if (c.check === 'noise') {
        console.log(`   不加詞彙：${without.text || '（沒有字）'}`);
        console.log(`   加詞彙　：${withVocab.text || '（沒有字）'}`);
      } else {
        console.log(`   不加詞彙 ${mark(row.cerWithout)}：${without.text || '（沒有字）'}`);
        console.log(`   加詞彙　 ${mark(row.cerWith)}：${withVocab.text || '（沒有字）'}`);
      }
      if (row.phantom.length) console.log(`   ⚠ 沒講卻出現：${row.phantom.join('、')}（考慮從詞彙表拿掉）`);
      if (row.error) console.log(`   ⚠ ${row.error}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const tested = rows.filter((r) => !r.check);
  const sum = (key) => tested.reduce((s, r) => s + r[key], 0);
  const full = (key) => tested.filter((r) => r[key] === 0).length;
  const noise = rows.find((r) => r.check === 'noise');
  const phantoms = [...new Set(rows.flatMap((r) => r.phantom))];
  console.log('\n── 結果 ──');
  console.log(`整句全對：不加詞彙 ${full('cerWithout')}/${tested.length}，加詞彙 ${full('cerWith')}/${tested.length}`);
  console.log(`平均字錯誤率：不加詞彙 ${pct(sum('cerWithout') / (tested.length || 1))}，加詞彙 ${pct(sum('cerWith') / (tested.length || 1))}`);
  console.log(`代造詞：${phantoms.length ? phantoms.join('、') : '沒有'}${noise ? `；雜音轉出：${noise.with ? `「${noise.with}」` : '沒有字'}` : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err?.stack || String(err)); process.exit(1); });
}
