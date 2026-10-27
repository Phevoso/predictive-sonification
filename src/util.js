export const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const between = ([lo, hi], t) => lerp(lo, hi, t);
export const mtof = (midi) => 440 * 2 ** ((midi - 69) / 12);

export function mulberry32(seed) {
    return () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// FNV-1a
export function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

export function noteName(midi, { octave = true } = {}) {
    const nearest = Math.round(midi);
    const name = NOTE_NAMES[((nearest % 12) + 12) % 12];
    return octave ? name + (Math.floor(nearest / 12) - 1) : name;
}

// Decaying noise whose highs die faster than its lows
export function makeImpulse(ctx, seconds, damping) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
        const data = buffer.getChannelData(ch);
        let low = 0;
        for (let i = 0; i < length; i++) {
            const t = i / length;
            low += (1 - damping * 0.95 * Math.sqrt(t)) * (Math.random() * 2 - 1 - low);
            data[i] = low * Math.exp(-6.9 * t);
        }
    }
    return buffer;
}

export function makeNoiseBuffer(ctx, seconds) {
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
}

export function rms(analyser, buffer) {
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    return Math.sqrt(sum / buffer.length);
}
