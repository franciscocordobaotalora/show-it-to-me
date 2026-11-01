const assert=require('assert');
const {buildWav, downsampleFloat32To16k, computeLevel, VAD} = require('../static/live-audio.js');

// WAV header
(function testWavHeader(){
  const int16=new Int16Array([0, 32767, -32768, 1000]);
  const wav=buildWav(int16,16000);
  // RIFF
  assert.equal(String.fromCharCode(...wav.slice(0,4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.slice(8,12)), 'WAVE');
  // fmt PCM
  assert.equal(String.fromCharCode(...wav.slice(12,16)), 'fmt ');
  const view=new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint32(24,true),16000);
  assert.equal(view.getUint16(22,true),1); // mono
  assert.equal(view.getUint16(34,true),16); // bits
  assert.equal(view.getUint32(40,true), int16.length*2);
  // data bytes match
  assert.equal(wav.length,44+int16.length*2);
  // sample count preservation via header
  const dataBytes=view.getUint32(40,true);
  assert.equal(dataBytes/2, int16.length);
  console.log('wav header ok');
})();

// downsampler 48k->16k
(function testDownsampler(){
  const sr=48000;
  const float32=new Float32Array(480);
  for(let i=0;i<float32.length;i++) float32[i]=Math.sin(2*Math.PI*440*i/sr);
  const out=downsampleFloat32To16k(float32, sr);
  assert.equal(out.length, Math.floor(float32.length *16000/sr));
  // identity at 16k
  const f2=new Float32Array([0.5, -0.5, 0]);
  const out2=downsampleFloat32To16k(f2,16000);
  assert.equal(out2.length,3);
  console.log('downsampler ok');
})();

// VAD thresholds synthetic signals
(function testVAD(){
  // silence block
  const silent=new Int16Array(1600); // zeros
  let lvl=computeLevel(silent);
  assert(lvl < 0.001, 'silent level '+lvl);
  assert.equal(VAD.isSpeech(lvl), false);
  // loud block (max)
  const loud=new Int16Array(1600);
  for(let i=0;i<loud.length;i++) loud[i]= 20000;
  lvl=computeLevel(loud);
  assert(lvl > 0.1, 'loud level '+lvl);
  assert.equal(VAD.isSpeech(lvl), true);
  // state machine: needs 150ms speech to trigger, 900ms silence to end
  let st=VAD.create();
  // two loud blocks = 200ms -> should trigger speech_start on second
  let evt=VAD.update(st, computeLevel(silent));
  assert.equal(evt,null);
  evt=VAD.update(st, computeLevel(loud));
  assert.equal(evt,null); // first 100ms
  evt=VAD.update(st, computeLevel(loud));
  assert.equal(evt,'speech_start');
  // now need 9 silent blocks to end
  for(let i=0;i<8;i++){ evt=VAD.update(st, computeLevel(silent)); assert.equal(evt,null); }
  evt=VAD.update(st, computeLevel(silent));
  assert.equal(evt,'speech_end');
  // max utterance 15s = 150 blocks (200ms for start + 148*100ms = 15000 triggers on last)
  st=VAD.create();
  VAD.update(st, computeLevel(loud)); VAD.update(st, computeLevel(loud)); // start tot 200
  for(let i=0;i<147;i++) { evt=VAD.update(st, computeLevel(loud)); assert.equal(evt,null); }
  evt=VAD.update(st, computeLevel(loud));
  assert.equal(evt,'speech_end');
  console.log('VAD ok');
})();

// Pre-roll 400ms ring buffer proves first word not clipped
(function testPreRoll(){
  const {PreRollBuffer, PRE_ROLL_MS, PRE_ROLL_SAMPLES, prependPreRoll} = require('../static/live-audio.js');
  assert.equal(PRE_ROLL_MS,400);
  assert.equal(PRE_ROLL_SAMPLES,6400);
  const buf=new PreRollBuffer();
  // simulate 10 blocks of 100ms (1600 samples each) with distinct values 1..10
  for(let b=0;b<10;b++){
    const block=new Int16Array(1600);
    block.fill(b+1);
    buf.push(block);
  }
  // should keep only last 4 blocks (6400 samples) = values 7,8,9,10
  const pre=buf.get();
  assert.equal(pre.length, 6400);
  assert.equal(pre[0],7);
  assert.equal(pre[1600],8);
  assert.equal(pre[3200],9);
  assert.equal(pre[4800],10);
  // prepend to utterance: simulate utterance blocks 11,12 after speech_start
  const utt=new Int16Array(3200);
  utt.fill(99);
  const combined=prependPreRoll(utt, pre);
  assert.equal(combined.length, 6400+3200);
  assert.equal(combined[0],7);
  assert.equal(combined[6400],99);
  // build WAV and verify data length includes pre-roll
  const wav=buildWav(combined,16000);
  assert.equal(wav.length,44+combined.length*2);
  console.log('pre-roll 400ms ok, wav includes pre-roll',combined.length,'samples');
})();

console.log('All live audio tests passed');
