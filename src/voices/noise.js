// Weather noise: the rain~.pd worklet, always on. The current conditions pick one of the patch's
// eight presets, the weather readings nudge its sliders (as the sensors did in the original
// installation), and a strong departure leans it toward the storm preset.

import { clamp, lerp, rms } from '../util.js';
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
    sensorInfluence: 0.35,
    storm: 0.5,
    mars: { ice: 0.35 },              // share of its range below which Mars sounds as ice
    solar: { gale: 450, storm: 600 }, // km/s
    floor: { windiness: 45, dropGain: 20 },
    glide: 6,
    lowpass: 250,
    // No compressor: in Web Audio one adds makeup gain and pumps the low end
    level: 22,
    loudness: 0.004,                  // RMS after the lowpass that louder weather is held to
    sand: 9                           // garden grains per second at full drop amount
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
        this.lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: NOISE.lowpass, Q: 0 });
        this.guard = new GainNode(ctx, { gain: 1 });
        this.gain = new GainNode(ctx, { gain: NOISE.level });
        this.meter = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0 });
        this.lowpass.connect(this.guard).connect(this.gain).connect(output);
        this.lowpass.connect(this.meter);
        this.meterBuffer = new Float32Array(2048);
        this.node = null;
        this.preset = 'dry';
        this.sand = [];
        this.sandCount = 0;
        this.sandCarry = 0;
    }

    load() {
        this.loading ??= this.ctx.audioWorklet
            .addModule(new URL('../worklets/noise-gen.js', import.meta.url))
            .then(() => {
                this.node = new AudioWorkletNode(this.ctx, 'weather-noise', { numberOfInputs: 0, outputChannelCount: [2] });
                this.node.connect(this.lowpass);
            })
            .catch((error) => console.warn('Weather noise unavailable', error));
        return this.loading;
    }

    setTexture(texture, now) {
        this.gain.gain.setTargetAtTime(NOISE.level * lerp(0.4, 1.8, texture), now, 0.5);
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
        if (this.node) {
            for (const name of SLIDERS) this.node.parameters.get(name).setTargetAtTime(sliders[name], now, NOISE.glide);
        }

        // slow gain that only ever turns loud weather down
        const level = rms(this.meter, this.meterBuffer);
        this.guard.gain.setTargetAtTime(Math.min(1, NOISE.loudness / Math.max(level, 1e-6)), now, 1.5);

        this.sandCarry += NOISE.sand * (sliders.dropAmount / 127) * presence * dt;
        while (this.sandCarry >= 1) {
            this.sandCarry -= 1;
            this.sand.push({ id: ++this.sandCount, time: now, pan: this.rng() * 2 - 1, length: 0.1 + 0.2 * this.rng(), u: uncertainty });
            if (this.sand.length > 240) this.sand.shift();
        }
    }
}
