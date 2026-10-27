// Chords, modes and key. Each chord moves from the last by a third, fourth or step depending on
// where the forecast is heading, is coloured by the data, and is voiced to move the pads as
// little as possible. The key starts somewhere random each listen and drifts by fifths with
// the long-term trend of the primary reading.

import { clamp, noteName } from '../util.js';

export const TONIC = 38; // D2, the reference keys are counted from

// darkest to brightest
export const MODES = [
    { name: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
    { name: 'Aeolian', steps: [0, 2, 3, 5, 7, 8, 10] },
    { name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
    { name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
    { name: 'Ionian', steps: [0, 2, 4, 5, 7, 9, 11] },
    { name: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] }
];

const HARMONY = {
    // [scale steps, weight]
    moves: {
        rising: [[3, 3], [2, 2], [1, 1]],
        falling: [[4, 3], [5, 2], [6, 1]],
        steady: [[2, 2], [5, 2], [3, 1], [4, 1]]
    },
    homePull: 5,          // chords away from the tonic before going home gets weight
    home: 4,
    colours: {
        fifth: [0, 4],
        triad: [0, 2, 4, 7],
        add9: [0, 2, 4, 8],
        seventh: [0, 2, 4, 6],
        sus2: [0, 1, 4, 7]
    },
    calmAdd9: 0.6,
    tension: 0.8,         // departure that turns a chord into a seventh
    uncertain: 0.4,       // uncertainty that suspends it
    modeHysteresis: 0.6,
    range: [TONIC + 10, TONIC + 31],
    minGap: 2,
    bassRange: [TONIC - 3, TONIC + 9]
};

const KEY = {
    reach: 2,             // fifths either side of the home key
    tau: { weather: 24, mars: 60, solar: 120 },
    hysteresis: 0.6,
    minGap: 90,           // seconds
    calm: 0.5             // no key change during a departure above this
};

// On Earth and Mars the actual temperature counts for more than the place's own range,
// so cold places lean minor and warm ones major
const CLIMATE = { weight: 0.6, celsius: [-5, 30], kinds: ['weather', 'mars'] };

const SUFFIX = { fifth: '5', triad: '', add9: 'add9', seventh: '7', sus2: 'sus2' };

// fifths -> semitones, kept within a tritone so registers don't jump
function keyShift(fifths) {
    const semitones = (((fifths * 7) % 12) + 12) % 12;
    return semitones > 6 ? semitones - 12 : semitones;
}

// 0 = darkest mode, 1 = brightest
export function brightness(kind, value, relative) {
    if (!CLIMATE.kinds.includes(kind) || value === null || value === undefined) return relative;
    const [cold, warm] = CLIMATE.celsius;
    return CLIMATE.weight * clamp((value - cold) / (warm - cold)) + (1 - CLIMATE.weight) * relative;
}

export const keyMemory = (kind) => KEY.tau[kind] ?? 24;

export class Harmony {
    reset(now, rng) {
        this.rng = rng;
        this.modeIndex = null;
        this.degree = 0;
        this.chordCount = 0;
        this.chordsAway = 0;
        this.padNotes = null;
        this.bassMidi = TONIC;
        this.lastExpected = null;
        this.chord = null;
        this.homeKey = Math.floor(Math.random() * 12) - 5;
        this.keyOffset = 0;
        this.trend = null;
        this.lastModulation = now;
    }

    tonic() {
        return TONIC + keyShift(this.homeKey + this.keyOffset);
    }

    pitch(degree, octave = 0) {
        const { steps } = MODES[this.modeIndex ?? 2];
        const wrapped = ((degree % 7) + 7) % 7;
        return this.tonic() + 12 * (octave + Math.floor(degree / 7)) + steps[wrapped];
    }

    // skip diminished chords
    stableDegree(degree) {
        const { steps } = MODES[this.modeIndex ?? 2];
        for (let k = 0; k < 7; k++) {
            const d = (degree + k) % 7;
            const fifth = steps[(d + 4) % 7] + (d + 4 >= 7 ? 12 : 0) - steps[d];
            if (fifth === 7) return d;
        }
        return 0;
    }

    // Long-term trend of the primary reading, which the key follows
    follow(x, tau) {
        if (x === null || x === undefined) return;
        this.trend = this.trend === null ? x : this.trend + (x - this.trend) / tau;
    }

    next({ time, brightness, expected, floor, departure, uncertainty, range }) {
        const phraseStart = this.chordCount % 2 === 0;
        const rung = brightness * (MODES.length - 1);
        if (this.modeIndex === null) this.modeIndex = Math.round(rung);
        else if (phraseStart && Math.abs(rung - this.modeIndex) > HARMONY.modeHysteresis) this.modeIndex += Math.sign(rung - this.modeIndex);

        const slope = expected !== null && this.lastExpected !== null ? expected - this.lastExpected : 0;
        this.lastExpected = expected;

        // On a key change the previous tonic chord is reinterpreted as IV (up a fifth) or V (down)
        const step = phraseStart && this.chordCount > 0 ? this.modulate(time, range, departure) : 0;
        if (step) {
            this.degree = this.stableDegree(step > 0 ? 3 : 4);
            this.chordsAway = HARMONY.homePull - 1;
        } else {
            this.degree = this.chordCount === 0 ? 0 : this.nextDegree(slope, floor);
            this.chordsAway = this.degree === 0 ? 0 : this.chordsAway + 1;
        }

        const colour = this.chordCount < 2 ? 'fifth' : this.colour(departure, uncertainty);
        const notes = this.voice(this.degree, colour);
        this.padNotes = notes;
        this.chordCount += 1;
        this.chord = {
            root: this.bassRoot(this.degree),
            notes,
            colour,
            tonic: this.tonic(),
            mode: MODES[this.modeIndex].name,
            degree: this.degree,
            phraseStart,
            keyChange: step,
            time
        };
        return this.chord;
    }

    modulate(time, [lo, hi], departure) {
        if (this.trend === null || time - this.lastModulation < KEY.minGap || departure > KEY.calm) return 0;
        const target = (clamp((this.trend - lo) / (hi - lo)) * 2 - 1) * KEY.reach;
        if (Math.abs(target - this.keyOffset) <= KEY.hysteresis) return 0;
        const step = Math.sign(target - this.keyOffset);
        this.keyOffset = clamp(this.keyOffset + step, -KEY.reach, KEY.reach);
        this.lastModulation = time;
        return step;
    }

    nextDegree(slope, floor) {
        const trend = slope > floor * 0.5 ? 'rising' : slope < -floor * 0.5 ? 'falling' : 'steady';
        const moves = HARMONY.moves[trend].slice();
        if (this.chordsAway >= HARMONY.homePull) moves.push([(7 - this.degree) % 7, HARMONY.home]);
        let r = this.rng() * moves.reduce((sum, [, weight]) => sum + weight, 0);
        let step = moves[moves.length - 1][0];
        for (const [move, weight] of moves) {
            if ((r -= weight) < 0) {
                step = move;
                break;
            }
        }
        return this.stableDegree((this.degree + step) % 7);
    }

    colour(departure, uncertainty) {
        let wish = this.rng() < HARMONY.calmAdd9 ? 'add9' : 'triad';
        if (uncertainty >= HARMONY.uncertain) wish = 'sus2';
        if (departure >= HARMONY.tension) wish = 'seventh';
        return [wish, 'add9', 'triad'].find((colour) => this.consonant(this.degree, colour));
    }

    // no semitones or major sevenths between chord tones in this mode
    consonant(degree, colour) {
        const classes = HARMONY.colours[colour].map((step) => this.pitch(degree + step) % 12);
        for (let a = 0; a < classes.length; a++) {
            for (let b = a + 1; b < classes.length; b++) {
                const interval = (classes[b] - classes[a] + 12) % 12;
                if (interval === 1 || interval === 11) return false;
            }
        }
        return true;
    }

    // Try every placement of the chord tones in the pad range; keep the one closest to the
    // previous chord, with no crowded voices and no minor seconds or ninths
    voice(degree, colour) {
        const [lo, hi] = HARMONY.range;
        const centre = (lo + hi) / 2;
        const options = HARMONY.colours[colour].map((step) => {
            const pc = this.pitch(degree + step) % 12;
            const placements = [];
            for (let midi = lo; midi <= hi; midi++) if (midi % 12 === pc) placements.push(midi);
            return placements;
        });
        const previous = this.padNotes;
        const nearest = (note, set) => Math.min(...set.map((other) => Math.abs(other - note)));
        let best = null;
        let bestCost = Infinity;
        const visit = (i, chosen) => {
            if (i === options.length) {
                const notes = [...chosen].sort((a, b) => a - b);
                for (let k = 1; k < notes.length; k++) if (notes[k] - notes[k - 1] < HARMONY.minGap) return;
                for (let a = 0; a < notes.length; a++) {
                    for (let b = a + 1; b < notes.length; b++) if ([1, 13].includes(notes[b] - notes[a])) return;
                }
                const mean = notes.reduce((sum, n) => sum + n, 0) / notes.length;
                const movement = previous
                    ? notes.reduce((sum, n) => sum + nearest(n, previous), 0) + previous.reduce((sum, p) => sum + nearest(p, notes), 0)
                    : 0;
                const cost = movement + 0.15 * Math.abs(mean - centre) + 0.3 * this.rng();
                if (cost < bestCost) {
                    best = notes;
                    bestCost = cost;
                }
                return;
            }
            for (const midi of options[i]) visit(i + 1, [...chosen, midi]);
        };
        visit(0, []);
        return best ?? HARMONY.colours.triad.map((step) => this.pitch(degree + step, 1));
    }

    // root in whichever octave is nearest the last bass note
    bassRoot(degree) {
        const pc = this.pitch(degree) % 12;
        let best = null;
        for (let midi = HARMONY.bassRange[0]; midi <= HARMONY.bassRange[1]; midi++) {
            if (midi % 12 === pc && (best === null || Math.abs(midi - this.bassMidi) < Math.abs(best - this.bassMidi))) best = midi;
        }
        this.bassMidi = best ?? this.pitch(degree);
        return this.bassMidi;
    }

    name(chord = this.chord) {
        if (!chord) return '—';
        const plain = (midi) => noteName(midi, { octave: false });
        return `${plain(chord.root)}${SUFFIX[chord.colour] ?? ''} · ${plain(chord.tonic)} ${chord.mode}`;
    }
}
