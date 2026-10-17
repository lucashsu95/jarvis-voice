// 雲端即時轉寫：OpenAI Realtime 的 transcription 連線（openai 直連，或經平行沙盒 control 轉送）。
// 送音格式照平行沙盒 app：24kHz PCM16 的 input_audio_buffer.append，每句一個 commit；
// gpt-live-transcribe 沒有 server VAD，切句在本機（listen.mjs）。
// 連線等開口才接；control 一條連線最多 10 分鐘，空檔時先換新的。

const IDLE_CLOSE_MS = 60_000;
const RECONNECT_AFTER_MS = 9 * 60_000;

// connector() 回傳 { url, headers?, sessionUpdate? }；sessionUpdate 是開線後第一個送出的設定。
export function createRealtimeEngine({ connector, onFinal, onError, log }) {
  let ws = null;
  let open = false;
  let connectedAt = 0;
  let connecting = false;
  let retryAt = 0;
  const outgoing = []; // { kind: 'audio', bytes } | { kind: 'commit' }
  let pendingCommits = 0;
  const waitingFinal = new Set();

  async function connect() {
    if (ws || connecting || Date.now() < retryAt) return;
    connecting = true;
    try {
      const { url, headers, sessionUpdate } = await connector();
      const socket = new WebSocket(url, headers ? { headers } : undefined);
      ws = socket;
      socket.addEventListener('open', () => {
        if (ws !== socket) return;
        if (sessionUpdate) socket.send(JSON.stringify(sessionUpdate));
        open = true;
        connectedAt = Date.now();
        flush();
      });
      socket.addEventListener('message', (m) => onMessage(typeof m.data === 'string' ? m.data : String(m.data)));
      socket.addEventListener('close', (e) => {
        if (ws !== socket) return;
        ws = null;
        open = false;
        if (pendingCommits || waitingFinal.size) log('連線斷在一句話中間，那句沒收到');
        if (!connectedAt || Date.now() - connectedAt < 2000) onError(`轉寫連線被拒${e.reason ? `：${e.reason}` : `（${e.code}）`}`);
        pendingCommits = 0;
        waitingFinal.clear();
        connectedAt = 0;
      });
      socket.addEventListener('error', () => { /* close 會接著來 */ });
    } catch (err) {
      log(err.message);
      onError(err.message);
      retryAt = Date.now() + 5000;
    } finally {
      connecting = false;
    }
  }

  function closeSocket() {
    const socket = ws;
    ws = null;
    open = false;
    pendingCommits = 0;
    waitingFinal.clear();
    connectedAt = 0;
    try { socket?.close(); } catch { /* 已經關了 */ }
  }

  function flush() {
    if (!outgoing.length) return;
    if (!open || !ws || ws.readyState !== WebSocket.OPEN) {
      void connect();
      return;
    }
    for (const op of outgoing.splice(0)) {
      if (op.kind === 'audio') {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: op.bytes.toString('base64') }));
      } else {
        pendingCommits += 1;
        ws.send(JSON.stringify({ type: 'input_audio_buffer.commit', event_id: `commit_${crypto.randomUUID()}` }));
      }
    }
  }

  function onMessage(raw) {
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    switch (event.type) {
      case 'input_audio_buffer.committed':
        if (pendingCommits > 0) pendingCommits -= 1;
        if (event.item_id) waitingFinal.add(event.item_id);
        return;
      case 'conversation.item.input_audio_transcription.completed':
        if (event.item_id) waitingFinal.delete(event.item_id);
        onFinal(event.transcript ?? '');
        return;
      case 'conversation.item.input_audio_transcription.failed':
        if (event.item_id) waitingFinal.delete(event.item_id);
        log('一句轉寫失敗', event.error?.message ?? '');
        return;
      case 'error':
        if (event.error?.code === 'input_audio_buffer_commit_empty') {
          if (pendingCommits > 0) pendingCommits -= 1;
          return;
        }
        log('轉寫錯誤', event.error?.message ?? '');
        onError(event.error?.message || '轉寫錯誤');
        return;
      default:
    }
  }

  return {
    append(bytes) { outgoing.push({ kind: 'audio', bytes }); },
    commit() { outgoing.push({ kind: 'commit' }); flush(); },
    flush,
    busy: () => outgoing.length > 0 || pendingCommits > 0 || waitingFinal.size > 0 || connecting,
    // 每輪主迴圈呼叫：安靜夠久、或連線快到 10 分鐘上限時先關
    housekeeping({ active, quietForMs, speaking }) {
      if (!ws || speaking || outgoing.length || pendingCommits || waitingFinal.size) return;
      if ((!active && quietForMs > IDLE_CLOSE_MS) || (connectedAt && Date.now() - connectedAt > RECONNECT_AFTER_MS)) closeSocket();
    },
    close: closeSocket,
  };
}

// OpenAI 直連：跟平行沙盒 control 送給 OpenAI 的設定一樣（internal/boxes/transcription.go 的 sessionUpdate）。
export function openaiConnector({ apiKey, model = 'gpt-live-transcribe', languages = [] }) {
  return async () => {
    if (!apiKey) throw new Error('沒有 OpenAI API key（設定檔 openai.apiKey 或環境變數 OPENAI_API_KEY）');
    const transcription = { model, delay: 'low' };
    if (languages.length) transcription.languages = languages;
    return {
      url: process.env.VOICE_DICTATION_OPENAI_URL || 'wss://api.openai.com/v1/realtime?intent=transcription',
      headers: { Authorization: `Bearer ${apiKey}` },
      sessionUpdate: {
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription } },
        },
      },
    };
  };
}

// 平行沙盒：先用 API key 換一分鐘的語音 token，再連 control 的 /v1/transcription（session 設定由 control 送）。
export function parallelSandboxConnector({ apiKey, apiUrl }) {
  return async () => {
    if (!apiKey) throw new Error('沒有平行沙盒 API key（設定檔 parallelsandbox.apiKey 或 ~/.claude.json 的 parallelsandbox MCP）');
    const res = await fetch(`${apiUrl}/v1/transcription/token`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`換語音 token 失敗（HTTP ${res.status}）`);
    const { token } = await res.json();
    return { url: `${apiUrl.replace(/^http/, 'ws')}/v1/transcription?t=${encodeURIComponent(token)}` };
  };
}
