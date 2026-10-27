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

## How it works

- `memory.js` keeps a forecast per channel: a daily or seasonal baseline plus the recent trend.
  Every new reading is scored against the forecast, ranked against the source's own history, and
  then learned from.
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

TBD
