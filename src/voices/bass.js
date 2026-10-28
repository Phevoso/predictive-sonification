// A sine that never stops, gliding to each chord root, with a quiet octave above for small speakers

import { mtof } from '../util.js';
import { TONIC } from '../music/harmony.js';

const BASS = { level: 0.091, octave: 0.22, glide: 1.4, swell: 1.7 };   // level: trim to REFERENCE

export class Bass {
    constructor(ctx, output) {
        this.weight = 1;      // set from the readings: heavier under high pressure
        this.env = new GainNode(ctx, { gain: 0 });
        this.env.connect(output);
        this.osc = new OscillatorNode(ctx, { frequency: mtof(TONIC) });
        this.upper = new OscillatorNode(ctx, { frequency: mtof(TONIC + 12) });
        this.osc.connect(this.env);
        this.upper.connect(new GainNode(ctx, { gain: BASS.octave })).connect(this.env);
        this.osc.start();
        this.upper.start();
    }

    play(midi, time) {
        this.osc.frequency.setTargetAtTime(mtof(midi), time, BASS.glide / 3);
        this.upper.frequency.setTargetAtTime(mtof(midi + 12), time, BASS.glide / 3);
        this.env.gain.setTargetAtTime(BASS.level * this.weight, time, 2);
    }

    swell(time) {
        this.env.gain.setTargetAtTime(BASS.level * this.weight * BASS.swell, time, 0.8);
        this.env.gain.setTargetAtTime(BASS.level * this.weight, time + 2.5, 2);
    }

    fade(time, tau) {
        this.env.gain.setTargetAtTime(0, time, tau);
    }
}
