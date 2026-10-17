// JarvisVoice 核心：本機斷句（跟平行沙盒 app 的 renderer/src/lib/voice/audioTurns.ts 同一套）。
// 每批 24 kHz PCM16 樣本送進來，判斷有沒有人聲，停頓 850 ms 就切一句。

// 沒有 server VAD：本地判斷有沒有人聲，停頓 850 ms 就切一句。
export class AudioTurnDetector {
  candidateStart = null;
  voicedMs = 0;
  silenceMs = 0;
  activeStart = null;
  lastVoiceEnd = 0;
  lastVoiced = false; // 最近一批有沒有人聲（算「停了多久」用）

  get speaking() { return this.activeStart !== null; }

  push(samples, startMs) {
    if (!samples.length) return null;
    const durationMs = samples.length / 24;
    let sum = 0;
    let peak = 0;
    for (const sample of samples) {
      const value = Math.abs(sample) / 32768;
      sum += value * value;
      peak = Math.max(peak, value);
    }
    const voiced = Math.sqrt(sum / samples.length) >= 0.011 || peak >= 0.055;
    this.lastVoiced = voiced;
    if (voiced) {
      if (this.candidateStart === null) this.candidateStart = startMs;
      this.voicedMs += durationMs;
      this.silenceMs = 0;
      this.lastVoiceEnd = startMs + durationMs;
      if (this.activeStart === null && this.voicedMs >= 180) this.activeStart = this.candidateStart;
      return null;
    }
    if (this.activeStart === null) {
      this.candidateStart = null;
      this.voicedMs = 0;
      return null;
    }
    this.silenceMs += durationMs;
    if (this.silenceMs < 850) return null;
    return this.takeTurn();
  }

  finish() {
    if (this.activeStart === null && this.candidateStart !== null && this.voicedMs >= 100) {
      this.activeStart = this.candidateStart;
    }
    if (this.activeStart !== null) return this.takeTurn();
    this.candidateStart = null;
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.lastVoiceEnd = 0;
    return null;
  }

  takeTurn() {
    const turn = { startMs: this.activeStart, endMs: this.lastVoiceEnd };
    this.candidateStart = null;
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.activeStart = null;
    this.lastVoiceEnd = 0;
    return turn;
  }
}
