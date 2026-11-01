// Credit: adapted from an earlier voice project (proven on iPhone Chrome 2026-10-29)
// Takes whatever rate the phone captures at (usually 48 kHz) and sends 100 ms
// blocks of 16 kHz signed 16-bit mono audio to the page.
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.last = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const ext = new Float32Array(ch.length + 1);
    ext[0] = this.last;
    ext.set(ch, 1);
    let pos = this.pos;
    while (pos < ext.length - 1) {
      const i = Math.floor(pos), f = pos - i;
      let s = ext[i] * (1 - f) + ext[i + 1] * f;
      s = Math.max(-1, Math.min(1, s));
      this.out[this.n++] = s < 0 ? s * 32768 : s * 32767;
      if (this.n === 1600) {
        const b = this.out.buffer;
        this.port.postMessage(b, [b]);
        this.out = new Int16Array(1600);
        this.n = 0;
      }
      pos += this.ratio;
    }
    this.pos = pos - ch.length;
    this.last = ch[ch.length - 1];
    return true;
  }
}
registerProcessor('mic-processor', MicProcessor);
