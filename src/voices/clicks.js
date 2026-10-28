// A few milliseconds of band-passed noise. It fades in rather than starting at full level, which
// popped on speakers.

import { makeNoiseBuffer } from '../util.js';

const LEVEL = 1.34;   // trim to REFERENCE, by peak
const ATTACK = 0.004;
const DECAY = 0.03;

export class Clicks {
    constructor(ctx, output) {
        this.ctx = ctx;
        this.output = output;
        this.buffer = makeNoiseBuffer(ctx, 1);
    }

    play(time, velocity, frequency, pan = 0, output = this.output) {
        const source = new AudioBufferSourceNode(this.ctx, { buffer: this.buffer });
        const band = new BiquadFilterNode(this.ctx, { type: 'bandpass', frequency, Q: 1.6 });
        const env = new GainNode(this.ctx, { gain: 0 });
        env.gain.setValueAtTime(0, time);
        env.gain.linearRampToValueAtTime(LEVEL * velocity, time + ATTACK);
        env.gain.exponentialRampToValueAtTime(0.0001, time + ATTACK + DECAY);
        const panner = new StereoPannerNode(this.ctx, { pan });
        source.connect(band).connect(env).connect(panner).connect(output);
        source.start(time, this.rng() * 0.9, 0.05);
        source.onended = () => panner.disconnect();
    }
}
