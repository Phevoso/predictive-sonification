export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const FETCH_TIMEOUT = 20000;

export const number = (value) => (value === null || value === undefined || value === '--' || value === '' ? null : Number(value));
export const finite = (value) => (Number.isFinite(value) ? value : null);

export async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

// Bundled fallbacks for when a feed is down
export const snapshot = (file) => fetchJson(new URL(`../../assets/data/${file}`, import.meta.url));

// { fields, rows } back into objects
export function unpack({ fields, rows }) {
    return rows.map((row) => Object.fromEntries(fields.map((field, i) => [field, row[i]])));
}

export function makeSource({ samples, replayStart, speeds, ...rest }) {
    return {
        ...rest,
        samples,
        replay: {
            start: Math.max(samples[0].time, replayStart),
            end: samples[samples.length - 1].time,
            speeds
        }
    };
}

// New readings extend the end of the replay window
export function append(source, fresh) {
    const last = source.samples[source.samples.length - 1].time;
    const added = fresh.filter((sample) => sample.time > last);
    if (added.length) {
        source.samples.push(...added);
        source.replay.end = source.samples[source.samples.length - 1].time;
    }
    return added.length;
}
