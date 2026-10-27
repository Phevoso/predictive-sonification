// Buses, effects and the output stage

import { lerp, makeImpulse } from './util.js';

export const VOICES = ['pads', 'piano', 'bass', 'noise', 'clicks'];

// Each voice is trimmed so a typical note or chord sits at REFERENCE (dBFS RMS) on its own, which
// tools/calibrate.html checks. MIX is the balance between them, in dB.
export const REFERENCE = -24;
const MIX = { pads: -3.5, piano: -3.5, bass: 7, noise: 6, clicks: -13 };
const fromDb = (db) => 10 ** (db / 20);

const FX = {
    reverb: { seconds: 7, damping: 0.55 },
    sends: { pads: 0.55, piano: 0.7, bass: 0.06, noise: 0.8, clicks: 0.2 },
    dry: { piano: 0.4 },
    delay: { time: 0.62, feedback: 0.42, tone: 2200, sends: { piano: 0.35, clicks: 0.3, pads: 0.08 } },
    hall: { seconds: 12, damping: 0.85, predelay: 0.045, send: 1.2 },   // piano only
    wow: { rate: 0.27, drift: 0.07, depth: 0.0018 }
};

// Slower than a bass cycle so it doesn't bend the waveform
const LIMITER = { threshold: -6, knee: 3, ratio: 20, attack: 0.02, release: 0.3 };

// Linear up to the knee, then bends towards the ceiling. The curve covers +/-2 of signal.
function safetyCurve(ceiling = 0.98, knee = 0.8) {
    const curve = new Float32Array(8192);
    const room = ceiling - knee;
    for (let i = 0; i < curve.length; i++) {
        const signal = ((i / (curve.length - 1)) * 2 - 1) * 2;
        const magnitude = Math.abs(signal);
        const shaped = magnitude <= knee ? magnitude : knee + room * Math.tanh((magnitude - knee) / room);
        curve[i] = Math.sign(signal) * shaped;
    }
    return curve;
}

export function buildGraph(ctx) {
    const g = {};

    g.master = new GainNode(ctx, { gain: 0 });
    g.limiter = new DynamicsCompressorNode(ctx, LIMITER);
    g.analyser = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0.8 });
    const clipper = new WaveShaperNode(ctx, { curve: safetyCurve(), oversample: '4x' });
    g.master.connect(g.limiter).connect(new GainNode(ctx, { gain: 0.5 })).connect(clipper).connect(g.analyser).connect(ctx.destination);

    // `mix` fades as one when the source changes; `direct` carries the switch click past it
    g.mix = new GainNode(ctx);
    g.mix.connect(g.master);
    g.direct = new GainNode(ctx);
    g.direct.connect(g.master);

    // tape wobble on pads and piano
    g.wow = new DelayNode(ctx, { maxDelayTime: 0.1, delayTime: 0.018 });
    g.wow.connect(g.mix);
    g.wowDepth = new GainNode(ctx, { gain: FX.wow.depth });
    g.driftDepth = new GainNode(ctx, { gain: FX.wow.depth * 1.5 });
    const wobble = new OscillatorNode(ctx, { frequency: FX.wow.rate });
    const drift = new OscillatorNode(ctx, { frequency: FX.wow.drift, type: 'triangle' });
    wobble.connect(g.wowDepth).connect(g.wow.delayTime);
    drift.connect(g.driftDepth).connect(g.wow.delayTime);
    wobble.start();
    drift.start();

    g.reverbIn = new GainNode(ctx);
    const reverb = new ConvolverNode(ctx, { buffer: makeImpulse(ctx, FX.reverb.seconds, FX.reverb.damping) });
    g.reverbIn.connect(reverb).connect(new GainNode(ctx, { gain: 0.9 })).connect(g.mix);

    g.delayIn = new GainNode(ctx);
    const delay = new DelayNode(ctx, { maxDelayTime: 2, delayTime: FX.delay.time });
    g.delayFeedback = new GainNode(ctx, { gain: FX.delay.feedback });
    const delayTone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: FX.delay.tone });
    g.delayIn.connect(delay).connect(delayTone).connect(g.delayFeedback).connect(delay);
    delayTone.connect(new GainNode(ctx, { gain: 0.55 })).connect(g.mix);
    delayTone.connect(new GainNode(ctx, { gain: 0.25 })).connect(g.reverbIn);

    // fader -> bus; the bus is what the line-up switches and the meters read
    g.faders = {};
    g.buses = {};
    g.analysers = {};
    for (const name of VOICES) {
        const bus = new GainNode(ctx);
        g.faders[name] = new GainNode(ctx, { gain: fromDb(MIX[name]) });
        g.faders[name].connect(bus);
        const analyser = new AnalyserNode(ctx, { fftSize: 512, smoothingTimeConstant: 0.6 });
        const wobbled = name === 'pads' || name === 'piano';
        bus.connect(analyser);
        bus.connect(new GainNode(ctx, { gain: FX.dry[name] ?? 1 })).connect(wobbled ? g.wow : g.mix);
        bus.connect(new GainNode(ctx, { gain: FX.sends[name] })).connect(g.reverbIn);
        if (FX.delay.sends[name]) bus.connect(new GainNode(ctx, { gain: FX.delay.sends[name] })).connect(g.delayIn);
        g.buses[name] = bus;
        g.analysers[name] = analyser;
    }

    g.hallIn = new GainNode(ctx, { gain: FX.hall.send });
    const hall = new ConvolverNode(ctx, { buffer: makeImpulse(ctx, FX.hall.seconds, FX.hall.damping) });
    g.buses.piano.connect(new DelayNode(ctx, { delayTime: FX.hall.predelay })).connect(g.hallIn);
    g.hallIn.connect(hall).connect(g.wow);

    // per-voice inputs
    g.pads = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1800, Q: 0.5 });
    g.pads.connect(g.faders.pads);
    g.piano = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7000, Q: 0.3 });
    g.piano.connect(g.faders.piano);

    return g;
}

export function applyControls(g, { texture, space }, now) {
    g.reverbIn.gain.setTargetAtTime(lerp(0.2, 1.8, space), now, 0.5);
    g.hallIn.gain.setTargetAtTime(FX.hall.send * lerp(0.4, 1.6, space), now, 0.5);
    g.delayIn.gain.setTargetAtTime(lerp(0.2, 1.6, space), now, 0.5);
    g.delayFeedback.gain.setTargetAtTime(lerp(0.25, 0.55, space), now, 0.5);
    g.wowDepth.gain.setTargetAtTime(FX.wow.depth * lerp(0.2, 2, texture), now, 0.5);
    g.driftDepth.gain.setTargetAtTime(FX.wow.depth * 1.5 * lerp(0.2, 2, texture), now, 0.5);
}
