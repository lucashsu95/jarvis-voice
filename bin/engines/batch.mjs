// OpenAI 一般轉寫（預設 gpt-transcribe）：每講完一句，把那句的音訊包成 WAV 上傳 /v1/audio/transcriptions。
// 整句一次看完，不用邊聽邊猜；價格約是即時版的四分之一。
// 句子可以同時上傳，回來的字照講的順序貼。

const MIN_BYTES = 24000 * 2 * 0.15; // 不到 0.15 秒當雜音
const TIMEOUT_MS = 20_000;

export function wavFromPcm16(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk 長度
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 單聲道
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function createBatchEngine({ apiKey, model = 'gpt-transcribe', languages = [], prompt = '', keywords = [], onFinal, onError, log }) {
  const url = process.env.VOICE_DICTATION_OPENAI_HTTP_URL || 'https://api.openai.com/v1/audio/transcriptions';
  let chunks = [];
  let bytes = 0;
  let nextSeq = 0;
  let deliverSeq = 0;
  let inflight = 0;
  let closed = false;
  const results = new Map(); // seq → 字（失敗是空字串）

  function deliver() {
    while (results.has(deliverSeq)) {
      const text = results.get(deliverSeq);
      results.delete(deliverSeq);
      deliverSeq += 1;
      if (text && !closed) onFinal(text);
    }
  }

  async function transcribe(wav) {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', model);
    form.append('response_format', 'json');
    // gpt-transcribe 用 languages[]（取代單一的 language）、keywords[]（一詞一欄）
    for (const lang of languages) form.append('languages[]', lang);
    for (const word of keywords) form.append('keywords[]', word);
    if (prompt) form.append('prompt', prompt);
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const message = detail.match(/"message":\s*"([^"]+)"/)?.[1] ?? detail.slice(0, 160);
      const error = new Error(`OpenAI 轉寫失敗（HTTP ${res.status}）${message ? `：${message}` : ''}`);
      error.retry = res.status === 429 || res.status >= 500;
      throw error;
    }
    const body = await res.json();
    return typeof body.text === 'string' ? body.text : '';
  }

  async function run(seq, wav) {
    inflight += 1;
    const started = Date.now();
    try {
      let text;
      try {
        text = await transcribe(wav);
      } catch (err) {
        if (err.retry === false) throw err;
        await new Promise((r) => setTimeout(r, 1000)); // 網路或伺服器問題重試一次
        text = await transcribe(wav);
      }
      log(`OpenAI 一般轉寫 ${((wav.length - 44) / 48000).toFixed(1)} 秒音訊用 ${Date.now() - started} ms`);
      results.set(seq, text);
    } catch (err) {
      log(err.message);
      onError(err.message);
      results.set(seq, '');
    } finally {
      inflight -= 1;
      deliver();
    }
  }

  return {
    append(buffer) { chunks.push(buffer); bytes += buffer.length; },
    commit() {
      const pcm = Buffer.concat(chunks, bytes);
      chunks = [];
      bytes = 0;
      if (!apiKey) {
        onError('沒有 OpenAI API key（設定檔 openai.apiKey、openai.apiKeyFile，或環境變數 OPENAI_API_KEY）');
        return;
      }
      if (pcm.length < MIN_BYTES) return;
      void run(nextSeq++, wavFromPcm16(pcm));
    },
    flush() {},
    busy: () => inflight > 0 || results.size > 0,
    housekeeping() {},
    close() { closed = true; chunks = []; bytes = 0; },
  };
}
