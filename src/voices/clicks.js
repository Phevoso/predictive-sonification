// A few milliseconds of band-passed noise

import { makeNoiseBuffer } from '../util.js';

const LEVEL = 1.34;   // trim to REFERENCE, by peak

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
        env.gain.setValueAtTime(LEVEL * velocity, time);
        env.gain.exponentialRampToValueAtTime(0.0001, time + 0.012);
        const panner = new StereoPannerNode(this.ctx, { pan });
        source.connect(band).connect(env).connect(panner).connect(output);
        source.start(time, this.rng() * 0.9, 0.03);
        source.onended = () => panner.disconnect();
    }
}
