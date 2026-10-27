import { Engine } from '../src/engine.js';
import { SourceMemory } from '../src/memory.js';
import { Garden } from '../src/garden.js';
import { CITIES, formatMoment, loadMars, loadSolarWind, loadWeather } from '../src/sources/index.js';

const $ = (selector) => document.querySelector(selector);

const engine = new Engine();
const garden = new Garden($('[data-garden]'));
const states = new Map();
let state = null;

function load(id) {
    if (!states.has(id)) {
        const loader = id === 'mars' ? loadMars
            : id === 'solar' ? loadSolarWind
                : () => loadWeather(CITIES.find((city) => `weather:${city.id}` === id));
        states.set(id, loader().then((source) => {
            const memory = new SourceMemory(source);
            memory.warmUp(source.samples.filter((sample) => sample.time < source.replay.start));
            return { source, memory, cursor: source.replay.start - 1, index: undefined };
        }));
    }
    return states.get(id);
}

async function select(id) {
    state = await load(id);
    garden.clear();
    engine.setSource(state);
}

$('[data-toggle]').addEventListener('click', () => (engine.running ? engine.stop() : engine.start()));
$('[data-source]').addEventListener('change', (event) => select(event.target.value));
$('[data-speed]').addEventListener('change', (event) => engine.setSpeed(Number(event.target.value)));

engine.addEventListener('statechange', () => {
    $('[data-toggle]').textContent = engine.running ? 'Stop' : 'Start';
    if (!engine.running) garden.clear();
});
engine.addEventListener('note', ({ detail }) => {
    if (detail.instrument === 'piano') garden.addStone(detail);
});
engine.addEventListener('observation', ({ detail }) => {
    const { start, end } = state.source.replay;
    garden.addTick((detail.time - start) / (end - start), engine.ctx.currentTime, detail.d ?? 0);
});

function frame(ms) {
    const running = engine.running && Boolean(engine.graph);
    const now = running ? engine.ctx.currentTime : ms / 1000;
    const canvas = $('[data-garden]');
    if (running) garden.consumeSand(engine.sandLog, now, canvas.clientWidth, canvas.clientHeight, false);
    const cursor = state ? (state.cursor - state.source.replay.start) / (state.source.replay.end - state.source.replay.start) : null;
    garden.draw(now, { levels: engine.levels(), chordRoot: engine.chord?.root, running, cursor, reduced: false, idleSwell: 0.5 });
    if (state) {
        const moment = formatMoment(state.source, Math.max(state.cursor, state.source.replay.start));
        $('[data-status]').textContent = `${state.source.place} · ${moment} · ${engine.chordName()} · ${engine.noiseMood ?? ''}`;
    }
    requestAnimationFrame(frame);
}

select('weather:reykjavik');
requestAnimationFrame(frame);
