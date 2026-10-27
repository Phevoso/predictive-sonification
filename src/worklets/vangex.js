// Port of vangex~.pd with the envelope from vangex_tape_looper.pd. Voices run continuously as in
// the patch; a note retunes a voice and opens its envelope at the given context time.
// The six loopers go through eq_filters~ (fi.resonator), which filter_ramp sweeps on every
// looper trigger.

const PI = 3.14159;  // Pd's value, so the coefficients match
const BUFFER_SECONDS = 1;  // delwrite~ $0-vang 1000
const VOICES = 7;          // six tape loops plus one lead voice for phrases
const LOOPERS = 6;
const SMOOTHING = 0.05;    // seconds of glide on per-second gain / harmonic updates

// filter_ramp: towards 1500 Hz over 1.5 s, turning back to 200 Hz after 100 ms.
// Q follows the frequency, 200..2000 Hz -> 0.7..6.
const RAMP = { peak: 1500, rest: 200, time: 1.5, turn: 0.1 };
const rampQ = (hz) => 0.7 + ((hz - 200) / 1800) * 5.3;

// output stage: each looper * 0.16, then the mix (0.5 at load)
const LOOPER_LEVEL = 0.16;
const MIX = 0.5;

const lopCoef = (hz) => Math.min(1, Math.max(0, (hz * 2 * PI) / sampleRate));
const mtof = (midi) => 8.17579891564 * Math.exp(0.0577622650 * midi);

class Voice {
    constructor() {
        this.buffer = new Float32Array(Math.ceil(BUFFER_SECONDS * sampleRate) + 4);
        this.write = 0;
        this.phase = 0;
        this.integrator = 0;
        this.oscLop = 0;
        this.feedbackLop = 0;
        this.outLop = 0;
        this.hip = 0;
        this.period = 0;   // ms, smoothed by lop~ 10
        this.midi = 48;
        this.pan = 0;
        // Envelope: Pd's [line] towards a target over a ramp time
        this.env = 0;
        this.envTarget = 0;
        this.envStep = 0;
        this.releaseAt = Infinity;
        this.release = 0.7;
        this.gain = 5;
        this.gainTarget = 5;
        this.harmonic = 1;
        this.harmonicTarget = 1;
    }

    // Pd's vd~ 4-point interpolation, `delay` in samples. Called before this sample is written,
    // so x[n - k] sits k - 1 places behind the last write.
    read(delay) {
        const length = this.buffer.length;
        const whole = Math.floor(delay);
        const frac = delay - whole;
        const at = (k) => this.buffer[(this.write + 1 - k + length) % length];
        const a = at(whole - 1);
        const b = at(whole);
        const c = at(whole + 1);
        const d = at(whole + 2);
        const cminusb = c - b;
        return b + frac * (cminusb - 0.1666667 * (1 - frac) * ((d - a - 3 * cminusb) * frac + (d + 2 * a - 3 * b)));
    }

    rampTo(target, seconds) {
        this.envTarget = target;
        const samples = Math.max(1, seconds * sampleRate);
        this.envStep = (target - this.env) / samples;
    }
}

// fi.resonator's coefficients (Audio EQ Cookbook BPF, constant skirt gain), as biquad~ runs them
function resonatorCoefficients(hz, q) {
    const w0 = (2 * Math.PI * Math.min(20000, Math.max(20, hz))) / sampleRate;
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    return { b0: Math.sin(w0) / 2 / a0, b2: -Math.sin(w0) / 2 / a0, a1: (-2 * Math.cos(w0)) / a0, a2: (1 - alpha) / a0 };
}

class Vangex extends AudioWorkletProcessor {
    constructor() {
        super();
        this.voices = Array.from({ length: VOICES }, () => new Voice());
        this.queue = [];
        // filter_ramp state: a [line] from `from` to `to` starting at `start`
        this.ramp = { from: RAMP.rest, to: RAMP.rest, start: 0, time: RAMP.time, turnAt: Infinity };
        this.filter = [0, 1].map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 }));
        this.reportAt = 0;
        this.port.onmessage = ({ data }) => {
            if (data.type === 'params') {
                data.gain.forEach((g, i) => { this.voices[i].gainTarget = g; });
                data.harmonic.forEach((h, i) => { this.voices[i].harmonicTarget = h; });
            } else if (data.type === 'note') {
                this.queue.push(data);
                this.queue.sort((x, y) => x.time - y.time);
            }
        };
    }

    rampValue(now) {
        const r = this.ramp;
        const t = Math.min(1, Math.max(0, (now - r.start) / r.time));
        return r.from + (r.to - r.from) * t;
    }

    rampTo(target, now) {
        this.ramp = { ...this.ramp, from: this.rampValue(now), to: target, start: now };
    }

    // A tape-looper trigger: new note, envelope up over `attack`, held, then down over `release`
    start(note, now) {
        const voice = this.voices[note.voice];
        voice.midi = note.midi;
        voice.pan = note.pan;
        voice.release = note.release;
        voice.rampTo(note.peak, note.attack);
        voice.releaseAt = note.time + note.hold;
        if (note.voice < LOOPERS) {
            this.rampTo(RAMP.peak, now);
            this.ramp.turnAt = now + RAMP.turn;
        }
    }

    process(inputs, outputs) {
        const [left, right] = outputs[0];
        const frames = left.length;
        const oscCoef = lopCoef(1000);
        const fbCoef = lopCoef(4000);
        const outCoef = lopCoef(4000);
        const periodCoef = lopCoef(10);
        const hipCoef = Math.min(1, Math.max(0, 1 - (1 * 2 * PI) / sampleRate));
        const hipNormal = 0.5 * (1 + hipCoef);
        const msToSamples = sampleRate / 1000;
        const glide = 1 - Math.exp(-frames / (SMOOTHING * sampleRate));

        const blockStart = currentFrame / sampleRate;
        if (blockStart >= this.ramp.turnAt) {
            this.rampTo(RAMP.rest, blockStart);
            this.ramp.turnAt = Infinity;
        }
        const resonance = this.rampValue(blockStart);
        const k = resonatorCoefficients(resonance, rampQ(resonance));
        if (blockStart >= this.reportAt) {
            this.port.postMessage({ type: 'resonator', frequency: resonance, q: rampQ(resonance) });
            this.reportAt = blockStart + 0.1;
        }

        for (const v of this.voices) {
            v.gain += glide * (v.gainTarget - v.gain);
            v.harmonic += glide * (v.harmonicTarget - v.harmonic);
        }

        for (let i = 0; i < frames; i++) {
            const now = (currentFrame + i) / sampleRate;
            while (this.queue.length && this.queue[0].time <= now) this.start(this.queue.shift(), now);

            let sumL = 0;
            let sumR = 0;
            let leadL = 0;
            let leadR = 0;
            for (let n = 0; n < VOICES; n++) {
                const v = this.voices[n];
                const harmonicScale = 1 + 0.01 * v.harmonic;
                const level = LOOPER_LEVEL * MIX * v.gain;
                if (now >= v.releaseAt) {
                    v.rampTo(0, v.release);
                    v.releaseAt = Infinity;
                }
                if (v.envStep !== 0) {
                    v.env += v.envStep;
                    if ((v.envStep > 0 && v.env >= v.envTarget) || (v.envStep < 0 && v.env <= v.envTarget)) {
                        v.env = v.envTarget;
                        v.envStep = 0;
                    }
                }

                // phasor~ -> rpole~ with coefficient [phasor >= 0.1]: an integrator that resets
                // during the first tenth of each cycle
                const freq = mtof(v.midi);
                v.phase += freq / sampleRate;
                v.phase -= Math.floor(v.phase);
                v.integrator = v.phase + (v.phase >= 0.1 ? v.integrator : 0);
                v.oscLop += oscCoef * (v.integrator * 0.0001 - v.oscLop);

                // Delay tuned to two periods (lop~ 10 glides it), stretched by the harmonic modulation
                v.period += periodCoef * (1000 / freq - v.period);
                const delay = Math.min(v.buffer.length - 4, Math.max(1.00001, 2 * v.period * harmonicScale * msToSamples));
                const delayed = 0.85 * v.read(delay);

                // Feedback through lop~ 4000, summed with the oscillator into delwrite~
                v.feedbackLop += fbCoef * (delayed - v.feedbackLop);
                v.write = (v.write + 1) % v.buffer.length;
                v.buffer[v.write] = v.oscLop * v.gain + v.feedbackLop;

                // hip~ 1 -> tanh~ -> lop~ 4000
                const hipNew = delayed + hipCoef * v.hip;
                const hipOut = hipNormal * (hipNew - v.hip);
                v.hip = hipNew;
                v.outLop += outCoef * (Math.tanh(hipOut) - v.outLop);

                const sample = v.outLop * v.env * level;
                const l = sample * Math.cos((v.pan + 1) * Math.PI / 4);
                const r = sample * Math.sin((v.pan + 1) * Math.PI / 4);
                if (n < LOOPERS) {
                    sumL += l;
                    sumR += r;
                } else {
                    leadL += l;
                    leadR += r;
                }
            }

            // The loopers through the swept resonator; the lead voice joins after it
            const [fl, fr] = this.filter;
            const yl = k.b0 * sumL + k.b2 * fl.x2 - k.a1 * fl.y1 - k.a2 * fl.y2;
            fl.x2 = fl.x1; fl.x1 = sumL; fl.y2 = fl.y1; fl.y1 = yl;
            const yr = k.b0 * sumR + k.b2 * fr.x2 - k.a1 * fr.y1 - k.a2 * fr.y2;
            fr.x2 = fr.x1; fr.x1 = sumR; fr.y2 = fr.y1; fr.y1 = yr;
            left[i] = yl + leadL;
            right[i] = yr + leadR;
        }
        return true;
    }
}

registerProcessor('vangex', Vangex);
