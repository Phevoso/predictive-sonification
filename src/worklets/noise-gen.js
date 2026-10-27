// Port of rain~.pd. Parameters are the patch's 0-127 slider values, scaled the way the patch does.

const PI = 3.14159;  // Pd's value, so the coefficients match
const DELAY_SECONDS = 0.5;

const clip = (x) => (x < -1 ? -1 : x > 1 ? 1 : x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Pd's bp~ cosine approximation (d_filter.c)
function qcos(f) {
    if (f >= -0.5 * PI && f <= 0.5 * PI) {
        const g = f * f;
        return ((g * g * g * (-1 / 720) + g * g * (1 / 24)) - g * 0.5) + 1;
    }
    return 0;
}

// Pd's bp~ coefficients: a two-pole resonator with its gain normalisation
function bandpass(frequency, q) {
    const omega = (frequency * 2 * PI) / sampleRate;
    const oneMinusR = q < 0.001 ? 1 : Math.min(1, omega / q);
    const r = 1 - oneMinusR;
    return { coef1: 2 * qcos(omega) * r, coef2: -r * r, gain: 2 * oneMinusR * (oneMinusR + r * omega) };
}

const PARAMETERS = ['crackles', 'hipass', 'dropAmount', 'intensity', 'windiness', 'dropGain', 'dropSize', 'size'];

class WeatherNoise extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return PARAMETERS.map((name) => ({ name, defaultValue: 0, minValue: 0, maxValue: 127, automationRate: 'k-rate' }));
    }

    constructor() {
        super();
        this.delaySamples = Math.round(DELAY_SECONDS * sampleRate);
        this.delayLength = this.delaySamples + 1;
        this.writeIndex = 0;
        this.channels = [0, 1].map(() => ({
            bpLast: 0, bpPrev: 0, band: 0, dropLop: 0, bodyLop: 0, hip: 0, dc: 0, crackle: 0, wind: 0,
            delay: new Float32Array(this.delayLength)
        }));
    }

    process(inputs, outputs, parameters) {
        const out = outputs[0];
        const frames = out[0].length;
        const slider = (name) => parameters[name][0] / 127;

        // The patch's slider scalings
        const crackles = slider('crackles');
        const hipassHz = 2 ** (14 * slider('hipass'));
        const dropAmountHz = 250 * 2 ** (6 * slider('dropAmount'));
        const q = 0.7 * 2 ** (5 * (1 - slider('intensity')));
        const windiness = slider('windiness') ** 4;
        const dropGain = slider('dropGain');
        const dropSizeHz = 250 * 2 ** (6 * slider('dropSize'));
        const sizeHz = 250 * 2 ** (6 * slider('size'));

        const bp = bandpass(sizeHz, q);
        const dropCoef = clamp01((dropAmountHz * 2 * PI) / sampleRate);
        const bodyCoef = clamp01((dropSizeHz * 2 * PI) / sampleRate);
        const hipCoef = clamp01(1 - (hipassHz * 2 * PI) / sampleRate);
        const hipNormal = 0.5 * (1 + hipCoef);
        const dcCoef = clamp01(1 - (3 * 2 * PI) / sampleRate);
        const dcNormal = 0.5 * (1 + dcCoef);
        const [left, right] = this.channels;

        for (let i = 0; i < frames; i++) {
            const readIndex = (this.writeIndex - this.delaySamples + this.delayLength) % this.delayLength;
            let bodies = 0;

            for (const ch of this.channels) {
                const noise = Math.random() * 2 - 1;

                // bp~ on the noise: the "size" of the weather
                const resonance = noise + bp.coef1 * ch.bpLast + bp.coef2 * ch.bpPrev;
                ch.bpPrev = ch.bpLast;
                ch.bpLast = resonance;
                ch.band = bp.gain * resonance;

                // drops: noise * band through the drop-amount lowpass, then the drop-size lowpass
                const product = noise * ch.band;
                ch.dropLop = dropCoef * product + (1 - dropCoef) * ch.dropLop;
                ch.bodyLop = bodyCoef * (product * ch.dropLop) + (1 - bodyCoef) * ch.bodyLop;

                // crackles, modulated by the drop body from half a second ago
                const delayed = ch.delay[readIndex];
                ch.delay[this.writeIndex] = ch.bodyLop;
                ch.crackle = (noise * crackles + ch.band) * delayed;

                // wind: drop body plus the highpassed band, scaled by windiness^4
                const hipNew = ch.band + hipCoef * ch.hip;
                const hipOut = hipNormal * (hipNew - ch.hip);
                ch.hip = hipNew;
                ch.wind = (ch.bodyLop + hipOut) * windiness;

                bodies += ch.bodyLop;
            }

            // half of each side's drops go to the other side
            const shared = 0.5 * bodies;
            for (let c = 0; c < 2; c++) {
                const ch = c ? right : left;
                const mixed = clip((ch.crackle + shared) * dropGain) + ch.wind;
                const dcNew = mixed + dcCoef * ch.dc;
                const sample = dcNormal * (dcNew - ch.dc);
                ch.dc = dcNew;
                out[c][i] = clip(sample * 0.7) * 0.8;
            }
            this.writeIndex = (this.writeIndex + 1) % this.delayLength;
        }
        return true;
    }
}

registerProcessor('weather-noise', WeatherNoise);
