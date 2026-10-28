// A smooth noise bed: brown noise blended with pink (Paul Kellet's filter), independent per
// channel. No products of noise, so no grain. `patter` adds soft drop-like swells: random bumps
// that rise over a few milliseconds and fade over tens, so it never clicks.

const PATTER = { rate: 14, rise: 0.004, fall: 0.045 };   // bumps per second per channel, seconds

class CalmNoise extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            // share of brown against pink
            { name: 'tilt', defaultValue: 0.75, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'patter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
        ];
    }

    constructor() {
        super();
        this.channels = [0, 1].map(() => ({ brown: 0, pink: new Float32Array(7), drop: 0, bump: 0 }));
        this.dropChance = PATTER.rate / sampleRate;
        this.rise = 1 - Math.exp(-1 / (PATTER.rise * sampleRate));
        this.fall = Math.exp(-1 / (PATTER.fall * sampleRate));
    }

    process(inputs, outputs, parameters) {
        const tilt = parameters.tilt[0];
        const patter = parameters.patter[0];
        const { dropChance, rise, fall } = this;
        for (let c = 0; c < outputs[0].length; c++) {
            const out = outputs[0][c];
            const state = this.channels[c];
            const b = state.pink;
            let { drop, bump } = state;
            for (let i = 0; i < out.length; i++) {
                const white = Math.random() * 2 - 1;
                state.brown = (state.brown + 0.02 * white) / 1.02;
                b[0] = 0.99886 * b[0] + white * 0.0555179;
                b[1] = 0.99332 * b[1] + white * 0.0750759;
                b[2] = 0.969 * b[2] + white * 0.153852;
                b[3] = 0.8665 * b[3] + white * 0.3104856;
                b[4] = 0.55 * b[4] + white * 0.5329522;
                b[5] = -0.7616 * b[5] - white * 0.016898;
                const pink = (b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + white * 0.5362) * 0.11;
                b[6] = white * 0.115926;
                let sample = tilt * state.brown * 3.5 + (1 - tilt) * pink;
                if (patter > 0) {
                    if (Math.random() < dropChance) drop = 0.6 + 0.8 * Math.random();
                    drop *= fall;
                    bump += rise * (drop - bump);
                    // capped, so overlapping bumps never stack into a peak
                    sample *= 1 - patter + patter * 2 * Math.min(bump, 0.8);
                }
                out[i] = sample;
            }
            state.drop = drop;
            state.bump = bump;
        }
        return true;
    }
}

registerProcessor('calm-noise', CalmNoise);
