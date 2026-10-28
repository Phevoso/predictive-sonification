// The piano's part. Each new episode plays a phrase from a Markov walk over the scale, leaning
// the way the data's shape goes; a returning episode opens the way it did before, then wanders
// off. In quiet stretches shorter answering phrases come now and then; strong departures get
// single notes above or below the pads.

import { between, clamp, hash, lerp, mulberry32 } from '../util.js';

export const DEPARTING = 0.8;

const MELODY = {
    pan: 0.45,
    registers: { above: 2, below: 1 },
    noteThreshold: 0.9,   // departure needed for a single note
    outside: 0.97,        // above this the last note may step outside the scale
    gap: [16, 6],         // seconds between departure notes
    motifGap: 3,
    recall: [8, 14],
    bpm: [58, 68],
    touch: [0.35, 0.75],
    double: 0.45,         // second return doubles the motif an octave up
    under: 0.4,           // later returns add an octave below
    departureFelt: 500,   // Hz
    span: [45, 93]        // midi; a phrase that would leave it moves by an octave (the samples end at A6)
};

// The walk: weights for the next step in scale steps (-4..4), given whether the last move was a
// step or a leap. A leap is usually answered by a step back the other way.
const MARKOV = {
    steps: [-4, -3, -2, -1, 0, 1, 2, 3, 4],
    after: {
        step: [0.3, 0.6, 1.4, 3, 0.8, 3, 1.4, 0.6, 0.3],
        leapUp: [0.3, 0.6, 1.8, 3.5, 0.6, 1, 0.5, 0.2, 0.1],
        leapDown: [0.1, 0.2, 0.5, 1, 0.6, 3.5, 1.8, 0.6, 0.3]
    },
    // beats, and the weights of the next length after each
    beats: [0.5, 1, 1.5, 2],
    rhythm: { 0.5: [2, 2, 0.6, 0.3], 1: [1, 2.5, 1, 0.8], 1.5: [1.5, 1, 0.3, 0.6], 2: [0.6, 2, 0.6, 0.6] },
    // how each shape leans the walk: up or down, appetite for leaps, pace, phrase length
    lean: {
        still: { bias: 0, leaps: 0.6, pace: 0.7, notes: [3, 5] },
        rising: { bias: 1, leaps: 1, pace: 1, notes: [4, 6] },
        falling: { bias: -1, leaps: 1, pace: 1, notes: [4, 6] },
        swell: { bias: 1, leaps: 1.2, pace: 1.1, notes: [5, 7], turn: true },   // up, then down
        hollow: { bias: 0, leaps: 0.8, pace: 0.6, notes: [2, 4] },
        restless: { bias: 0, leaps: 2.2, pace: 1.6, notes: [5, 8] }
    },
    reach: 7,             // scale steps the walk may stray from where it began
    opening: 3,           // notes a returning episode repeats before it wanders
    held: [2, 3]          // beats on the last note
};

const pick = (weights, rng) => {
    let total = 0;
    for (const w of weights) total += w;
    let r = rng() * total;
    for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r < 0) return i;
    }
    return weights.length - 1;
};

// A phrase as scale degrees and beats. `rngAt(i)` gives the random source for note i, so a
// returning episode can replay its opening and then go its own way.
function compose(shape, start, intensity, rngAt) {
    const lean = MARKOV.lean[shape] ?? MARKOV.lean.still;
    const count = Math.round(between(lean.notes, rngAt(0)()) + intensity * 1.5);
    const pace = lean.pace * lerp(0.85, 1.25, intensity);
    const degrees = [start];
    const beats = [];
    let last = 0;
    let length = 1;
    for (let i = 1; i < count; i++) {
        const rng = rngAt(i);
        const bias = lean.turn && i > count / 2 ? -lean.bias : lean.bias;
        const base = last >= 2 ? MARKOV.after.leapUp : last <= -2 ? MARKOV.after.leapDown : MARKOV.after.step;
        const weights = MARKOV.steps.map((step, k) => {
            const size = Math.abs(step);
            const away = Math.abs(degrees[i - 1] + step - start);
            if (away > MARKOV.reach) return 0;
            let w = base[k] * Math.exp(bias * Math.sign(step));
            if (size >= 3) w *= lean.leaps;
            else if (size === 2) w *= Math.sqrt(lean.leaps);
            return w;
        });
        last = MARKOV.steps[pick(weights, rng)];
        degrees.push(degrees[i - 1] + last);

        const next = MARKOV.rhythm[length].map((w, k) => w * (MARKOV.beats[k] < 1 ? pace : MARKOV.beats[k] > 1 ? 1 / pace : 1));
        beats.push(length);
        length = MARKOV.beats[pick(next, rng)];
    }
    beats.push(between(MARKOV.held, rngAt(count)()));
    return { degrees, beats };
}

export class Melody {
    constructor(harmony, piano, emit) {
        this.harmony = harmony;
        this.piano = piano;
        this.emit = emit;
    }

    reset(now, rng, opening) {
        this.rng = rng;
        this.pending = opening ? { ...opening, d: 0, sign: 0, recall: true } : null;
        this.lastMotif = null;
        this.recallWait = 0;
        this.nextMotif = now + 4;
        this.lastDepartureNote = -Infinity;
    }

    queue(episode, d, sign) {
        this.pending = { ...episode, d, sign };
    }

    tick(now, { departure, density, current, intensity = 0.5 }) {
        if (!this.piano.ready) return;
        this.intensity = intensity;
        const recall = this.lastMotif ?? current;
        if (!this.pending && recall && now >= this.nextMotif + this.recallWait) {
            this.pending = { ...recall, d: departure.level, sign: departure.sign, recall: true };
        }
        if (this.pending && now >= this.nextMotif) {
            const end = this.motif(this.pending, now + 0.15);
            this.lastMotif = this.pending;
            this.recallWait = between(MELODY.recall, this.rng());
            this.pending = null;
            this.nextMotif = end + MELODY.motifGap * lerp(1.4, 0.6, density);
        }

        const level = departure.level;
        if (level > MELODY.noteThreshold && !this.pending) {
            const strength = (level - MELODY.noteThreshold) / (1 - MELODY.noteThreshold);
            const gap = between(MELODY.gap, strength) * lerp(1.5, 0.65, density);
            if (now - this.lastDepartureNote > gap) {
                this.departureNote(now + 0.1, departure);
                this.lastDepartureNote = now;
            }
        }
    }

    // A new phrase for the episode. Returns open as the episode first did, doubled an octave up
    // the second time and over a soft octave below after that; recalls in quiet stretches are
    // shorter phrases of their own.
    motif(episode, time) {
        const { count, offset, sign, shape } = episode;
        const d = episode.d ?? 0;
        const seeded = episode.recall ? null : mulberry32(hash(`${episode.id}:${shape}`));
        const rngAt = (i) => (seeded && i < MARKOV.opening ? seeded : this.rng);
        let { degrees, beats: rhythm } = compose(shape, this.harmony.degree + offset, this.intensity ?? 0.5, rngAt);
        if (episode.recall && degrees.length > 3) {
            degrees = degrees.slice(0, -1);
            rhythm = [...rhythm.slice(0, -2), rhythm[rhythm.length - 1]];
        }
        // settle on the nearest tone of the chord
        const end = degrees.length - 1;
        const chord = new Set(this.harmony.tones(this.harmony.degree, 'triad').map((k) => this.harmony.pitch(this.harmony.degree + k) % 12));
        const settle = [0, -1, 1, -2, 2].find((move) => chord.has(this.harmony.pitch(degrees[end] + move) % 12));
        degrees[end] += settle ?? 0;
        const departing = d > DEPARTING;
        const register = departing && sign < 0 ? MELODY.registers.below : MELODY.registers.above;
        const beat = 60 / between(MELODY.bpm, d);
        const pan = lerp(-MELODY.pan, MELODY.pan, this.rng());
        const touch = between(MELODY.touch, d);

        const pitches = degrees.map((degree) => this.harmony.pitch(degree, register));
        const shift = Math.max(...pitches) > MELODY.span[1] ? -12 : Math.min(...pitches) < MELODY.span[0] ? 12 : 0;
        let t = time;
        degrees.forEach((degree, i) => {
            const last = i === degrees.length - 1;
            let midi = pitches[i] + shift;
            if (last && d > MELODY.outside) midi += sign < 0 ? -1 : 1;
            const velocity = clamp(touch * (last ? 0.85 : 1) * lerp(0.9, 1.1, this.rng()));
            const length = rhythm[i] * beat;
            const at = t + (i ? (this.rng() - 0.5) * 0.024 : 0);
            const options = { brightness: 0.25 + 0.6 * d, length, pan, departure: departing, count };
            this.note(midi, at, velocity, options);
            if (count === 2) this.note(midi + 12, at + 0.012, velocity * MELODY.double, { ...options, layer: true });
            if (count >= 3) this.note(midi - 12, at + 0.02, velocity * MELODY.under, { ...options, layer: true });
            t += length;
        });
        this.emit('motif', { ...episode }, time);
        return t;
    }

    departureNote(time, { level, sign }) {
        const register = sign < 0 ? MELODY.registers.below : MELODY.registers.above;
        const tones = this.harmony.tones(this.harmony.degree, 'triad');
        const step = tones[Math.floor(this.rng() * Math.min(3, tones.length))];
        let midi = this.harmony.pitch(this.harmony.degree + step, register);
        if (level > MELODY.outside) midi += sign < 0 ? -1 : 1;
        this.note(midi, time, lerp(0.45, 0.85, (level - DEPARTING) / (1 - DEPARTING)), {
            brightness: level,
            length: 1.5,
            pan: lerp(-MELODY.pan, MELODY.pan, this.rng()),
            departure: true,
            cutoff: MELODY.departureFelt
        });
    }

    // octave layers sound but aren't reported as separate notes
    note(midi, time, velocity, { layer = false, departure = false, count = 0, ...options }) {
        const ring = this.piano.play(midi, time, velocity, options);
        if (!layer) this.emit('note', { instrument: 'piano', midi, velocity, pan: options.pan, decay: ring, departure, count }, time);
    }
}
