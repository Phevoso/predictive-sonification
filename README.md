# predictive-sonification

Environmental data played as music in the browser.

Each reading is forecast before it arrives. One voice follows what was expected, another reacts
when the reading departs from the forecast, and patterns that come back (a rising morning, a
falling evening) return as motifs. It runs on Web Audio with no build step.

Inspired by [generative_music_iot](https://github.com/Phevoso/generative_music_iot). The `rain~`
weather noise and `vangex~` synth are ported from its Pure Data patches to AudioWorklets.

## Sources

- Weather for any city, hourly, from [Open-Meteo](https://open-meteo.com/)
- Mars weather from Curiosity's REMS station, one reading per sol
  ([NASA/JPL-Caltech/CAB](https://mars.nasa.gov/msl/mission/weather/))
- Real-time solar wind at L1, one reading per minute
  ([NOAA SWPC](https://www.swpc.noaa.gov/products/real-time-solar-wind))

If a feed is down, a bundled snapshot in `assets/data` is used instead.

## Architecture

### Forecasting memory

`memory.js` runs the same loop for every reading: predict, score, then learn. The forecast is made
before the reading is seen, so the music can tell what is normal for a place from what is not.

- **Forecast.** Each channel has a seasonal baseline, an EWMA per phase bin (24 hourly bins for
  weather, 36 bins of solar longitude for Mars, a single level for the solar wind), interpolated
  between bins. An AR(1) term on the last residual carries short-term persistence. The forecast's
  spread comes from a running estimate of its own error, and widens when readings are missing.
- **Departure.** Each reading becomes a residual in forecast spreads. The channels are combined
  into one score, with correlated channels down-weighted so one event isn't counted twice. The
  score is then ranked against the source's own history as a percentile, so a calm place and a
  volatile one are comparable.
- **Uncertainty.** A wide forecast or missing readings are tracked separately from surprise.
- **Episodes.** The primary channel is watched in short windows. Each window's slope and curvature
  classify it as still, rising, falling, swell, hollow or restless, judged against how much a
  window usually moves for that source. When a new shape holds, it is compared with remembered
  episodes (shape, strength, time of day or season). A close match counts as a return, otherwise
  a new episode is stored with its own variant of the motif.
- **Warm-up.** History before the replay window trains the model first, so it starts with an
  idea of the place.

### Voices

- The pads (Vangex) play the forecast: the mode follows the expected temperature, and the chords
  move with the direction it is heading.
- The piano plays the motifs of recurring shapes and, on strong departures, single notes.
- The weather noise always plays; the current conditions pick its preset.
- Bass and clicks come and go with the shape of the data.
- The key starts somewhere random and drifts with the long-term trend.

## Running it

Any static server works. `serve.py` disables caching, which helps while editing:

```
python3 serve.py
```

Then open http://localhost:8030/demo/

## Layout

```
src/engine.js      transport and scheduling
src/memory.js      forecasting, departures, episodes
src/music/         harmony, orchestration, melody
src/voices/        pads, piano, bass, noise, clicks
src/sources/       weather, Mars, solar wind
src/worklets/      rain~ and vangex~ ports
src/garden.js      the visual
demo/              a minimal page
```

## Credits

Piano samples: Salamander Grand Piano by Alexander Holm, CC BY 3.0
(see `assets/samples/piano/LICENSE.txt`).

## License

MIT, see `LICENSE`. The piano samples keep their own CC BY 3.0 license.
