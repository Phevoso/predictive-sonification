// Curiosity's REMS weather station, one reading per sol. Replays the last two Mars years;
// everything before trains the model.

import { fetchJson, makeSource, number, snapshot, unpack } from './common.js';

const FEED_URL = 'https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json';
export const SOL = 88775244;
export const LANDING = Date.UTC(2012, 7, 6, 5, 17);
const REPLAY_SOLS = 1337;

const UV_LEVELS = { Low: 0, Moderate: 1, High: 2, Very_High: 3 };

const CHANNELS = [
    { key: 'maxTemp', label: 'Air max', unit: '°C', floor: 1.5, role: 'primary' },
    { key: 'minTemp', label: 'Air min', unit: '°C', floor: 1.5 },
    { key: 'pressure', label: 'Pressure', unit: 'Pa', floor: 4 },
    { key: 'uv', label: 'UV index', unit: '', floor: 0.5, role: 'texture' },
    { key: 'daylight', label: 'Daylight', unit: 'h', floor: 0.05 }
];

const MODEL = { bins: 36, period: 360, cadence: SOL, phi: 0.6, levelTau: 60, episode: { stride: 3 } };

const clockHours = (clock) => {
    if (!clock || clock === '--') return null;
    const [h, m] = clock.split(':').map(Number);
    return h + m / 60;
};

function parse(soles) {
    return soles
        .map((row) => {
            const sol = Number(row.sol);
            const sunrise = clockHours(row.sunrise);
            const sunset = clockHours(row.sunset);
            return {
                time: LANDING + sol * SOL,
                phase: number(row.ls),
                sol,
                date: row.terrestrial_date,
                values: {
                    maxTemp: number(row.max_temp),
                    minTemp: number(row.min_temp),
                    pressure: number(row.pressure),
                    uv: UV_LEVELS[row.local_uv_irradiance_index] ?? null,
                    daylight: sunrise !== null && sunset !== null ? sunset - sunrise : null
                }
            };
        })
        .filter((sample) => Number.isFinite(sample.sol))
        .sort((a, b) => a.time - b.time);
}

export async function loadMars() {
    let soles;
    let status = 'delayed';
    try {
        soles = (await fetchJson(FEED_URL)).soles;
    } catch (error) {
        console.warn('Mars weather unavailable, using the snapshot', error);
        soles = unpack(await snapshot('mars.json'));
        status = 'snapshot';
    }
    const samples = parse(soles);
    return makeSource({
        id: 'mars',
        kind: 'mars',
        place: 'Gale Crater',
        status,
        channels: CHANNELS,
        samples,
        replayStart: samples[samples.length - 1].time - REPLAY_SOLS * SOL,
        speeds: [SOL / 6, SOL / 3, SOL],
        pollMs: 0,
        model: MODEL
    });
}
