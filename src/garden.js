// A raked-sand garden drawn from the voices. Pads move the raked lines, piano notes drop stones
// (red on a departure), the bass is the thick line underneath, the noise's drops are sand, and
// each reading leaves a tick on the time ruler.

const GARDEN = {
    zone: [0.07, 0.74],     // raked area, fraction of the height
    bassY: 0.84,
    rulerY: 0.95,
    lineGap: 15,
    lineStep: 5,
    padSwell: 0.6,          // of the line gap
    padSpeed: 0.35,
    stoneSize: [6, 15],
    stoneSink: 1.8,
    reach: 3.4,             // in stone radii
    rings: [1.55, 2.15, 2.8],
    ripple: 34,             // px/s
    maxStones: 18,
    maxSand: 420,
    pitchRange: [60, 98]
};

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (x) => x * x * (3 - 2 * x);

export class Garden {
    constructor(canvas) {
        this.canvas = canvas;
        this.stones = [];
        this.sand = [];
        this.ticks = [];
        this.levels = { pads: 0, piano: 0, bass: 0, noise: 0, clicks: 0 };
        this.wavelength = null;
        this.lastSand = 0;
        this.stoneSeed = 1;
        this.readColours();
    }

    readColours() {
        const style = getComputedStyle(this.canvas);
        const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
        const ink = read('--black', '#000');
        this.colours = {
            ink,
            sand: read('--sand', ink),
            line: read('--grey-light', '#999'),
            faint: read('--grey-border', '#E5E5E5'),
            shu: read('--shu', '#C23B22'),
            ground: read('--white', '#FFF')
        };
    }

    // Sized from the parent and capped, so a missing stylesheet can't make the canvas grow every frame
    fit() {
        const dpr = window.devicePixelRatio || 1;
        const width = Math.min(this.canvas.parentElement.clientWidth, 2400);
        const height = Math.min(this.canvas.getBoundingClientRect().height, 900);
        if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
            this.canvas.width = Math.round(width * dpr);
            this.canvas.height = Math.round(height * dpr);
        }
        const ctx = this.canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx, width, height };
    }

    clear() {
        this.stones = [];
        this.sand = [];
        this.ticks = [];
    }

    // pan -> x, pitch -> y
    addStone({ midi, velocity, pan, decay, departure, count, time }) {
        const seed = this.stoneSeed++;
        const wobble = Array.from({ length: 9 }, (_, i) => 1 + 0.13 * Math.sin(seed * 12.9898 + i * 78.233));
        this.stones.push({
            x: clamp((pan + 1) / 2 * 0.84 + 0.08),
            y: 1 - clamp((midi - GARDEN.pitchRange[0]) / (GARDEN.pitchRange[1] - GARDEN.pitchRange[0])),
            size: velocity,
            born: time,
            life: decay,
            departure,
            count: count || 0,
            wobble,
            tilt: (seed * 0.61803) % Math.PI
        });
        if (this.stones.length > GARDEN.maxStones) this.stones.shift();
    }

    addTick(fraction, time, strength = 0) {
        this.ticks.push({ fraction: clamp(fraction), born: time, strength });
        if (this.ticks.length > 60) this.ticks.shift();
    }

    consumeSand(log, now, width, height, reduced) {
        const [top, bottom] = GARDEN.zone;
        for (const grain of log) {
            if (grain.id <= this.lastSand || grain.time > now) continue;
            this.lastSand = grain.id;
            const spread = 1 + grain.u * 1.5;
            this.sand.push({
                x: clamp((grain.pan + 1) / 2 + (Math.random() - 0.5) * 0.05) * width,
                y: lerp(top, bottom, Math.random()) * height,
                vx: reduced ? 0 : (4 + Math.random() * 6) * (Math.random() < 0.5 ? -1 : 1) * spread,
                vy: reduced ? 0 : (Math.random() - 0.5) * 4 * spread,
                born: now,
                life: 1.6 + grain.length * 5,
                size: 0.8 + grain.u * 1.8,
                alpha: 0.55 - grain.u * 0.3
            });
        }
        if (this.sand.length > GARDEN.maxSand) this.sand.splice(0, this.sand.length - GARDEN.maxSand);
    }

    // `now` is the audio clock. `idleSwell` keeps the lines moving while nothing plays.
    draw(now, { levels, chordRoot, running, cursor, reduced, idleSwell = 0.12 }) {
        const { ctx, width, height } = this.fit();
        const c = this.colours;
        ctx.fillStyle = c.ground;
        ctx.fillRect(0, 0, width, height);

        for (const name of Object.keys(this.levels)) {
            const target = running ? levels[name] ?? 0 : 0;
            this.levels[name] += (target - this.levels[name]) * 0.08;
        }
        const t = reduced ? 0 : now;
        const [zoneTop, zoneBottom] = GARDEN.zone.map((f) => f * height);
        const lineCount = Math.max(10, Math.floor((zoneBottom - zoneTop) / GARDEN.lineGap));
        const gap = (zoneBottom - zoneTop) / (lineCount - 1);
        const scale = clamp(Math.min(width, height * 1.6) / 700, 0.6, 1.3);

        const targetWave = chordRoot ? lerp(width / 2.2, width / 5, clamp((chordRoot - 38) / 12)) : width / 3;
        this.wavelength = this.wavelength === null ? targetWave : this.wavelength + (targetWave - this.wavelength) * 0.01;
        const swell = (running ? 0.12 + clamp(this.levels.pads / 0.07) : idleSwell) * gap * GARDEN.padSwell;

        const stones = this.stones
            .filter((stone) => now - stone.born < stone.life + GARDEN.stoneSink)
            .map((stone) => {
                const age = Math.max(0, now - stone.born);
                const landing = reduced ? 1 : smooth(clamp(age / 0.45));
                const sinking = 1 - clamp((age - stone.life) / GARDEN.stoneSink);
                const radius = lerp(...GARDEN.stoneSize, stone.size) * scale;
                return { ...stone, px: stone.x * width, py: lerp(zoneTop + gap, zoneBottom - gap, stone.y), age, presence: landing * sinking, radius };
            });
        this.stones = this.stones.filter((stone) => now - stone.born < stone.life + GARDEN.stoneSink);

        ctx.lineWidth = 1;
        ctx.strokeStyle = c.line;
        for (let i = 0; i < lineCount; i++) {
            const y0 = zoneTop + i * gap;
            const phase = i * 0.45;
            const lift = 0.55 + 0.45 * Math.sin(i * 0.7 + t * 0.1);
            ctx.globalAlpha = 0.55 + 0.25 * Math.sin(i * 1.3);
            ctx.beginPath();
            for (let x = 0; x <= width + GARDEN.lineStep; x += GARDEN.lineStep) {
                let y = y0 + swell * lift * Math.sin((2 * Math.PI * x) / this.wavelength + phase + t * GARDEN.padSpeed);
                for (const stone of stones) {
                    const reach = stone.radius * GARDEN.reach;
                    const dx = x - stone.px;
                    if (Math.abs(dx) > reach) continue;
                    const dy = y0 - stone.py;
                    const distance = Math.hypot(dx, dy);
                    if (distance >= reach) continue;
                    const push = smooth(1 - distance / reach) * stone.radius * 1.5 * stone.presence;
                    y += (Math.sign(dy) || 1) * push;
                }
                if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        for (const grain of this.sand) {
            const age = now - grain.born;
            if (age > grain.life || age < 0) continue;
            const fade = 1 - age / grain.life;
            ctx.globalAlpha = grain.alpha * fade;
            ctx.fillStyle = c.sand;
            ctx.beginPath();
            ctx.arc(grain.x + grain.vx * age, grain.y + grain.vy * age, grain.size, 0, Math.PI * 2);
            ctx.fill();
        }
        this.sand = this.sand.filter((grain) => now - grain.born <= grain.life);
        ctx.globalAlpha = 1;

        for (const stone of stones) {
            const colour = stone.departure ? c.shu : c.ink;
            ctx.strokeStyle = colour;
            ctx.lineWidth = 0.75;
            GARDEN.rings.forEach((ring, k) => {
                const appear = reduced ? 1 : clamp((stone.age - k * 0.18) / 0.5);
                ctx.globalAlpha = 0.35 * (1 - k * 0.22) * appear * stone.presence;
                ctx.beginPath();
                ctx.ellipse(stone.px, stone.py, stone.radius * ring * 1.15, stone.radius * ring * 0.85, 0, 0, Math.PI * 2);
                ctx.stroke();
            });
            if (!reduced && stone.age < 2.2) {
                const r = stone.radius * 1.2 + stone.age * GARDEN.ripple;
                ctx.globalAlpha = 0.45 * (1 - stone.age / 2.2);
                ctx.beginPath();
                ctx.ellipse(stone.px, stone.py, r * 1.15, r * 0.85, 0, 0, Math.PI * 2);
                ctx.stroke();
            }

            ctx.globalAlpha = stone.presence;
            ctx.fillStyle = colour;
            ctx.beginPath();
            stone.wobble.forEach((w, k) => {
                const a = (k / stone.wobble.length) * Math.PI * 2 + stone.tilt;
                const x = stone.px + Math.cos(a) * stone.radius * w * 1.12;
                const y = stone.py + Math.sin(a) * stone.radius * w * 0.82;
                if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            });
            ctx.closePath();
            ctx.fill();

            // one inner ring per return of the motif
            ctx.strokeStyle = c.ground;
            ctx.lineWidth = 0.75;
            for (let k = 1; k < Math.min(stone.count, 4); k++) {
                const r = stone.radius * (1 - k * 0.24);
                ctx.beginPath();
                ctx.ellipse(stone.px, stone.py, r * 0.95, r * 0.7, 0, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;

        const bassY = GARDEN.bassY * height;
        const bassAmp = (running ? clamp(this.levels.bass / 0.12) : 0) * height * 0.025;
        for (const [offset, alpha, widthPx] of [[-5, 0.25, 1], [0, 1, 2]]) {
            ctx.globalAlpha = alpha;
            ctx.strokeStyle = c.ink;
            ctx.lineWidth = widthPx;
            ctx.beginPath();
            for (let x = 0; x <= width + 8; x += 8) {
                const y = bassY + offset + bassAmp * Math.sin((2 * Math.PI * x) / (width * 0.75) + t * 0.25);
                if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // time ruler
        const rulerY = GARDEN.rulerY * height;
        ctx.fillStyle = c.faint;
        ctx.fillRect(0, Math.round(rulerY) + 0.5, width, 1);
        for (const tick of this.ticks) {
            const age = now - tick.born;
            if (age < 0) continue;
            const fade = clamp(1 - age / 5);
            if (fade <= 0) continue;
            ctx.globalAlpha = fade;
            ctx.fillStyle = tick.strength > 0.8 ? c.shu : c.ink;
            ctx.fillRect(Math.round(tick.fraction * width), rulerY - 7, 1, 8);
        }
        this.ticks = this.ticks.filter((tick) => now - tick.born < 5);
        ctx.globalAlpha = 1;
        if (cursor !== null && cursor !== undefined) {
            const x = Math.round(clamp(cursor) * width);
            ctx.fillStyle = c.ink;
            ctx.fillRect(x - 1, rulerY - 12, 2, 13);
        }
    }
}
