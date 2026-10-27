// The expected voice: long chords following the forecast. Played on the Vangex worklet (a port of
// vangex~.pd), or on a plain detuned triangle/saw synth if Vangex is off or still loading.

import { between, mtof } from '../util.js';

export const PADS = {
    instrument: 'vangex',   // or 'synth'
    attack: [3, 6],
    release: [6, 10],
    chord: [9, 16],         // seconds per chord
    cutoff: [450, 4200],
    synth: { detune: [6, 12], saw: 0.35, level: 0.074 },   // levels are trims to REFERENCE
    vangex: {
        banks: 2,           // two instances take turns so a chord's release isn't retuned
        peak: 0.1,
        gain: 5,
        harmonic: [1, 6],
        level: 80
    }
};

export class Pads {
    constructor(ctx, output) {
        this.ctx = ctx;
        this.output = output;
        this.vangexOut = new GainNode(ctx, { gain: PADS.vangex.level });
        this.vangexOut.connect(output);
        this.banks = null;
        this.bank = 0;
    }

    load() {
        if (PADS.instrument !== 'vangex' || this.loading) return this.loading;
        this.loading = this.ctx.audioWorklet
            .addModule(new URL('../worklets/vangex.js', import.meta.url))
            .then(() => {
                this.banks = Array.from({ length: PADS.vangex.banks }, () => {
                    const node = new AudioWorkletNode(this.ctx, 'vangex', { numberOfInputs: 0, outputChannelCount: [2] });
                    node.connect(this.vangexOut);
                    return node;
                });
            })
            .catch((error) => console.warn('Vangex unavailable, using the synth pads', error));
        return this.loading;
    }

    envelope() {
        return { attack: between(PADS.attack, this.rng()), release: between(PADS.release, this.rng()) };
    }

    play(notes, time, hold, { attack, release }, pans, brightness) {
        if (PADS.instrument === 'vangex' && this.banks) this.playVangex(notes, time, hold, attack, release, pans, brightness);
        else notes.forEach((midi, i) => this.playSynth(midi, time, hold, attack, release, pans[i]));
    }

    // One Vangex voice per chord tone; brightness sets the harmonic modulation
    playVangex(notes, time, hold, attack, release, pans, brightness) {
        const node = this.banks[this.bank];
        this.bank = (this.bank + 1) % this.banks.length;
        const { gain, harmonic, peak } = PADS.vangex;
        const modulation = Math.round(between(harmonic, brightness));
        node.port.postMessage({ type: 'params', gain: Array(7).fill(gain), harmonic: Array(7).fill(modulation) });
        notes.forEach((midi, voice) => {
            node.port.postMessage({ type: 'note', voice, midi, time, hold, attack, release, peak, pan: pans[voice] });
        });
    }

    playSynth(midi, time, hold, attack, release, pan) {
        const { detune: range, saw, level } = PADS.synth;
        const detune = between(range, this.rng());
        const out = new GainNode(this.ctx, { gain: 0 });
        out.gain.setValueAtTime(0, time);
        out.gain.linearRampToValueAtTime(level, time + attack);
        out.gain.setTargetAtTime(0, time + hold, release / 4);
        const panner = new StereoPannerNode(this.ctx, { pan });
        out.connect(panner).connect(this.output);

        const end = time + hold + release * 1.5;
        const triangle = new OscillatorNode(this.ctx, { type: 'triangle', frequency: mtof(midi), detune: -detune });
        const sawtooth = new OscillatorNode(this.ctx, { type: 'sawtooth', frequency: mtof(midi), detune });
        triangle.connect(out);
        sawtooth.connect(new GainNode(this.ctx, { gain: saw })).connect(out);
        for (const osc of [triangle, sawtooth]) {
            osc.start(time);
            osc.stop(end);
        }
        triangle.onended = () => panner.disconnect();
    }
}
