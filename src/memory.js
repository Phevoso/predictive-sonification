// Forecasts each reading of a source before it arrives, scores the reading against the forecast,
// then learns from it. Also tracks the shape of the primary channel over time and remembers
// recurring shapes as episodes. No audio or DOM here.

import { clamp } from './util.js';

const MEMORY = {
    minHistory: 6,        // readings before a channel's forecast is used
    binAlphaMin: 0.12,
    errorTau: 96,         // in samples
    gapGrowth: 0.25,      // extra forecast spread per missed sample
    minCalibration: 30,
    maxCalibration: 4000,
    minCorrelation: 24,
    spreadAlpha: 0.15,
    recordLimit: 6000
};

const EPISODE = {
    length: 6,            // window points, each the mean of `stride` readings
    commit: 2,            // windows a new shape must hold before it counts
    match: 0.6,           // feature distance for a return
    limit: 32,
    scaleAlpha: 0.05,
    flat: 0.25            // smaller steps (in window spreads) are not turns
};

// Intervals in scale steps, rhythm in beats; the last note is held
export const MOTIFS = {
    still: { label: 'Still', intervals: [1, -1, 0], rhythm: [2, 1, 1, 3] },
    rising: { label: 'Rising', intervals: [1, 1, 2], rhythm: [1, 1, 1, 3] },
    falling: { label: 'Falling', intervals: [-2, -1, -1], rhythm: [1, 1, 1, 3] },
    swell: { label: 'Swell', intervals: [2, 2, -2, -2], rhythm: [1, 0.5, 1.5, 1, 3] },
    hollow: { label: 'Hollow', intervals: [-2, -1, 1, 2], rhythm: [1.5, 0.5, 1, 1, 3] },
    restless: { label: 'Restless', intervals: [3, -2, 2, -3, 1], rhythm: [0.5, 0.5, 0.5, 0.5, 1, 2] }
};

export const SHAPES = Object.keys(MOTIFS);

// Each new episode of a shape starts its motif on a different scale step
const VARIANT_OFFSETS = [0, 2, 4, 1, 3, 5];

// Abramowitz & Stegun 7.1.26, used until there is enough history to rank departures against
function erf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return x >= 0 ? y : -y;
}

// Seasonal baseline (an EWMA per phase bin, interpolated) plus AR(1) on the last residual
class ChannelPredictor {
    constructor({ bins, period, phi, levelTau, cadence }) {
        this.bins = bins;
        this.period = period;
        this.phi = phi;
        this.levelTau = levelTau;
        this.cadence = cadence;
        this.means = new Array(bins).fill(null);
        this.counts = new Array(bins).fill(0);
        this.level = null;
        this.errorVar = null;
        this.residual = 0;
        this.last = null;
        this.n = 0;
    }

    position(phase) {
        return ((((phase / this.period) % 1) + 1) % 1) * this.bins;
    }

    baseline(phase) {
        if (this.bins === 1 || phase === null) return this.level;
        const pos = this.position(phase) - 0.5;
        const i0 = (Math.floor(pos) + this.bins) % this.bins;
        const i1 = (i0 + 1) % this.bins;
        const a = this.means[i0] ?? this.means[i1] ?? this.level;
        const b = this.means[i1] ?? this.means[i0] ?? this.level;
        return a + (b - a) * (pos - Math.floor(pos));
    }

    // Samples since the last reading. A replay loop goes back in time; treat that as one step.
    steps(time) {
        if (!this.last) return 1;
        const gap = (time - this.last.time) / this.cadence;
        return gap > 0 ? Math.max(1, gap) : 1;
    }

    predict(time, phase) {
        if (this.n < MEMORY.minHistory || this.errorVar === null) return null;
        const steps = this.steps(time);
        const mu = this.baseline(phase) + this.residual * this.phi ** steps;
        const sigma = Math.sqrt(this.errorVar) * (1 + MEMORY.gapGrowth * Math.min(steps - 1, 8));
        return { mu, sigma };
    }

    update(time, phase, x, mu) {
        const steps = this.steps(time);
        if (this.level === null) this.level = x;
        // before the first real forecast, persistence error stands in
        const error = mu !== null ? x - mu : this.last ? x - this.last.x : null;
        if (error !== null) {
            const alpha = Math.max(1 / (this.n + 1), 1 - Math.exp(-steps / MEMORY.errorTau));
            this.errorVar = this.errorVar === null ? error * error : this.errorVar + alpha * (error * error - this.errorVar);
        }
        this.level += Math.max(1 / (this.n + 1), 1 - Math.exp(-steps / this.levelTau)) * (x - this.level);
        if (this.bins > 1 && phase !== null) {
            const bin = Math.floor(this.position(phase)) % this.bins;
            this.counts[bin] += 1;
            const alpha = Math.max(1 / this.counts[bin], MEMORY.binAlphaMin);
            this.means[bin] = this.means[bin] === null ? x : this.means[bin] + alpha * (x - this.means[bin]);
        }
        this.residual = x - this.baseline(phase);
        this.last = { time, x };
        this.n += 1;
    }
}

// Least-squares slope and curvature of evenly spaced points on t in [-1, 1]
function fitShape(values) {
    const n = values.length;
    const ts = values.map((_, i) => -1 + (2 * i) / (n - 1));
    const meanT2 = ts.reduce((sum, t) => sum + t * t, 0) / n;
    let slope = 0;
    let slopeNorm = 0;
    let curve = 0;
    let curveNorm = 0;
    values.forEach((x, i) => {
        const t = ts[i];
        slope += t * x;
        slopeNorm += t * t;
        curve += (t * t - meanT2) * x;
        curveNorm += (t * t - meanT2) ** 2;
    });
    return { slope: slope / slopeNorm, curve: curve / curveNorm };
}

function classify(xs, scale) {
    const { slope, curve } = fitShape(xs);
    const b = slope / scale;
    const c = curve / scale;
    let turns = 0;
    let previous = 0;
    for (let i = 1; i < xs.length; i++) {
        const step = xs[i] - xs[i - 1];
        if (Math.abs(step) < EPISODE.flat * scale) continue;
        if (previous && Math.sign(step) !== previous) turns += 1;
        previous = Math.sign(step);
    }
    let shape = 'still';
    if (turns >= 3) shape = 'restless';
    else if (Math.abs(c) > 0.9 && Math.abs(c) > Math.abs(b)) shape = c < 0 ? 'swell' : 'hollow';
    else if (b > 0.7) shape = 'rising';
    else if (b < -0.7) shape = 'falling';
    return { shape, b, c };
}

function describe(episode, time = episode.last) {
    return {
        id: episode.id,
        shape: episode.shape,
        count: episode.count,
        isReturn: episode.count > 1,
        offset: VARIANT_OFFSETS[episode.variant % VARIANT_OFFSETS.length],
        motif: MOTIFS[episode.shape],
        time
    };
}

export class SourceMemory {
    constructor(source) {
        this.channels = source.channels;
        this.model = source.model;
        this.primary = source.channels.find((channel) => channel.role === 'primary').key;
        this.predictors = Object.fromEntries(source.channels.map(({ key }) => [key, new ChannelPredictor(source.model)]));
        this.weights = Object.fromEntries(source.channels.map(({ key }) => [key, 1]));
        this.typicalSigma = {};
        this.calibration = [];
        this.calibrated = false;
        this.residualLog = [];
        this.records = new Map();
        this.spread = 0;
        this.last = null;

        this.pending = [];
        this.window = [];
        this.windowScale = null;
        this.shape = null;
        this.candidate = null;
        this.candidateHits = 0;
        this.episodes = [];
        this.episodeCount = 0;
        this.variants = {};
        this.stats = Object.fromEntries(SHAPES.map((shape) => [shape, { episodes: 0, occurrences: 0, last: null }]));
    }

    warmUp(samples) {
        for (const sample of samples) this.observe(sample, true);
        this.calibrate();
    }

    // Channels that move together share their weight, so one event isn't counted twice. The
    // combined scores seen so far become the distribution new departures are ranked against.
    calibrate() {
        const keys = this.channels.map(({ key }) => key);
        const complete = this.residualLog.filter((vector) => keys.every((key) => key in vector));
        if (complete.length >= MEMORY.minCorrelation) {
            const stats = keys.map((key) => {
                const values = complete.map((vector) => vector[key]);
                const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
                const sd = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length) || 1;
                return { key, values, mean, sd };
            });
            for (const a of stats) {
                let shared = 0;
                for (const b of stats) {
                    if (a === b) continue;
                    let cov = 0;
                    for (let i = 0; i < a.values.length; i++) cov += (a.values[i] - a.mean) * (b.values[i] - b.mean);
                    shared += Math.abs(cov / a.values.length / (a.sd * b.sd));
                }
                this.weights[a.key] = 1 / (1 + shared);
            }
        }
        this.calibration = this.residualLog
            .slice(-MEMORY.maxCalibration)
            .map((vector) => this.combine(vector))
            .filter((s) => s !== null)
            .sort((a, b) => a - b);
        for (const { key } of this.channels) {
            const { errorVar } = this.predictors[key];
            if (errorVar !== null) this.typicalSigma[key] = Math.sqrt(errorVar);
        }
        this.calibrated = this.calibration.length >= MEMORY.minCalibration;
    }

    combine(vector) {
        let sum = 0;
        let weight = 0;
        for (const [key, r] of Object.entries(vector)) {
            sum += this.weights[key] * r * r;
            weight += this.weights[key];
        }
        return weight ? Math.sqrt(sum / weight) : null;
    }

    percentile(s) {
        const sorted = this.calibration;
        if (sorted.length < MEMORY.minCalibration) return erf(s / Math.SQRT2);
        let lo = 0;
        let hi = sorted.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (sorted[mid] <= s) lo = mid + 1; else hi = mid;
        }
        return (lo + 0.5) / (sorted.length + 1);
    }

    // Forecast and score without learning. d is the departure percentile, u the uncertainty
    // (wide forecasts, missing readings), kept separate from d.
    score(sample) {
        const channels = {};
        const vector = {};
        let missing = 0;
        let unavailable = 0;
        let wideSum = 0;
        let wideCount = 0;
        let lead = null;
        let leadValue = 0;
        for (const { key, floor } of this.channels) {
            const x = sample.values[key] ?? null;
            const prediction = this.predictors[key].predict(sample.time, sample.phase);
            const entry = { x, mu: prediction?.mu ?? null, sigma: prediction?.sigma ?? null, r: null };
            if (x === null) {
                missing += 1;
            } else if (!prediction) {
                unavailable += 1;
            } else {
                entry.r = (x - prediction.mu) / Math.max(prediction.sigma, floor);
                vector[key] = entry.r;
                const weighted = Math.abs(this.weights[key] * entry.r);
                if (weighted > leadValue) {
                    leadValue = weighted;
                    lead = key;
                }
            }
            if (prediction && this.typicalSigma[key]) {
                wideSum += prediction.sigma / this.typicalSigma[key];
                wideCount += 1;
            }
            channels[key] = entry;
        }
        const s = this.combine(vector);
        const total = this.channels.length;
        const wide = wideCount ? clamp((wideSum / wideCount - 0.8) / 1.6) : 0;
        return {
            time: sample.time,
            phase: sample.phase,
            channels,
            vector,
            s,
            d: s === null ? null : this.percentile(s),
            sign: lead ? Math.sign(channels[lead].r) : 0,
            lead,
            u: clamp(0.5 * wide + missing / total + (0.6 * unavailable) / total),
            missing: missing / total
        };
    }

    peek(sample) {
        return this.score(sample);
    }

    observe(sample, warm = false) {
        const obs = this.score(sample);
        for (const { key } of this.channels) {
            const { x, mu } = obs.channels[key];
            if (x !== null) this.predictors[key].update(sample.time, sample.phase, x, mu);
        }

        const residuals = Object.values(obs.vector);
        if (residuals.length) {
            this.residualLog.push(obs.vector);
            if (this.residualLog.length > MEMORY.maxCalibration) this.residualLog.shift();
            const meanAbs = residuals.reduce((sum, r) => sum + Math.abs(r), 0) / residuals.length;
            this.spread += MEMORY.spreadAlpha * (meanAbs - this.spread);
        }
        if (!warm && !this.calibrated && this.residualLog.length >= MEMORY.minCalibration) this.calibrate();
        obs.spread = this.spread;
        obs.episode = this.trackEpisode(obs);

        if (!warm) {
            this.records.delete(obs.time);
            this.records.set(obs.time, { channels: obs.channels, d: obs.d });
            if (this.records.size > MEMORY.recordLimit) this.records.delete(this.records.keys().next().value);
        }
        this.last = obs;
        return obs;
    }

    // Returns an episode when a new shape settles, otherwise null
    trackEpisode(obs) {
        const { x, r } = obs.channels[this.primary];
        if (x === null) return null;
        this.pending.push({ x, r: r ?? 0 });
        if (this.pending.length < (this.model.episode?.stride ?? 1)) return null;
        const n = this.pending.length;
        this.window.push({
            x: this.pending.reduce((sum, p) => sum + p.x, 0) / n,
            r: this.pending.reduce((sum, p) => sum + p.r, 0) / n
        });
        this.pending = [];
        if (this.window.length > EPISODE.length) this.window.shift();
        if (this.window.length < EPISODE.length) return null;

        const xs = this.window.map((p) => p.x);
        const mean = xs.reduce((sum, v) => sum + v, 0) / xs.length;
        const sd = Math.sqrt(xs.reduce((sum, v) => sum + (v - mean) ** 2, 0) / xs.length);
        const floor = this.channels.find(({ key }) => key === this.primary).floor;
        // shapes are judged against how much a window usually moves for this source
        this.windowScale = this.windowScale === null ? Math.max(sd, floor) : this.windowScale + EPISODE.scaleAlpha * (sd - this.windowScale);
        const { shape, b, c } = classify(xs, Math.max(this.windowScale, floor));

        if (shape === this.shape) {
            this.candidate = null;
            return null;
        }
        if (shape !== this.candidate) {
            this.candidate = shape;
            this.candidateHits = 0;
        }
        this.candidateHits += 1;
        if (this.candidateHits < EPISODE.commit) return null;
        this.shape = shape;
        this.candidate = null;

        const meanR = this.window.reduce((sum, p) => sum + p.r, 0) / this.window.length;
        const features = [clamp(b / 3, -2, 2), clamp(c / 3, -2, 2), clamp(meanR / 2, -2, 2)];
        if (this.model.period > 1 && obs.phase !== null) {
            const angle = (2 * Math.PI * obs.phase) / this.model.period;
            features.push(0.5 * Math.cos(angle), 0.5 * Math.sin(angle));
        }
        return this.remember(shape, features, obs.time);
    }

    // The episode the source is in now
    current() {
        const candidates = this.episodes.filter((episode) => episode.shape === this.shape);
        if (!candidates.length) return null;
        return describe(candidates.reduce((a, b) => (b.last > a.last ? b : a)));
    }

    remember(shape, features, time) {
        let best = null;
        let bestDistance = Infinity;
        for (const episode of this.episodes) {
            if (episode.shape !== shape) continue;
            const distance = Math.hypot(...features.map((f, i) => f - (episode.features[i] ?? 0)));
            if (distance < bestDistance) {
                best = episode;
                bestDistance = distance;
            }
        }

        let episode = best;
        if (best && bestDistance < EPISODE.match) {
            best.count += 1;
            best.last = time;
            best.features = best.features.map((f, i) => f + 0.2 * ((features[i] ?? f) - f));
        } else {
            const variant = this.variants[shape] ?? 0;
            this.variants[shape] = variant + 1;
            episode = { id: ++this.episodeCount, shape, features, count: 1, first: time, last: time, variant };
            this.episodes.push(episode);
            this.stats[shape].episodes += 1;
            if (this.episodes.length > EPISODE.limit) {
                const oldest = this.episodes.reduce((a, b) => (a.last <= b.last ? a : b));
                this.episodes.splice(this.episodes.indexOf(oldest), 1);
            }
        }
        this.stats[shape].occurrences += 1;
        this.stats[shape].last = time;
        return describe(episode, time);
    }
}
