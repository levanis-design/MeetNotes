// AudioWorklet that mixes input channels to mono and posts 100 ms blocks of samples.
class PcmCollector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(1600); // 100 ms at 16 kHz
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < input.length; c++) s += input[c][i];
      this.block[this.filled++] = s / input.length;
      if (this.filled === this.block.length) {
        this.port.postMessage(this.block.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-collector', PcmCollector);
