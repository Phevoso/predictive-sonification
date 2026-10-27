import { refreshWeather } from './weather.js';
import { refreshSolarWind } from './solar.js';
import { LANDING, SOL } from './mars.js';

export { CITIES, loadWeather, searchCities } from './weather.js';
export { loadMars } from './mars.js';
export { loadSolarWind } from './solar.js';

export function refreshSource(source) {
    if (source.kind === 'weather') return refreshWeather(source);
    if (source.kind === 'solar') return refreshSolarWind(source);
    return Promise.resolve(0);
}

// A data time in the source's own terms: local time, UTC, or sol and date
export function formatMoment(source, time) {
    if (source.kind === 'mars') {
        const sol = Math.round((time - LANDING) / SOL);
        return `sol ${sol} · ${new Date(time).toISOString().slice(0, 10)}`;
    }
    const timeZone = source.kind === 'weather' ? source.timezone : 'UTC';
    const text = new Intl.DateTimeFormat('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone })
        .format(new Date(time));
    return source.kind === 'solar' ? `${text} UTC` : text;
}
