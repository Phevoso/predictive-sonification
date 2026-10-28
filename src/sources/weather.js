// Open-Meteo: two weeks of hourly history; the first week trains the model, the second is replayed

import { DAY, HOUR, MINUTE, append, fetchJson, finite, makeSource, snapshot } from './common.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const SEARCH_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const PAST_DAYS = 14;
const REPLAY_DAYS = 7;

export const CITIES = [
    { id: 'reykjavik', name: 'Reykjavík', latitude: 64.1466, longitude: -21.9426 },
    { id: 'kyoto', name: 'Kyoto', latitude: 35.0116, longitude: 135.7681 },
    { id: 'athens', name: 'Athens', latitude: 37.9838, longitude: 23.7275 }
];

const CHANNELS = [
    { key: 'temperature', field: 'temperature_2m', label: 'Temperature', unit: '°C', floor: 0.4, role: 'primary' },
    { key: 'humidity', field: 'relative_humidity_2m', label: 'Humidity', unit: '%', floor: 3 },
    { key: 'pressure', field: 'pressure_msl', label: 'Pressure', unit: 'hPa', floor: 0.5 },
    { key: 'wind', field: 'wind_speed_10m', label: 'Wind', unit: 'km/h', floor: 2 },
    { key: 'radiation', field: 'shortwave_radiation', label: 'Sunlight', unit: 'W/m²', floor: 20, role: 'texture' },
    { key: 'cloud', field: 'cloud_cover', label: 'Cloud', unit: '%', floor: 8 }
];

// Not charted; the weather noise uses them to pick its preset
const EXTRAS = { code: 'weather_code', precipitation: 'precipitation' };

const MODEL = { bins: 24, period: 24, cadence: HOUR, phi: 0.6, levelTau: 48, episode: { stride: 1 } };

function url(city, pastDays) {
    const fields = [...CHANNELS.map((channel) => channel.field), ...Object.values(EXTRAS)].join(',');
    return `${FORECAST_URL}?latitude=${city.latitude}&longitude=${city.longitude}`
        + `&current=${fields}&hourly=${fields}&past_days=${pastDays}&forecast_days=1&timezone=auto`;
}

function readRow(block, i) {
    const pick = (field) => finite(i === undefined ? block[field] : block[field]?.[i]);
    const values = {};
    for (const { key, field } of CHANNELS) values[key] = pick(field);
    const extras = {};
    for (const [key, field] of Object.entries(EXTRAS)) extras[key] = pick(field);
    return { values, extras };
}

// Times come back in local time; the phase is the local hour
function parse(json) {
    const offset = json.utc_offset_seconds * 1000;
    const toTime = (local) => Date.parse(`${local}Z`) - offset;
    const hourOf = (local) => Number(local.slice(11, 13)) + Number(local.slice(14, 16)) / 60;
    const now = toTime(json.current.time);
    const samples = [];
    json.hourly.time.forEach((local, i) => {
        const time = toTime(local);
        if (time <= now) samples.push({ time, phase: hourOf(local), ...readRow(json.hourly, i) });
    });
    if (!samples.length || now > samples[samples.length - 1].time) {
        samples.push({ time: now, phase: hourOf(json.current.time), ...readRow(json.current) });
    }
    return { samples, timezone: json.timezone };
}

export async function loadWeather(city) {
    let json;
    let status = 'live';
    try {
        json = await fetchJson(url(city, PAST_DAYS));
    } catch (error) {
        console.warn(`Weather for ${city.name} unavailable, using the Reykjavík snapshot`, error);
        json = await snapshot('weather-reykjavik.json');
        city = CITIES[0];
        status = 'snapshot';
    }
    const { samples, timezone } = parse(json);
    return makeSource({
        id: `weather:${city.id}`,
        kind: 'weather',
        place: city.name,
        city,
        timezone,
        status,
        channels: CHANNELS,
        samples,
        replayStart: samples[samples.length - 1].time - REPLAY_DAYS * DAY,
        speeds: [HOUR / 8, HOUR / 4, HOUR / 1.5],
        pollMs: status === 'live' ? 10 * MINUTE : 0,
        model: MODEL
    });
}

export async function refreshWeather(source) {
    return append(source, parse(await fetchJson(url(source.city, 1))).samples);
}

export async function searchCities(query) {
    const { results = [] } = await fetchJson(`${SEARCH_URL}?name=${encodeURIComponent(query)}&count=6&language=en&format=json`);
    return results.map((place) => ({
        id: `geo-${place.id}`,
        name: place.name,
        region: [place.admin1, place.country].filter(Boolean).join(', '),
        latitude: place.latitude,
        longitude: place.longitude
    }));
}
