// Plays a data source as music. A cursor moves through the source's samples, or follows the newest
// one when live. Each sample it passes is forecast, scored and learned by the source's memory,
// and the voices respond to the result.

import { VOICES, applyControls, buildGraph } from './graph.js';
import { Harmony, brightness, keyMemory } from './music/harmony.js';
import { ALWAYS, ORCHESTRATED, Orchestra } from './music/orchestra.js';
import { Melody } from './music/melody.js';
import { PADS, Pads } from './voices/pads.js';
import { Piano } from './voices/piano.js';
import { Bass } from './voices/bass.js';
import { WeatherNoise } from './voices/noise.js';
import { Clicks } from './voices/clicks.js';
import { between, clamp, hash, lerp, mulberry32, rms } from './util.js';

const TICK_MS = 200;
const LOOKAHEAD = 1.2;
const LEVEL = 0.45;           // leaves room for the piano's attacks
const START_FADE = 3;
const SWITCH_FADE = 2.6;
const DEPARTURE_TAU = 6;      // seconds a departure lingers in the music
const CLICK_GAP = 1.5;
const FADE = { in: 2.5, out: 4 };

// 5th to 95th percentile of a channel
function range(samples, key) {
    const values = samples.map((s) => s.values[key]).filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
    if (!values.length) return [0, 1];
    const lo = values[Math.floor(values.length * 0.05)];
    const hi = values[Math.floor(values.length * 0.95)];
    return hi > lo ? [lo, hi] : [lo - 1, hi + 1];
}

export class Engine extends EventTarget {
    constructor() {
        super();
        this.ctx = null;
        this.graph = null;
        this.running = false;
        this.state = null;            // { source, memory, cursor, index }
        this.mode = 'replay';
        this.speed = 1;
        this.controls = { density: 0.5, texture: 0.5, space: 0.5 };
        this.startToken = 0;
        this.harmony = new Harmony();
        this.orchestra = new Orchestra((voices, now) => this.lineupChanged(voices, now));
        this.levelBuffer = new Float32Array(512);
        this.reset();
    }

    get chord() {
        return this.harmony.chord;
    }

    get sandLog() {
        return this.noise?.sand ?? [];
    }

    get noiseMood() {
        return this.noise?.preset;
    }

    chordName() {
        return this.harmony.name();
    }

    async start() {
        if (this.running) return;
        // create and resume the context before any await, while still inside the click
        this.ctx ??= new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
        const token = ++this.startToken;
        const resumed = this.ctx.resume();
        clearTimeout(this.suspendTimer);
        this.running = true;
        this.dispatchEvent(new Event('statechange'));
        await resumed;
        if (!this.running || this.startToken !== token) return;

        if (!this.graph) this.build();
        this.piano.load();
        this.noise.load();
        this.pads.load();
        this.applyControls();

        const now = this.ctx.currentTime;
        this.reset(now);
        const level = this.graph.master.gain;
        level.cancelAndHoldAtTime(now);
        level.linearRampToValueAtTime(LEVEL, now + START_FADE);

        this.lastTick = now;
        this.tick();
        this.timer = setInterval(() => this.tick(), TICK_MS);
    }

    stop() {
        if (!this.running) return;
        this.running = false;
        this.startToken += 1;
        clearInterval(this.timer);
        if (this.graph) {
            const now = this.ctx.currentTime;
            this.graph.master.gain.cancelAndHoldAtTime(now);
            this.graph.master.gain.linearRampToValueAtTime(0, now + 0.8);
            this.bass.fade(now, 0.3);
        }
        this.suspendTimer = setTimeout(() => {
            if (!this.running) this.ctx.suspend();
        }, 1000);
        this.dispatchEvent(new Event('statechange'));
    }

    // While playing, the old source fades out under a click before the new one comes in
    setSource(state) {
        if (!this.state || !this.running || !this.graph) {
            this.state = state;
            this.reset(this.ctx?.currentTime ?? 0);
            return;
        }
        const now = this.ctx.currentTime;
        this.switching = true;
        clearTimeout(this.switchTimer);
        this.graph.mix.gain.setTargetAtTime(0, now, 0.6);
        this.bass.fade(now, 0.6);
        this.clicks.play(now + 0.05, 0.9, 2600, 0, this.graph.direct);
        this.switchTimer = setTimeout(() => {
            this.state = state;
            this.reset(this.ctx.currentTime);
            this.switching = false;
            this.graph.mix.gain.setTargetAtTime(1, this.ctx.currentTime, 1.3);
        }, SWITCH_FADE * 1000);
    }

    setMode(mode) {
        this.mode = mode;
        if (this.state && mode === 'live') {
            const { samples } = this.state.source;
            this.state.index = samples.length - 1;
            this.state.cursor = samples[samples.length - 1].time - 1;
        }
        this.dispatchEvent(new Event('statechange'));
    }

    setSpeed(speed) {
        this.speed = speed;
    }

    seek(fraction) {
        if (!this.state) return;
        const { start, end } = this.state.source.replay;
        this.state.cursor = lerp(start, end, clamp(fraction));
        this.state.index = this.indexAfter(this.state.cursor);
        if (this.mode === 'live') this.setMode('replay');
    }

    setControl(name, value) {
        this.controls[name] = clamp(value);
        if (this.graph) this.applyControls();
    }

    build() {
        const g = buildGraph(this.ctx);
        this.graph = g;
        this.pads = new Pads(this.ctx, g.pads);
        this.piano = new Piano(this.ctx, g.piano);
        this.bass = new Bass(this.ctx, g.faders.bass);
        this.noise = new WeatherNoise(this.ctx, g.faders.noise);
        this.clicks = new Clicks(this.ctx, g.faders.clicks);
        this.melody = new Melody(this.harmony, this.piano, (type, detail, time) => this.emitAt(type, detail, time));
    }

    applyControls() {
        const now = this.ctx.currentTime;
        applyControls(this.graph, this.controls, now);
        this.noise.setTexture(this.controls.texture, now);
    }

    reset(now = 0) {
        const source = this.state?.source;
        const rng = mulberry32(hash(source?.id ?? 'listen'));
        this.rng = rng;
        this.harmony.reset(now, rng);
        this.orchestra.reset(now, rng);
        for (const voice of [this.pads, this.piano, this.noise, this.clicks]) if (voice) voice.rng = rng;
        this.nextChord = now + 0.6;
        this.departure = { level: 0, sign: 0, lead: null };
        this.lastClick = now + START_FADE - CLICK_GAP;   // no clicks before the pads are in
        this.lastObs = null;
        this.lastSample = null;
        this.ranges = source
            ? { primary: range(source.samples, this.channelKey('primary')), texture: range(source.samples, this.channelKey('texture')) }
            : null;
        if (!this.state) {
            this.melody?.reset(now, rng, null);
            return;
        }
        if (this.state.index === undefined) this.state.index = this.indexAfter(this.state.cursor);
        const sample = this.state.source.samples[Math.max(0, this.state.index - 1)];
        if (sample) this.lastObs = this.state.memory.peek(sample);
        this.lastSample = sample;
        this.seedTrend();
        // open with the episode the source is already in
        this.melody?.reset(now, rng, this.state.memory.current());
    }

    seedTrend() {
        const { samples, kind } = this.state.source;
        const key = this.channelKey('primary');
        const tau = keyMemory(kind);
        const end = Math.min(this.state.index, samples.length);
        for (let i = Math.max(0, end - tau * 4); i < end; i++) this.harmony.follow(samples[i].values[key], tau);
    }

    channelKey(role) {
        return this.state?.source.channels.find((channel) => channel.role === role)?.key;
    }

    // Where a channel sits in its own range, using the forecast when there is one
    normalised(role, obs = this.lastObs) {
        const entry = obs?.channels[this.channelKey(role)];
        const value = entry ? entry.mu ?? entry.x : null;
        if (value === null || !this.ranges) return 0.5;
        const [lo, hi] = this.ranges[role];
        return clamp((value - lo) / (hi - lo));
    }

    indexAfter(time) {
        const { samples } = this.state.source;
        let lo = 0;
        let hi = samples.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (samples[mid].time <= time) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    tick() {
        if (!this.running) return;
        const now = this.ctx.currentTime;
        const dt = Math.max(0, now - this.lastTick);
        this.lastTick = now;
        if (!this.state || this.switching) return;

        this.advance(now, dt);
        this.orchestra.update(now, { shape: this.state.memory.shape, departure: this.departure.level, busy: Boolean(this.melody.pending) });
        this.departure.level *= Math.exp(-dt / DEPARTURE_TAU);
        if (this.nextChord < now + LOOKAHEAD) this.playChord(Math.max(this.nextChord, now));
        this.melody.tick(now, { departure: this.departure, density: this.controls.density, current: this.state.memory.current() });
        this.noise.update(now, dt, {
            kind: this.state.source.kind,
            sample: this.lastSample,
            relative: this.normalised('primary'),
            departure: this.departure.level,
            uncertainty: this.lastObs?.u ?? 0,
            presence: this.graph.buses.noise.gain.value
        });

        const texture = clamp(0.15 + 0.7 * this.normalised('texture') + 0.3 * (this.controls.texture - 0.5));
        const cutoff = between(PADS.cutoff, texture) * (1 + 0.12 * Math.sin((now * Math.PI) / 23));
        this.graph.pads.frequency.setTargetAtTime(cutoff, now, 1.5);
    }

    advance(now, dt) {
        const state = this.state;
        const { samples, replay } = state.source;
        let target;
        if (this.mode === 'live') {
            target = samples[samples.length - 1].time;
        } else {
            target = state.cursor + dt * replay.speeds[this.speed];
            if (state.cursor < replay.start) {
                state.cursor = replay.start;
                state.index = this.indexAfter(replay.start - 1);
            }
        }

        const observed = [];
        const crossTo = (time) => {
            while (state.index < samples.length && samples[state.index].time <= time) {
                this.lastSample = samples[state.index];
                observed.push(state.memory.observe(samples[state.index]));
                state.index += 1;
            }
        };
        if (this.mode === 'replay' && target > replay.end) {
            crossTo(replay.end);
            target = replay.start + (target - replay.end);
            state.index = this.indexAfter(replay.start - 1);
            this.dispatchEvent(new Event('loop'));
        }
        crossTo(target);
        state.cursor = target;
        if (observed.length) this.answer(observed, now);
    }

    answer(observed, now) {
        this.lastObs = observed[observed.length - 1];
        const primary = this.channelKey('primary');
        const tau = keyMemory(this.state.source.kind);
        let strongest = null;
        for (const obs of observed) {
            this.harmony.follow(obs.channels[primary]?.x, tau);
            if (obs.d !== null && (!strongest || obs.d > strongest.d)) strongest = obs;
            if (obs.episode) {
                this.melody.queue(obs.episode, obs.d ?? 0, obs.sign);
                this.bass.swell(now);
            }
            this.dispatchEvent(new CustomEvent('observation', { detail: obs }));
        }
        if (strongest && strongest.d > this.departure.level) {
            this.departure = { level: strongest.d, sign: strongest.sign, lead: strongest.lead };
        }
        if (this.orchestra.has('clicks') && now - this.lastClick >= CLICK_GAP) {
            const d = strongest?.d ?? 0;
            this.clicks.play(now + 0.05, lerp(0.5, 1, d), 3000 + 1500 * this.rng(), lerp(-0.5, 0.5, this.rng()));
            this.lastClick = now;
            this.emitAt('note', { instrument: 'clicks', dataTime: this.lastObs.time, velocity: d }, now + 0.05);
        }
    }

    playChord(time) {
        const obs = this.lastObs;
        const d = this.departure.level;
        const entry = obs?.channels[this.channelKey('primary')];
        const chord = this.harmony.next({
            time,
            brightness: brightness(this.state.source.kind, entry ? entry.mu ?? entry.x : null, this.normalised('primary', obs)),
            expected: entry?.mu ?? null,
            floor: this.state.source.channels.find((c) => c.role === 'primary').floor,
            departure: d,
            uncertainty: obs?.u ?? 0,
            range: this.ranges.primary
        });
        if (chord.keyChange) {
            this.dispatchEvent(new CustomEvent('key', { detail: { offset: this.harmony.keyOffset, step: chord.keyChange } }));
        }

        const length = between(PADS.chord, this.rng()) * lerp(1.3, 0.75, this.controls.density) * lerp(1, 0.8, d);
        const envelope = this.pads.envelope();
        const { notes } = chord;
        const pans = notes.map((_, i) => lerp(-0.7, 0.7, notes.length > 1 ? i / (notes.length - 1) : 0.5) * (0.6 + 0.4 * this.rng()));
        this.pads.play(notes, time, length + envelope.attack * 0.5, envelope, pans, this.normalised('texture'));
        this.emitAt('note', { instrument: 'pads', chord, notes, velocity: 1, duration: length }, time);

        if (chord.phraseStart) {
            this.bass.play(chord.root, time);
            this.emitAt('note', { instrument: 'bass', midi: chord.root, velocity: 1, duration: length * 2 }, time);
            if (this.harmony.chordCount > 1 && this.orchestra.has('clicks')) {
                this.clicks.play(time, 0.5, 2200, -0.2);
                this.clicks.play(time + 0.11, 0.35, 2600, 0.2);
            }
        }
        this.nextChord = time + length;
    }

    lineupChanged(voices, now) {
        for (const name of ORCHESTRATED) {
            const on = voices.includes(name);
            this.graph.buses[name].gain.setTargetAtTime(on ? 1 : 0, now, on ? FADE.in : FADE.out);
        }
        this.dispatchEvent(new CustomEvent('lineup', { detail: { voices: [...voices, ...ALWAYS], solo: !voices.length } }));
    }

    // dispatched when the audio actually plays
    emitAt(type, detail, time) {
        const delay = Math.max(0, (time - this.ctx.currentTime) * 1000);
        setTimeout(() => this.dispatchEvent(new CustomEvent(type, { detail: { ...detail, time } })), delay);
    }

    levels() {
        const out = {};
        for (const name of VOICES) out[name] = this.graph ? rms(this.graph.analysers[name], this.levelBuffer) : 0;
        return out;
    }
}
