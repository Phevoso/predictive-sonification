// Weather noise, always on. Two engines: the rain~.pd worklet, where the current conditions pick
// one of the patch's eight presets, the readings nudge its sliders (as the sensors did in the
// original installation) and a strong departure leans it toward the storm preset; or a calm bed of
// brown and pink noise that swells slowly, for sleep and meditation, shaped differently for each
// of the eight conditions.

import { between, clamp, lerp, rms } from '../util.js';
import { DEPARTING } from '../music/melody.js';

const SLIDERS = ['crackles', 'hipass', 'dropAmount', 'intensity', 'windiness', 'dropGain', 'dropSize', 'size'];

const PRESETS = {
    dry: { crackles: 4, hipass: 100, dropAmount: 3, intensity: 60, windiness: 26, dropGain: 5, dropSize: 53, size: 94 },
    summer: { crackles: 81, hipass: 121.5, dropAmount: 8, intensity: 107, windiness: 35.5, dropGain: 38.62, dropSize: 6.37, size: 61.5 },
    rain: { crackles: 81, hipass: 27.5, dropAmount: 110, intensity: 115, windiness: 1.5, dropGain: 63.62, dropSize: 17.37, size: 15.5 },
    mist: { crackles: 12, hipass: 60, dropAmount: 60, intensity: 90, windiness: 62.5, dropGain: 36, dropSize: 125, size: 8.5 },
    storm: { crackles: 80, hipass: 44, dropAmount: 95, intensity: 102, windiness: 75.5, dropGain: 62, dropSize: 125, size: 19.5 },
    ice: { crackles: 6, hipass: 12, dropAmount: 7, intensity: 122, windiness: 20.5, dropGain: 20.5, dropSize: 78.5, size: 31.5 },
    snow: { crackles: 17, hipass: 12, dropAmount: 15, intensity: 11, windiness: 85, dropGain: 11, dropSize: 121, size: 7.5 },
    gale: { crackles: 59, hipass: 70, dropAmount: 60, intensity: 90, windiness: 40.5, dropGain: 53, dropSize: 60.5, size: 30.5 }
};

const NOISE = {
    engine: 'calm',                   // 'calm' or 'rain'
    rainUnder: 0,                     // how much rain~ plays beneath the calm bed
    sensorInfluence: 0.35,
    storm: 0.15,
    mars: { ice: 0.35 },              // share of its range below which Mars sounds as ice
    solar: { gale: 450, storm: 600 }, // km/s
    floor: { windiness: 45, dropGain: 20 },
    // Crackles and loud drops multiply noise by noise and sound gritty; kept low so it stays calm
    ceiling: { crackles: 15, dropGain: 35 },
    glide: 6,
    lowpass: 250,
    // An octave down from the patch: its filter sliders scale as 2^(6x) Hz (2^(14x) for the
    // highpass), so these many slider steps halve each frequency
    octave: { size: 127 / 6, dropSize: 127 / 6, dropAmount: 127 / 6, hipass: 127 / 14 },
    // No compressor: in Web Audio one adds makeup gain and pumps the low end
    loudness: 0.004,                  // RMS after the lowpass that louder weather is held to
    level: 15.8,                      // trim: puts that ceiling at REFERENCE
    sand: 9,                          // garden grains per second at full drop amount
    dust: [1.5, 8]                    // Mars grains per second, coldest sol to warmest
};

const CALM = {
    level: 0.24,                      // trim: about 4 dB under REFERENCE at the top of a breath
    wind: [0.8, 1.25],                // the low-pass opens this much from still air to wind
    whistle: { q: 9, sweep: [550, 1300], period: 23 }
};

// Each condition's bed. tilt: brown against pink; lowpass and highpass in Hz; period: seconds per
// breath; depth: how far a breath dips; patter: soft drop-like flutter; whistle: a narrow band
// sweeping like wind in a gap; level: trims that keep them equally loud, give or take a little.
const PROFILES = {
    dry: { tilt: 0.9, lowpass: 200, highpass: 25, period: [14, 24], depth: 0.2, patter: 0, whistle: 0, level: 0.94 },
    summer: { tilt: 0.55, lowpass: 650, highpass: 70, period: [10, 18], depth: 0.25, patter: 0, whistle: 0, level: 1.05 },
    rain: { tilt: 0.3, lowpass: 1500, highpass: 160, period: [6, 12], depth: 0.25, patter: 0.55, whistle: 0, level: 1.21 },
    mist: { tilt: 0.97, lowpass: 140, highpass: 20, period: [18, 30], depth: 0.6, patter: 0, whistle: 0, level: 1.19 },
    storm: { tilt: 0.5, lowpass: 950, highpass: 30, period: [4, 8], depth: 0.65, patter: 0.35, whistle: 0.15, level: 1.29 },
    ice: { tilt: 0.1, lowpass: 3500, highpass: 1000, period: [12, 20], depth: 0.2, patter: 0, whistle: 0, level: 1.09 },
    snow: { tilt: 0.92, lowpass: 120, highpass: 20, period: [20, 34], depth: 0.1, patter: 0, whistle: 0, level: 0.79 },
    gale: { tilt: 0.6, lowpass: 700, highpass: 90, period: [3, 7], depth: 0.6, patter: 0, whistle: 0.35, level: 1.38 }
};

// classifyCondition from the original patch
function weatherCondition({ temperature, humidity, wind }, { code } = {}) {
    if (code >= 95) return 'storm';
    if (wind >= 40) return 'gale';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if ([56, 57, 66, 67].includes(code)) return 'ice';
    if ((code >= 51 && code <= 65) || (code >= 80 && code <= 82)) return wind >= 30 ? 'storm' : 'rain';
    if (code === 45 || code === 48 || humidity >= 93) return 'mist';
    if (temperature <= -2) return 'ice';
    if (temperature >= 18 && code !== null && code !== undefined && code <= 2) return 'summer';
    return 'dry';
}

// the patch's sensor-to-slider mappings, in slider units (0-127)
function weatherSliders({ temperature, humidity, pressure, wind, radiation }) {
    const slider = (value, lo, hi) => (value === null || value === undefined ? null : clamp((value - lo) / (hi - lo)) * 127);
    const lux = radiation === null || radiation === undefined ? null : Math.max(1, radiation * 120);
    return {
        crackles: slider(temperature, -10, 45),
        dropGain: slider(temperature, -10, 45),
        intensity: slider(humidity, 0, 100),
        dropSize: slider(humidity, 0, 100),
        dropAmount: lux === null ? null : 2 + slider(lux, 1, 65535) * (125 / 127),
        hipass: pressure === null || pressure === undefined ? null : slider(pressure - 1013.25, -50, 50),
        windiness: slider(wind, 0, 60)
    };
}

export function condition(kind, sample, relative) {
    if (!sample) return 'dry';
    if (kind === 'weather') return weatherCondition(sample.values, sample.extras);
    if (kind === 'mars') return relative < NOISE.mars.ice ? 'ice' : 'dry';
    const speed = sample.values.speed ?? 0;
    if (speed >= NOISE.solar.storm) return 'storm';
    return speed >= NOISE.solar.gale ? 'gale' : 'mist';
}

export class WeatherNoise {
    constructor(ctx, output) {
        this.ctx = ctx;
        // two lowpasses in series for a steeper, softer top
        this.lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: NOISE.lowpass, Q: 0 });
        const second = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: NOISE.lowpass, Q: 0 });
        this.guard = new GainNode(ctx, { gain: 1 });
        const rainLevel = NOISE.level * (NOISE.engine === 'rain' ? 1 : NOISE.rainUnder);
        this.gain = new GainNode(ctx, { gain: 1 });   // the texture control, on both engines
        this.meter = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0 });
        this.lowpass.connect(second).connect(this.guard).connect(new GainNode(ctx, { gain: rainLevel })).connect(this.gain);
        second.connect(this.meter);
        this.gain.connect(output);

        const first = PROFILES.dry;
        this.calmFilter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: first.lowpass, Q: 0 });
        this.calmHighpass = new BiquadFilterNode(ctx, { type: 'highpass', frequency: first.highpass, Q: 0 });
        this.whistle = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: CALM.whistle.sweep[0], Q: CALM.whistle.q });
        this.whistleLevel = new GainNode(ctx, { gain: 0 });
        this.swell = new GainNode(ctx, { gain: 1 });
        this.calmLevel = new GainNode(ctx, { gain: NOISE.engine === 'calm' ? CALM.level * first.level : 0 });
        this.calmFilter.connect(this.calmHighpass).connect(this.swell);
        this.whistle.connect(this.whistleLevel).connect(this.swell);
        this.swell.connect(this.calmLevel).connect(this.gain);
        this.calm = null;
        this.breath = { phase: 0, period: first.period[1] };
        this.whistlePhase = 0;
        this.meterBuffer = new Float32Array(2048);
        this.node = null;
        this.preset = 'dry';
        this.sand = [];
        this.sandCount = 0;
        this.sandCarry = 0;
    }

    load() {
        const worklet = this.ctx.audioWorklet;
        // rain~ only runs when it is heard; muted it would still cost the audio thread
        const rain = NOISE.engine === 'rain' || NOISE.rainUnder > 0;
        this.loading ??= Promise.all([
            rain && worklet.addModule(new URL('../worklets/noise-gen.js', import.meta.url)).then(() => {
                this.node = new AudioWorkletNode(this.ctx, 'weather-noise', { numberOfInputs: 0, outputChannelCount: [2] });
                this.node.connect(this.lowpass);
            }),
            worklet.addModule(new URL('../worklets/calm-noise.js', import.meta.url)).then(() => {
                this.calm = new AudioWorkletNode(this.ctx, 'calm-noise', { numberOfInputs: 0, outputChannelCount: [2] });
                this.calm.parameters.get('tilt').value = PROFILES.dry.tilt;
                this.calm.connect(this.calmFilter);
                this.calm.connect(this.whistle);
            })
        ]).catch((error) => console.warn('Weather noise unavailable', error));
        return this.loading;
    }

    setTexture(texture, now) {
        this.gain.gain.setTargetAtTime(lerp(0.4, 1.8, texture), now, 0.5);
    }

    // The calm bed in the current condition's shape, gliding between conditions; wind opens it a
    // little and a strong departure makes it breathe deeper
    updateCalm(now, dt, sliders, storm) {
        const profile = PROFILES[this.preset];
        const glide = NOISE.glide;
        const wind = between(CALM.wind, sliders.windiness / 127);
        this.calmFilter.frequency.setTargetAtTime(profile.lowpass * wind, now, glide);
        this.calmHighpass.frequency.setTargetAtTime(profile.highpass, now, glide);
        this.calmLevel.gain.setTargetAtTime(CALM.level * profile.level, now, glide);
        this.whistleLevel.gain.setTargetAtTime(profile.whistle, now, glide);
        if (this.calm) {
            this.calm.parameters.get('tilt').setTargetAtTime(profile.tilt, now, glide);
            this.calm.parameters.get('patter').setTargetAtTime(profile.patter, now, glide);
        }

        this.whistlePhase = (this.whistlePhase + dt / CALM.whistle.period) % 1;
        const sweep = 0.5 - 0.5 * Math.cos(2 * Math.PI * this.whistlePhase);
        this.whistle.frequency.setTargetAtTime(between(CALM.whistle.sweep, sweep), now, 1);

        const breath = this.breath;
        breath.phase += dt / breath.period;
        if (breath.phase >= 1) {
            breath.phase -= 1;
            breath.period = between(profile.period, this.rng());
        }
        const depth = clamp(profile.depth + storm);
        const dip = 0.5 - 0.5 * Math.cos(2 * Math.PI * breath.phase);
        this.swell.gain.setTargetAtTime(1 - depth * dip, now, 0.4);
    }

    update(now, dt, { kind, sample, relative, departure, uncertainty, presence }) {
        this.preset = condition(kind, sample, relative);
        const preset = PRESETS[this.preset];
        const readings = kind === 'weather' && sample ? weatherSliders(sample.values) : {};
        const storm = NOISE.storm * clamp((departure - DEPARTING) / (1 - DEPARTING));
        const sliders = {};
        for (const name of SLIDERS) {
            const sensed = readings[name];
            const value = sensed === null || sensed === undefined ? preset[name] : lerp(preset[name], sensed, NOISE.sensorInfluence);
            sliders[name] = lerp(value, PRESETS.storm[name], storm);
        }
        sliders.windiness = Math.max(NOISE.floor.windiness, sliders.windiness);
        sliders.dropGain = Math.max(NOISE.floor.dropGain, sliders.dropGain);
        for (const [name, most] of Object.entries(NOISE.ceiling)) sliders[name] = Math.min(most, sliders[name]);
        if (this.node) {
            for (const name of SLIDERS) {
                const value = Math.max(0, sliders[name] - (NOISE.octave[name] ?? 0));
                this.node.parameters.get(name).setTargetAtTime(value, now, NOISE.glide);
            }
        }

        this.updateCalm(now, dt, sliders, storm);

        // slow gain that only ever turns loud weather down
        const level = rms(this.meter, this.meterBuffer);
        this.guard.gain.setTargetAtTime(Math.min(1, NOISE.loudness / Math.max(level, 1e-6)), now, 1.5);

        // No rain on Mars: its dust follows the temperature instead, as warm sols stir up more of it
        const sand = kind === 'mars' ? between(NOISE.dust, relative) : NOISE.sand * (sliders.dropAmount / 127);
        this.sandCarry += sand * presence * dt;
        while (this.sandCarry >= 1) {
            this.sandCarry -= 1;
            this.sand.push({ id: ++this.sandCount, time: now, pan: this.rng() * 2 - 1, length: 0.1 + 0.2 * this.rng(), u: uncertainty });
            if (this.sand.length > 240) this.sand.shift();
        }
    }
}
