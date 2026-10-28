// What a source's other readings do to the sound. Each channel is read against its own range at
// that place, 0 to 1, and the sound glides after it over a few seconds. A strong surprise in a
// channel against its forecast gets a short moment of its own.

import { clamp } from '../util.js';

// space: reverb and delay; low: bass register and weight; tension: suspended and seventh chords
// (and octatonic for the solar wind); movement: tape wobble and stereo spread; muffle and bright:
// how dark or open the pads and piano are; spread: how wide the pad chords are voiced; busy: how
// often the piano plays
export const MAPPINGS = {
    weather: {
        space: 'humidity',
        low: 'pressure',
        tension: { falling: 'pressure' },   // a falling barometer comes before bad weather
        movement: 'wind',
        muffle: 'cloud',
        moments: { pressure: 'swell', humidity: 'bloom', wind: 'gust', cloud: 'shade' }
    },
    mars: {
        low: 'pressure',
        spread: { between: ['maxTemp', 'minTemp'] },   // the swing between day and night
        busy: 'daylight',
        moments: { pressure: 'swell', minTemp: 'bloom' }
    },
    solar: {
        space: 'density',
        bright: 'temperature',
        tension: { south: 'bz' },           // a southward field couples to Earth's
        movement: 'bt',
        moments: { density: 'bloom', bz: 'shade', bt: 'gust' }
    }
};

const NEUTRAL = { space: 0.5, low: 0.5, tension: 0, movement: 0.5, muffle: 0.5, bright: 0.5, spread: null, busy: 0.5 };
const GLIDE = 4;                                     // seconds
const FALL = { fast: 3, slow: 24, steep: 0.15 };     // readings averaged; share of the range that is a steep fall
const MOMENT = { surprise: 3, gap: 20 };             // forecast errors in sigmas; seconds between a channel's moments
// what each moment adds, and how fast it fades (seconds)
const BOOSTS = { bloom: ['space', 0.45, 5], gust: ['movement', 0.6, 4], shade: ['muffle', 0.35, 6] };
const FADE = { space: 5, movement: 4, muffle: 6, tension: 15 };

function span(values) {
    const sorted = values.filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
    if (!sorted.length) return [0, 1];
    const lo = sorted[Math.floor(sorted.length * 0.05)];
    const hi = sorted[Math.floor(sorted.length * 0.95)];
    return hi > lo ? [lo, hi] : [lo - 1, hi + 1];
}

export class Readings {
    constructor(source) {
        this.map = MAPPINGS[source.kind] ?? {};
        this.ranges = {};
        for (const { key } of source.channels) this.ranges[key] = span(source.samples.map((s) => s.values[key]));
        const pair = this.map.spread?.between;
        if (pair) {
            this.ranges.between = span(source.samples.map(({ values }) => (
                values[pair[0]] == null || values[pair[1]] == null ? null : values[pair[0]] - values[pair[1]])));
        }
        this.targets = { ...NEUTRAL };
        this.values = { ...NEUTRAL };
        this.boosts = { space: 0, movement: 0, muffle: 0, tension: 0 };
        this.averages = {};
        this.lastMoment = {};
        this.seeded = false;
    }

    level(key, value) {
        const [lo, hi] = this.ranges[key];
        return clamp((value - lo) / (hi - lo));
    }

    // Takes in an observation and returns the moments it sets off
    observe(obs, now) {
        if (!obs) return [];
        const read = (key) => {
            const entry = obs.channels[key];
            const value = entry ? entry.x ?? entry.mu : null;
            return Number.isFinite(value) ? value : null;
        };
        for (const [feature, how] of Object.entries(this.map)) {
            if (feature === 'moments') continue;
            if (typeof how === 'string') {
                const value = read(how);
                if (value !== null) this.targets[feature] = this.level(how, value);
            } else if (how.falling) {
                const value = read(how.falling);
                if (value === null) continue;
                const avg = this.averages[how.falling] ??= { fast: value, slow: value };
                avg.fast += (value - avg.fast) / FALL.fast;
                avg.slow += (value - avg.slow) / FALL.slow;
                const [lo, hi] = this.ranges[how.falling];
                this.targets[feature] = clamp((avg.slow - avg.fast) / (FALL.steep * (hi - lo)));
            } else if (how.south) {
                const value = read(how.south);
                const [lo] = this.ranges[how.south];
                if (value !== null) this.targets[feature] = value < 0 && lo < 0 ? clamp(value / lo) : 0;
            } else if (how.between) {
                const [a, b] = how.between.map(read);
                if (a !== null && b !== null) this.targets[feature] = this.level('between', a - b);
            }
        }
        if (!this.seeded) {
            this.values = { ...this.targets };
            this.seeded = true;
            return [];
        }

        const moments = [];
        for (const [key, moment] of Object.entries(this.map.moments ?? {})) {
            const r = obs.channels[key]?.r;
            if (r === null || r === undefined || Math.abs(r) < MOMENT.surprise) continue;
            if (now - (this.lastMoment[key] ?? -Infinity) < MOMENT.gap) continue;
            this.lastMoment[key] = now;
            moments.push(moment);
            const boost = BOOSTS[moment];
            if (boost) this.boosts[boost[0]] = Math.max(this.boosts[boost[0]], boost[1]);
            if (moment === 'shade') this.boosts.tension = 1;
        }
        return moments;
    }

    tick(dt) {
        const k = 1 - Math.exp(-dt / GLIDE);
        for (const feature of Object.keys(this.targets)) {
            const target = this.targets[feature];
            if (target === null) continue;
            this.values[feature] = this.values[feature] === null ? target : this.values[feature] + k * (target - this.values[feature]);
        }
        for (const name of Object.keys(this.boosts)) this.boosts[name] *= Math.exp(-dt / FADE[name]);
    }

    get(feature) {
        const value = this.values[feature];
        return value === null ? null : clamp(value + (this.boosts[feature] ?? 0));
    }
}
