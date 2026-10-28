// Chords, scales and key. Each chord moves from the last by a third, fourth or step depending on
// where the forecast is heading, is coloured by the data, and is voiced to move the pads as
// little as possible. Each source has its own family of scales; the data picks one, and on Earth
// the weather can bend it. The key starts somewhere random each listen and drifts by fifths with
// the long-term trend of the primary reading.

import { clamp, lerp, noteName } from '../util.js';

export const TONIC = 38; // D2, the reference keys are counted from

export const SCALES = {
    phrygian: { name: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
    aeolian: { name: 'Aeolian', steps: [0, 2, 3, 5, 7, 8, 10] },
    dorian: { name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
    mixolydian: { name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
    ionian: { name: 'Ionian', steps: [0, 2, 4, 5, 7, 9, 11] },
    lydian: { name: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
    harmonicMinor: { name: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
    melodicMinor: { name: 'Melodic minor', steps: [0, 2, 3, 5, 7, 9, 11] },
    phrygianDominant: { name: 'Phrygian dominant', steps: [0, 1, 4, 5, 7, 8, 10] },
    lydianDominant: { name: 'Lydian dominant', steps: [0, 2, 4, 6, 7, 9, 10] },
    hungarianMinor: { name: 'Hungarian minor', steps: [0, 2, 3, 6, 7, 8, 11] },
    lydianAugmented: { name: 'Lydian augmented', steps: [0, 2, 4, 6, 8, 9, 11] },
    majorPentatonic: { name: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
    minorPentatonic: { name: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
    in: { name: 'In', steps: [0, 1, 5, 7, 8] },
    hirajoshi: { name: 'Hirajoshi', steps: [0, 2, 3, 7, 8] },
    kumoi: { name: 'Kumoi', steps: [0, 2, 3, 7, 9] },
    iwato: { name: 'Iwato', steps: [0, 1, 5, 6, 10] },
    wholeTone: { name: 'Whole tone', steps: [0, 2, 4, 6, 8, 10] },
    octatonic: { name: 'Octatonic', steps: [0, 1, 3, 4, 6, 7, 9, 10] }
};

// Each source's scales, darkest (or calmest) to brightest. Some listens on Earth take a more
// colourful neighbour of each mode; the weather can bend the scale for a phrase: still air to a
// pentatonic, mist to whole tone, a strong departure to harmonic minor, a storm to Hungarian minor.
const FAMILIES = {
    weather: {
        ladder: ['phrygian', 'aeolian', 'dorian', 'mixolydian', 'ionian', 'lydian'],
        flavours: { phrygian: 'phrygianDominant', aeolian: 'harmonicMinor', dorian: 'melodicMinor', mixolydian: 'lydianDominant', lydian: 'lydianAugmented' },
        still: ['minorPentatonic', 'majorPentatonic'],
        mist: 'wholeTone',
        departure: 'harmonicMinor',
        storm: 'hungarianMinor'
    },
    mars: { ladder: ['iwato', 'in', 'hirajoshi', 'kumoi', 'lydianDominant'] },
    solar: { ladder: ['lydianAugmented', 'wholeTone', 'octatonic'], tense: 'octatonic' }
};
const FLAVOURED = 0.4;    // share of listens on Earth that take the colourful neighbours

// A move between chords, in steps of a seven-note scale, as the interval it aims for elsewhere
const MOVE_SEMITONES = { 1: 2, 2: 3.5, 3: 5, 4: 7, 5: 8.5, 6: 10.5 };

const HARMONY = {
    // [scale steps, weight]
    moves: {
        rising: [[3, 3], [2, 2], [1, 1]],
        falling: [[4, 3], [5, 2], [6, 1]],
        steady: [[2, 2], [5, 2], [3, 1], [4, 1]]
    },
    homePull: 5,          // chords away from the tonic before going home gets weight
    home: 4,
    // semitones above the root each colour aims for; each lands on the nearest scale tone, so a
    // pentatonic gets open fourths and fifths, whole tone and octatonic their own chords
    colours: {
        fifth: [0, 7],
        triad: [0, 3.5, 7, 12],
        add9: [0, 3.5, 7, 14],
        seventh: [0, 3.5, 7, 10.5],
        sus2: [0, 2, 7, 12]
    },
    reach: 1.5,           // semitones a chord tone may land from its aim
    calmAdd9: 0.6,
    tension: 0.8,         // departure that turns a chord into a seventh
    uncertain: 0.4,       // uncertainty that suspends it
    modeHysteresis: 0.6,
    storms: ['storm', 'gale'],
    tense: 0.6,           // tension from the readings that turns the solar wind octatonic
    strain: 0.7,          // share of chords tension makes suspended or seventh
    bassLift: 10,         // semitones the bass range moves across the pressure range
    spread: { gap: [2, 5], reach: [0, 5] },   // close to wide voicings: smallest gap, extra range
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
        this.rung = null;
        this.scale = null;
        this.flavoured = rng() < FLAVOURED;
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

    get steps() {
        return SCALES[this.scale ?? 'dorian'].steps;
    }

    // notes in the current scale
    get size() {
        return this.steps.length;
    }

    pitch(degree, octave = 0) {
        const { steps, size } = this;
        const wrapped = ((degree % size) + size) % size;
        return this.tonic() + 12 * (octave + Math.floor(degree / size)) + steps[wrapped];
    }

    // How many scale steps above `degree` the tone nearest `semitones` sits, or null if none is
    // close enough; ties go to the lower tone
    reach(degree, semitones) {
        let best = null;
        let distance = Infinity;
        for (let k = 0; k <= 2 * this.size; k++) {
            const away = Math.abs(this.pitch(degree + k) - this.pitch(degree) - semitones);
            if (away < distance) {
                best = k;
                distance = away;
            }
        }
        return distance <= HARMONY.reach ? best : null;
    }

    // the chord's tones as scale steps above its root
    tones(degree, colour) {
        return [...new Set(HARMONY.colours[colour].map((aim) => this.reach(degree, aim)).filter((k) => k !== null))];
    }

    // A move in seven-note scale steps; other scales aim for the same interval
    toward(degree, move) {
        if (this.size === 7) return degree + move;
        return degree + (this.reach(degree, MOVE_SEMITONES[move]) ?? move);
    }

    // skip chords without a perfect fifth (diminished ones in the modes); a scale with none at
    // all, like whole tone, keeps the degree
    stableDegree(degree) {
        const { steps, size } = this;
        for (let k = 0; k < size; k++) {
            const d = (degree + k) % size;
            if (steps.includes((steps[d] + 7) % 12)) return d;
        }
        return degree % size;
    }

    // The source's family picks the scale, the weather may bend it; it changes on phrase starts
    chooseScale({ kind, brightness, shape, departure, uncertainty, mood, tension = 0 }, phraseStart) {
        const family = FAMILIES[kind] ?? FAMILIES.weather;
        const rung = brightness * (family.ladder.length - 1);
        if (this.rung === null) this.rung = Math.round(rung);
        else if (phraseStart && Math.abs(rung - this.rung) > HARMONY.modeHysteresis) this.rung += Math.sign(rung - this.rung);
        this.rung = clamp(this.rung, 0, family.ladder.length - 1);
        if (this.scale !== null && !phraseStart) return;

        let scale = family.ladder[this.rung];
        if (this.flavoured && family.flavours?.[scale]) scale = family.flavours[scale];
        if (family.storm && HARMONY.storms.includes(mood)) scale = family.storm;
        else if (family.departure && departure >= HARMONY.tension) scale = family.departure;
        else if (family.mist && uncertainty >= HARMONY.uncertain) scale = family.mist;
        else if (family.still && shape === 'still') scale = family.still[brightness >= 0.5 ? 1 : 0];
        if (family.tense && tension >= HARMONY.tense) scale = family.tense;
        if (scale === this.scale) return;

        // keep the current chord root as near as the new scale allows
        const root = this.scale === null ? null : this.pitch(this.degree);
        this.scale = scale;
        if (root !== null) {
            let best = 0;
            for (let d = 0; d < this.size; d++) {
                const gap = (p) => Math.abs(((p - root) % 12 + 18) % 12 - 6);
                if (gap(this.pitch(d)) < gap(this.pitch(best))) best = d;
            }
            this.degree = best;
        }
    }

    // Long-term trend of the primary reading, which the key follows
    follow(x, tau) {
        if (x === null || x === undefined) return;
        this.trend = this.trend === null ? x : this.trend + (x - this.trend) / tau;
    }

    next({ time, brightness, expected, floor, departure, uncertainty, range, kind, shape, mood, low = 0.5, spread = null, tension = 0 }) {
        const phraseStart = this.chordCount % 2 === 0;
        this.chooseScale({ kind, brightness, shape, departure, uncertainty, mood, tension }, phraseStart);
        this.bassShift = Math.round((0.5 - low) * HARMONY.bassLift);
        this.spread = spread;
        this.tension = tension;

        const slope = expected !== null && this.lastExpected !== null ? expected - this.lastExpected : 0;
        this.lastExpected = expected;

        // On a key change the previous tonic chord is reinterpreted as IV (up a fifth) or V (down)
        const step = phraseStart && this.chordCount > 0 ? this.modulate(time, range, departure) : 0;
        if (step) {
            this.degree = this.stableDegree(this.toward(0, step > 0 ? 3 : 4) % this.size);
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
            mode: SCALES[this.scale].name,
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
        if (this.chordsAway >= HARMONY.homePull) moves.push(['home', HARMONY.home]);
        let r = this.rng() * moves.reduce((sum, [, weight]) => sum + weight, 0);
        let step = moves[moves.length - 1][0];
        for (const [move, weight] of moves) {
            if ((r -= weight) < 0) {
                step = move;
                break;
            }
        }
        if (step === 'home') return 0;
        return this.stableDegree(this.toward(this.degree, step) % this.size);
    }

    colour(departure, uncertainty) {
        let wish = this.rng() < HARMONY.calmAdd9 ? 'add9' : 'triad';
        if (this.tension > 0 && this.rng() < this.tension * HARMONY.strain) wish = this.rng() < 0.5 ? 'seventh' : 'sus2';
        if (uncertainty >= HARMONY.uncertain) wish = 'sus2';
        if (departure >= HARMONY.tension) wish = 'seventh';
        return [wish, 'add9', 'triad', 'sus2'].find((colour) => this.consonant(this.degree, colour)) ?? 'fifth';
    }

    // no semitones or major sevenths between chord tones in this mode
    consonant(degree, colour) {
        const classes = this.tones(degree, colour).map((step) => this.pitch(degree + step) % 12);
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
        const wide = this.spread ?? null;
        const extra = wide === null ? 0 : Math.round(lerp(...HARMONY.spread.reach, wide));
        const minGap = wide === null ? HARMONY.minGap : Math.round(lerp(...HARMONY.spread.gap, wide));
        const [lo, hi] = [HARMONY.range[0] - extra, HARMONY.range[1] + extra];
        const centre = (lo + hi) / 2;
        const options = this.tones(degree, colour).map((step) => {
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
                for (let k = 1; k < notes.length; k++) if (notes[k] - notes[k - 1] < minGap) return;
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
        return best ?? this.tones(degree, 'triad').map((step) => this.pitch(degree + step, 1));
    }

    // root in whichever octave is nearest the last bass note
    bassRoot(degree) {
        const pc = this.pitch(degree) % 12;
        let best = null;
        const shift = this.bassShift ?? 0;
        for (let midi = HARMONY.bassRange[0] + shift; midi <= HARMONY.bassRange[1] + shift; midi++) {
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
