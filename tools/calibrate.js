// Renders each voice on its own, offline, and prints how far a typical note or chord sits from
// REFERENCE. After changing a voice, run this and adjust its trim until the offset is near 0.

import { REFERENCE } from '../src/graph.js';
import { Pads, PADS } from '../src/voices/pads.js';
import { Piano } from '../src/voices/piano.js';
import { Bass } from '../src/voices/bass.js';
import { Clicks } from '../src/voices/clicks.js';

const RATE = 48000;
const db = (x) => 20 * Math.log10(x);

// `setup` builds the voice and returns a function that schedules it; the render pauses at
// 0.25 s so worklet messages arrive before the first note at 0.5 s
async function render(seconds, setup) {
    const ctx = new OfflineAudioContext(2, RATE * seconds, RATE);
    const play = await setup(ctx);
    ctx.suspend(0.25).then(async () => {
        play();
        await new Promise((resolve) => setTimeout(resolve, 200));
        ctx.resume();
    });
    const buffer = await ctx.startRendering();
    return [buffer.getChannelData(0), buffer.getChannelData(1)];
}

function measure(channels, from, to) {
    let sum = 0;
    let peak = 0;
    let count = 0;
    for (const data of channels) {
        for (let i = Math.floor(from * RATE); i < Math.floor(to * RATE); i++) {
            sum += data[i] * data[i];
            peak = Math.max(peak, Math.abs(data[i]));
            count++;
        }
    }
    return { rms: db(Math.sqrt(sum / count)), peak: db(peak) };
}

// The pads' and piano's input filters from buildGraph
const padsInput = (ctx) => {
    const filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1800, Q: 0.5 });
    filter.connect(ctx.destination);
    return filter;
};

const pads = (instrument) => async (ctx) => {
    PADS.instrument = instrument;
    const voice = new Pads(ctx, padsInput(ctx));
    voice.rng = () => 0.5;
    await voice.load();
    return () => voice.play([50, 57, 62, 66], 0.5, 10, { attack: 4, release: 8 }, [-0.5, -0.2, 0.2, 0.5], 0.5);
};

// Sustained voices by RMS over their body, the piano over its first seconds, clicks by peak
// against a 12 dB crest
const TESTS = [
    { name: 'pads (vangex)', seconds: 14, setup: pads('vangex'), window: [5, 11], by: 'rms' },
    { name: 'pads (synth)', seconds: 14, setup: pads('synth'), window: [5, 11], by: 'rms' },
    {
        name: 'piano', seconds: 5, window: [0.5, 3], by: 'rms',
        setup: async (ctx) => {
            const filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7000, Q: 0.3 });
            filter.connect(ctx.destination);
            const voice = new Piano(ctx, filter);
            voice.rng = () => 0.5;
            await voice.load();
            return () => voice.play(62, 0.5, 0.55, { length: 1 });
        }
    },
    {
        name: 'bass', seconds: 10, window: [5, 9], by: 'rms',
        setup: async (ctx) => {
            const voice = new Bass(ctx, ctx.destination);
            return () => voice.play(38, 0.5);
        }
    },
    {
        name: 'clicks', seconds: 1, window: [0.45, 0.6], by: 'peak',
        setup: async (ctx) => {
            const voice = new Clicks(ctx, ctx.destination);
            voice.rng = () => 0;
            return () => voice.play(0.5, 0.75, 3000);
        }
    }
];

const rows = [];
for (const test of TESTS) {
    const level = measure(await render(test.seconds, test.setup), ...test.window);
    const target = test.by === 'peak' ? REFERENCE + 12 : REFERENCE;
    rows.push({ voice: test.name, rms: level.rms.toFixed(1), peak: level.peak.toFixed(1), offset: (level[test.by] - target).toFixed(1) });
}
PADS.instrument = 'vangex';
console.table(rows);
document.querySelector('[data-out]').textContent = rows
    .map((row) => `${row.voice.padEnd(14)} rms ${row.rms.padStart(6)}  peak ${row.peak.padStart(6)}  offset ${row.offset.padStart(5)} dB`)
    .join('\n');
window.calibration = rows;
