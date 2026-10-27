// Which voices play besides the piano and the weather noise. The pads carry the forecast and stay
// in except on a hollow shape; bass and clicks follow the episode shape. The line-up holds for a
// while, and every few minutes the piano is left on its own.

import { between } from '../util.js';

const ORCHESTRA = {
    lineups: {
        still: ['pads'],
        rising: ['pads', 'bass', 'clicks'],
        falling: ['pads', 'bass', 'clicks'],
        swell: ['pads', 'bass', 'clicks'],
        hollow: [],
        restless: ['pads', 'bass', 'clicks']
    },
    opening: ['pads'],
    departure: 0.9,       // a departure this strong adds the bass
    hold: 24,             // seconds before a line-up can change
    firstChange: 12,
    solo: { every: [150, 300], length: [14, 28] }
};

export const ORCHESTRATED = ['pads', 'bass', 'clicks'];
export const ALWAYS = ['piano', 'noise'];

export class Orchestra {
    constructor(onChange) {
        this.onChange = onChange;
    }

    reset(now, rng) {
        this.rng = rng;
        this.lineup = null;
        this.changedAt = -Infinity;
        this.soloUntil = 0;
        this.nextSolo = now + between(ORCHESTRA.solo.every, rng());
    }

    has(voice) {
        return this.lineup?.has(voice) ?? false;
    }

    update(now, { shape, departure, busy }) {
        if (!this.lineup) {
            this.set(ORCHESTRA.opening, now);
            this.changedAt = now - ORCHESTRA.hold + ORCHESTRA.firstChange;
            return;
        }
        if (this.soloUntil) {
            if (now < this.soloUntil) return;
            this.soloUntil = 0;
            this.nextSolo = now + between(ORCHESTRA.solo.every, this.rng());
            this.changedAt = -Infinity;
        } else if (now >= this.nextSolo && !busy && departure < 0.5) {
            this.set([], now);
            this.soloUntil = now + between(ORCHESTRA.solo.length, this.rng());
            return;
        }

        const voices = new Set(shape ? ORCHESTRA.lineups[shape] : ORCHESTRA.opening);
        if (departure >= ORCHESTRA.departure) voices.add('bass');
        const same = voices.size === this.lineup.size && [...voices].every((voice) => this.lineup.has(voice));
        if (!same && now - this.changedAt >= ORCHESTRA.hold) this.set([...voices], now);
    }

    set(voices, now) {
        this.lineup = new Set(voices);
        this.changedAt = now;
        this.onChange([...this.lineup], now);
    }
}
