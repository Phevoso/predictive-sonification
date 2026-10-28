// Salamander Grand Piano, one sample every minor third, played as if the mute pedal were down:
// two lowpasses for the felt, a softened attack, a little detuning and a long pedal.

import { between, clamp } from '../util.js';

const PIANO = {
    samples: ['A2', 'C3', 'Ds3', 'Fs3', 'A3', 'C4', 'Ds4', 'Fs4', 'A4', 'C5', 'Ds5', 'Fs5', 'A5', 'C6', 'Ds6', 'Fs6', 'A6'],
    level: 4,             // trim to REFERENCE; the samples peak around 0.3
    curve: 1.6,           // velocity exponent
    felt: [380, 1300],    // Hz, soft to hard touch
    attack: 0.018,
    detune: 9,            // cents
    pedal: [3, 5.5],      // seconds a note rings past its length
    damp: 0.35
};

const PITCH_CLASSES = { C: 0, Cs: 1, D: 2, Ds: 3, E: 4, F: 5, Fs: 6, G: 7, Gs: 8, A: 9, As: 10, B: 11 };

export class Piano {
    constructor(ctx, output) {
        this.ctx = ctx;
        this.output = output;
        this.samples = null;
        this.tone = 1;        // set from the readings: lower under cloud, higher in hot plasma
    }

    get ready() {
        return this.samples !== null;
    }

    load() {
        this.loading ??= Promise.all(PIANO.samples.map(async (name) => {
            const [, pitch, octave] = name.match(/^([A-G]s?)(\d)$/);
            const response = await fetch(new URL(`../../assets/samples/piano/${name}.mp3`, import.meta.url));
            if (!response.ok) throw new Error(`${response.status} for ${name}.mp3`);
            const buffer = await this.ctx.decodeAudioData(await response.arrayBuffer());
            return { midi: 12 * (Number(octave) + 1) + PITCH_CLASSES[pitch], buffer };
        }))
            .then((samples) => { this.samples = samples; })
            .catch((error) => console.warn('Piano samples unavailable', error));
        return this.loading;
    }

    // Returns how long the note rings
    play(midi, time, velocity, { brightness = 0.3, length = 1, pan = 0, cutoff = null } = {}) {
        const ctx = this.ctx;
        const sample = this.samples.reduce((best, s) => (Math.abs(s.midi - midi) < Math.abs(best.midi - midi) ? s : best));
        const cents = (this.rng() * 2 - 1) * PIANO.detune;
        const source = new AudioBufferSourceNode(ctx, { buffer: sample.buffer, playbackRate: 2 ** ((midi - sample.midi + cents / 100) / 12) });
        const frequency = (cutoff ?? between(PIANO.felt, clamp(0.7 * velocity + 0.5 * brightness))) * this.tone;
        const felt = new BiquadFilterNode(ctx, { type: 'lowpass', frequency, Q: 0.4 });
        const mute = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: frequency * 1.4, Q: 0.5 });
        const env = new GainNode(ctx, { gain: 0 });
        const panner = new StereoPannerNode(ctx, { pan });
        source.connect(felt).connect(mute).connect(env).connect(panner).connect(this.output);

        const ring = length + between(PIANO.pedal, this.rng());
        env.gain.setValueAtTime(0, time);
        env.gain.linearRampToValueAtTime(PIANO.level * velocity ** PIANO.curve, time + PIANO.attack);
        env.gain.setTargetAtTime(0, time + ring, PIANO.damp);
        source.start(time);
        source.stop(time + ring + PIANO.damp * 6);
        source.onended = () => panner.disconnect();
        return ring;
    }
}
