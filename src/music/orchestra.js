// How full the arrangement is, and which voices play besides the piano and the weather noise.
// The data's shape steers an intensity between 0 and 1: rising builds towards a crescendo,
// falling thins out towards something minimal, a swell rises and falls back, a hollow empties.
// Voices enter and leave as the intensity crosses their thresholds, and every few minutes the
// piano is left on its own.

import { between, clamp, lerp } from '../util.js';

const ORCHESTRA = {
    // where each shape leads the intensity, over how many seconds; a swell peaks, then falls back
    shapes: {
        still: { to: 0.45, over: 20 },
        rising: { to: 1, over: 40 },
        falling: { to: 0.12, over: 40 },
        swell: { to: 1, over: 18, then: 0.35 },
        hollow: { to: 0, over: 15 },
        restless: { to: 0.75, over: 15 }
    },
    opening: 0.3,
    thresholds: { pads: 0.08, bass: 0.5 },   // intensity each voice enters at
    hysteresis: 0.06,
    hold: 8,              // seconds before a voice can enter or leave again
    departure: 0.9,       // a departure this strong adds the bass
    solo: { every: [150, 300], length: [14, 28] }
};

export const ORCHESTRATED = ['pads', 'bass'];
export const ALWAYS = ['piano', 'noise'];

const smooth = (x) => x * x * (3 - 2 * x);

export class Orchestra {
    constructor(onChange) {
        this.onChange = onChange;
    }

    reset(now, rng) {
        this.rng = rng;
        this.intensity = ORCHESTRA.opening;
        this.arc = null;
        this.lineup = null;
        this.changedAt = Object.fromEntries(ORCHESTRATED.map((voice) => [voice, -Infinity]));
        this.soloUntil = 0;
        this.nextSolo = now + between(ORCHESTRA.solo.every, rng());
    }

    has(voice) {
        return this.lineup?.has(voice) ?? false;
    }

    // Each new shape starts an arc from wherever the intensity is now
    follow(now, shape) {
        if (!shape) return;
        if (this.arc?.shape !== shape) this.arc = { shape, start: now, from: this.intensity };
        const { to, over, then } = ORCHESTRA.shapes[shape];
        const age = (now - this.arc.start) / over;
        this.intensity = age < 1 || then === undefined
            ? lerp(this.arc.from, to, smooth(clamp(age)))
            : lerp(to, then, smooth(clamp(age - 1)));
    }

    update(now, { shape, departure, busy }) {
        this.follow(now, shape);
        if (!this.lineup) {
            this.set(['pads'], now);
            return;
        }
        if (this.soloUntil) {
            if (now < this.soloUntil) return;
            this.soloUntil = 0;
            this.nextSolo = now + between(ORCHESTRA.solo.every, this.rng());
        } else if (now >= this.nextSolo && !busy && departure < 0.5) {
            this.set([], now);
            this.soloUntil = now + between(ORCHESTRA.solo.length, this.rng());
            return;
        }

        const voices = new Set(this.lineup);
        for (const voice of ORCHESTRATED) {
            if (now - this.changedAt[voice] < ORCHESTRA.hold) continue;
            const threshold = ORCHESTRA.thresholds[voice];
            const forced = voice === 'bass' && departure >= ORCHESTRA.departure;
            if (forced || this.intensity > threshold + ORCHESTRA.hysteresis) voices.add(voice);
            else if (this.intensity < threshold - ORCHESTRA.hysteresis) voices.delete(voice);
        }
        const same = voices.size === this.lineup.size && [...voices].every((voice) => this.lineup.has(voice));
        if (!same) this.set([...voices], now);
    }

    set(voices, now) {
        for (const voice of ORCHESTRATED) {
            if (voices.includes(voice) !== (this.lineup?.has(voice) ?? false)) this.changedAt[voice] = now;
        }
        this.lineup = new Set(voices);
        this.onChange([...this.lineup], now);
    }
}
