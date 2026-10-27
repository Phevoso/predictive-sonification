// The piano's part. Each new episode plays its motif; in quiet stretches the last motif comes
// back now and then; strong departures get single notes above or below the pads.

import { between, clamp, lerp } from '../util.js';

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
    departureFelt: 500    // Hz
};

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

    tick(now, { departure, density, current }) {
        if (!this.piano.ready) return;
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

    // Returns repeat the motif with bounded changes: doubled the second time, then inverted or
    // stretched over a soft octave below
    motif(episode, time) {
        const { motif, count, offset, sign } = episode;
        const d = episode.d ?? 0;
        let intervals = motif.intervals;
        let rhythm = motif.rhythm;
        if (count >= 3) {
            if (count % 2) intervals = intervals.map((step) => -step);
            else rhythm = rhythm.map((beats) => beats * 1.5);
        }
        const departing = d > DEPARTING;
        const register = departing && sign < 0 ? MELODY.registers.below : MELODY.registers.above;
        const beat = 60 / between(MELODY.bpm, d);
        const pan = lerp(-MELODY.pan, MELODY.pan, this.rng());
        const touch = between(MELODY.touch, d);

        const degrees = [this.harmony.degree + offset];
        for (const step of intervals) degrees.push(degrees[degrees.length - 1] + step);
        let t = time;
        degrees.forEach((degree, i) => {
            const last = i === degrees.length - 1;
            let midi = this.harmony.pitch(degree, register);
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
        const step = [0, 2, 4][Math.floor(this.rng() * 3)];
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
