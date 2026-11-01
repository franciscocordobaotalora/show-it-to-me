// live-audio.js – helpers for T10 live mode
// Shared between browser and node tests (CommonJS fallback)

function buildWavHeader(sampleRate, numSamples) {
  const byteRate = sampleRate * 2; // mono 16-bit
  const blockAlign = 2;
  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);
  // RIFF
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  return buf;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function buildWav(int16Array, sampleRate = 16000) {
  if (!(int16Array instanceof Int16Array)) throw new Error('need Int16Array');
  const header = new Uint8Array(buildWavHeader(sampleRate, int16Array.length));
  const wav = new Uint8Array(44 + int16Array.length * 2);
  wav.set(header, 0);
  // copy PCM little-endian
  for (let i = 0; i < int16Array.length; i++) {
    const s = int16Array[i];
    wav[44 + i * 2] = s & 0xff;
    wav[44 + i * 2 + 1] = (s >> 8) & 0xff;
  }
  return wav;
}

// For legacy tests that expect mono downsample; worklet already outputs 16kHz so this is identity if rate==16000
function downsampleFloat32To16k(float32, inputRate) {
  if (inputRate === 16000) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      let s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 32768 : s * 32767;
    }
    return out;
  }
  // simple linear downsample to 16k
  const ratio = inputRate / 16000;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Int16Array(outLen);
  let pos = 0;
  let idx = 0;
  while (pos < float32.length - 1 && idx < outLen) {
    const i = Math.floor(pos), f = pos - i;
    const s0 = float32[i] || 0, s1 = float32[i + 1] || 0;
    let s = s0 * (1 - f) + s1 * f;
    s = Math.max(-1, Math.min(1, s));
    out[idx++] = s < 0 ? s * 32768 : s * 32767;
    pos += ratio;
  }
  return out;
}

// VAD: compute RMS level 0..1 from int16 block
function computeLevel(int16Block) {
  if (!int16Block || !int16Block.length) return 0;
  let sum = 0;
  for (let i = 0; i < int16Block.length; i++) {
    const v = int16Block[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / int16Block.length);
}

// VAD state machine helpers for tests
const VAD = {
  THRESHOLD: 0.02, // empirical; tests will calibrate
  START_MS: 150,
  END_MS: 900,
  MAX_MS: 15000,
  BLOCK_MS: 100, // worklet sends 100ms blocks (1600 samples @16k)
  // Given level, returns true if speech detected
  isSpeech(level, threshold = 0.02) { return level > threshold; },
  // Simple state tracker for unit tests
  create() {
    return { speaking: false, speechMs: 0, silenceMs: 0, totalMs: 0 };
  },
  update(state, level, threshold = VAD.THRESHOLD) {
    const isSpeech = level > threshold;
    if (!state.speaking) {
      if (isSpeech) state.speechMs += VAD.BLOCK_MS; else state.speechMs = 0;
      if (state.speechMs >= VAD.START_MS) {
        state.speaking = true;
        state.silenceMs = 0;
        state.totalMs = state.speechMs;
        return 'speech_start';
      }
    } else {
      state.totalMs += VAD.BLOCK_MS;
      if (isSpeech) state.silenceMs = 0; else state.silenceMs += VAD.BLOCK_MS;
      if (state.silenceMs >= VAD.END_MS) {
        state.speaking = false;
        const evt = 'speech_end';
        state.speechMs = 0; state.silenceMs = 0;
        return evt;
      }
      if (state.totalMs >= VAD.MAX_MS) {
        state.speaking = false;
        state.speechMs = 0; state.silenceMs = 0;
        return 'speech_end';
      }
    }
    return null;
  }
};

// Sentence splitter for TTS
function splitSentences(text) {
  if (!text) return [];
  // split by sentence boundaries, keep chunks <=400 chars
  const raw = text.split(/(?<=[.!?])\s+/);
  const out = [];
  let cur = '';
  for (const s of raw) {
    const t = s.trim();
    if (!t) continue;
    const candidate = cur ? cur + ' ' + t : t;
    if (candidate.length > 400) {
      if (cur) out.push(cur);
      // if single sentence >400 split by comma
      if (t.length > 400) {
        let p = 0;
        while (p < t.length) {
          out.push(t.slice(p, p + 400));
          p += 400;
        }
        cur = '';
      } else cur = t;
    } else cur = candidate;
  }
  if (cur) out.push(cur);
  // ensure each ends with punctuation
  return out.map(s => /[.!?]$/.test(s) ? s : s + '.');
}

// Export for Node and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildWav, buildWavHeader, downsampleFloat32To16k, computeLevel, VAD, splitSentences };
}
if (typeof window !== 'undefined') {
  window.LiveAudio = { buildWav, downsampleFloat32To16k, computeLevel, VAD, splitSentences };
}
