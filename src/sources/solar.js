// Real-time solar wind at L1 from NOAA SWPC: 24 hours at one reading a minute. The first six
// hours train the model, the rest is replayed.

import { HOUR, MINUTE, append, fetchJson, finite, makeSource, number, snapshot, unpack } from './common.js';

const WIND_URL = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json';
const MAG_URL = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json';
const WARM_HOURS = 6;

const CHANNELS = [
    { key: 'speed', label: 'Speed', unit: 'km/s', floor: 8, role: 'primary' },
    { key: 'density', label: 'Density', unit: 'p/cm³', floor: 0.4, role: 'texture' },
    { key: 'temperature', label: 'Temperature', unit: 'kK', floor: 8 },
    { key: 'bz', label: 'Field Bz', unit: 'nT', floor: 0.5 },
    { key: 'bt', label: 'Field Bt', unit: 'nT', floor: 0.4 }
];

const MODEL = { bins: 1, period: 1, cadence: MINUTE, phi: 0.85, levelTau: 30, episode: { stride: 5 } };

// The feeds list every spacecraft at L1; per minute keep the active one if it reported
function perMinute(rows, field) {
    const best = new Map();
    for (const row of rows) {
        if (row[field] === null || row[field] === undefined) continue;
        const minute = row.time_tag.slice(0, 16);
        const current = best.get(minute);
        if (!current || (row.active && !current.active)) best.set(minute, row);
    }
    return best;
}

function merge(windRows, magRows) {
    const wind = perMinute(windRows, 'proton_speed');
    const mag = perMinute(magRows, 'bz_gsm');
    const minutes = [...new Set([...wind.keys(), ...mag.keys()])].sort();
    return minutes.map((minute) => {
        const w = wind.get(minute) ?? {};
        const m = mag.get(minute) ?? {};
        return { time: minute, speed: w.proton_speed, density: w.proton_density, temperature: w.proton_temperature, bz: m.bz_gsm, bt: m.bt };
    });
}

function parse(rows) {
    return rows.map((row) => ({
        time: Date.parse(`${row.time}Z`),
        phase: null,
        values: {
            speed: finite(number(row.speed)),
            density: finite(number(row.density)),
            temperature: row.temperature === null || row.temperature === undefined ? null : finite(row.temperature / 1000),
            bz: finite(number(row.bz)),
            bt: finite(number(row.bt))
        }
    }));
}

async function fetchSamples() {
    const [wind, mag] = await Promise.all([fetchJson(WIND_URL), fetchJson(MAG_URL)]);
    return parse(merge(wind, mag));
}

export async function loadSolarWind() {
    let samples;
    let status = 'live';
    try {
        samples = await fetchSamples();
    } catch (error) {
        console.warn('Solar wind unavailable, using the snapshot', error);
        samples = parse(unpack(await snapshot('solar-wind.json')));
        status = 'snapshot';
    }
    return makeSource({
        id: 'solar',
        kind: 'solar',
        place: 'L1',
        status,
        channels: CHANNELS,
        samples,
        replayStart: samples[0].time + WARM_HOURS * HOUR,
        speeds: [MINUTE, MINUTE / 0.4, MINUTE / 0.15],
        pollMs: status === 'live' ? MINUTE : 0,
        model: MODEL
    });
}

export async function refreshSolarWind(source) {
    return append(source, await fetchSamples());
}
