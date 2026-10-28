// Port of vangex~.pd with the envelope from vangex_tape_looper.pd. Voices run continuously as in
// the patch while they sound, and pause while silent to save the audio thread; a note retunes a
// voice and opens its envelope at the given context time.
// The six loopers go through eq_filters~ (fi.resonator), which filter_ramp sweeps on every
// looper trigger.

const PI = 3.14159;  // Pd's value, so the coefficients match
const BUFFER_SECONDS = 1;  // delwrite~ $0-vang 1000
const VOICES = 7;          // six tape loops plus one lead voice for phrases
const LOOPERS = 6;
const SMOOTHING = 0.05;    // seconds of glide on per-second gain / harmonic updates
const PAN_GLIDE = 0.03;    // seconds; a reused voice may still be sounding, so pan never jumps

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
        this.tune(48);
        // equal-power pan gains, gliding towards the note's
        this.panL = this.panR = this.panLTarget = this.panRTarget = Math.SQRT1_2;
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

    tune(midi) {
        this.midi = midi;
        this.frequency = mtof(midi);
        this.increment = this.frequency / sampleRate;
        this.periodTarget = 1000 / this.frequency;
    }

    panTo(pan) {
        this.panLTarget = Math.cos((pan + 1) * Math.PI / 4);
        this.panRTarget = Math.sin((pan + 1) * Math.PI / 4);
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
        voice.tune(note.midi);
        voice.panTo(note.pan);
        voice.release = note.release;
        voice.rampTo(note.peak, note.attack);
        voice.releaseAt = note.time + note.hold;
        if (note.voice < LOOPERS) {
            this.rampTo(RAMP.peak, now);
            this.ramp.turnAt = now + RAMP.turn;
        }
    }

    process(inputs, outputs) {
        const left = outputs[0][0], right = outputs[0][1];
        const frames = left.length;
        const oscCoef = lopCoef(1000);
        const fbCoef = lopCoef(4000);
        const outCoef = lopCoef(4000);
        const periodCoef = lopCoef(10);
        const hipCoef = Math.min(1, Math.max(0, 1 - (1 * 2 * PI) / sampleRate));
        const hipNormal = 0.5 * (1 + hipCoef);
        const msToSamples = sampleRate / 1000;
        const glide = 1 - Math.exp(-frames / (SMOOTHING * sampleRate));
        const panCoef = 1 - Math.exp(-1 / (PAN_GLIDE * sampleRate));

        const blockStart = currentFrame / sampleRate;
        const blockEnd = (currentFrame + frames) / sampleRate;
        // Notes land on the block they fall in, at most one block (under 3 ms) early
        while (this.queue.length && this.queue[0].time < blockEnd) this.start(this.queue.shift(), blockStart);
        if (blockStart >= this.ramp.turnAt) {
            this.rampTo(RAMP.rest, blockStart);
            this.ramp.turnAt = Infinity;
        }
        const resonance = this.rampValue(blockStart);
        const k = resonatorCoefficients(resonance, rampQ(resonance));

        if (!this.mix || this.mix[0].length !== frames) this.mix = [0, 1, 2, 3].map(() => new Float32Array(frames));
        const loopL = this.mix[0], loopR = this.mix[1], leadL = this.mix[2], leadR = this.mix[3];
        for (let m = 0; m < 4; m++) this.mix[m].fill(0);

        // Each voice runs a whole block with its state in locals, which the audio thread
        // handles far faster than touching the voice's fields on every sample
        for (let n = 0; n < VOICES; n++) {
            const v = this.voices[n];
            v.gain += glide * (v.gainTarget - v.gain);
            v.harmonic += glide * (v.harmonicTarget - v.harmonic);
            if (v.releaseAt < blockEnd) {
                v.rampTo(0, v.release);
                v.releaseAt = Infinity;
            }
            // A silent voice is skipped until its next note; it picks up where it stopped
            if (v.env === 0 && v.envStep === 0) continue;

            const outL = n < LOOPERS ? loopL : leadL;
            const outR = n < LOOPERS ? loopR : leadR;
            const gain = v.gain;
            const level = LOOPER_LEVEL * MIX * gain;
            const delayScale = 2 * (1 + 0.01 * v.harmonic) * msToSamples;
            const buffer = v.buffer;
            const length = buffer.length;
            const longest = length - 4;
            const { increment, periodTarget, envTarget, panLTarget, panRTarget } = v;
            let { env, envStep, phase, integrator, oscLop, period, feedbackLop, write, hip, outLop, panL, panR } = v;

            for (let i = 0; i < frames; i++) {
                if (envStep !== 0) {
                    env += envStep;
                    if ((envStep > 0 && env >= envTarget) || (envStep < 0 && env <= envTarget)) {
                        env = envTarget;
                        envStep = 0;
                    }
                }

                // phasor~ -> rpole~ with coefficient [phasor >= 0.1]: an integrator that resets
                // during the first tenth of each cycle
                phase += increment;
                if (phase >= 1) phase -= 1;
                integrator = phase + (phase >= 0.1 ? integrator : 0);
                oscLop += oscCoef * (integrator * 0.0001 - oscLop);

                // Delay tuned to two periods (lop~ 10 glides it), stretched by the harmonic modulation
                period += periodCoef * (periodTarget - period);
                let delay = period * delayScale;
                if (delay > longest) delay = longest;
                else if (delay < 1.00001) delay = 1.00001;

                // Pd's vd~ 4-point interpolation. Read before this sample is written, so x[n - k]
                // sits k - 1 places behind the last write; indices wrap without a modulo.
                const whole = Math.floor(delay);
                const frac = delay - whole;
                let j = write + 2 - whole;
                if (j >= length) j -= length;
                else if (j < 0) j += length;
                const a = buffer[j];
                j = j === 0 ? length - 1 : j - 1;
                const b = buffer[j];
                j = j === 0 ? length - 1 : j - 1;
                const c = buffer[j];
                j = j === 0 ? length - 1 : j - 1;
                const d = buffer[j];
                const cminusb = c - b;
                const delayed = 0.85 * (b + frac * (cminusb - 0.1666667 * (1 - frac) * ((d - a - 3 * cminusb) * frac + (d + 2 * a - 3 * b))));

                // Feedback through lop~ 4000, summed with the oscillator into delwrite~
                feedbackLop += fbCoef * (delayed - feedbackLop);
                write = write + 1 === length ? 0 : write + 1;
                buffer[write] = oscLop * gain + feedbackLop;

                // hip~ 1 -> tanh~ -> lop~ 4000
                const hipNew = delayed + hipCoef * hip;
                const hipOut = hipNormal * (hipNew - hip);
                hip = hipNew;
                outLop += outCoef * (Math.tanh(hipOut) - outLop);

                const sample = outLop * env * level;
                panL += panCoef * (panLTarget - panL);
                panR += panCoef * (panRTarget - panR);
                outL[i] += sample * panL;
                outR[i] += sample * panR;
            }
            v.env = env; v.envStep = envStep; v.phase = phase; v.integrator = integrator; v.oscLop = oscLop;
            v.period = period; v.feedbackLop = feedbackLop; v.write = write; v.hip = hip; v.outLop = outLop;
            v.panL = panL; v.panR = panR;
        }

        // The loopers through the swept resonator; the lead voice joins after it
        const fl = this.filter[0], fr = this.filter[1];
        for (let i = 0; i < frames; i++) {
            const sumL = loopL[i];
            const sumR = loopR[i];
            const yl = k.b0 * sumL + k.b2 * fl.x2 - k.a1 * fl.y1 - k.a2 * fl.y2;
            fl.x2 = fl.x1; fl.x1 = sumL; fl.y2 = fl.y1; fl.y1 = yl;
            const yr = k.b0 * sumR + k.b2 * fr.x2 - k.a1 * fr.y1 - k.a2 * fr.y2;
            fr.x2 = fr.x1; fr.x1 = sumR; fr.y2 = fr.y1; fr.y1 = yr;
            left[i] = yl + leadL[i];
            right[i] = yr + leadR[i];
        }
        return true;
    }
}

registerProcessor('vangex', Vangex);
