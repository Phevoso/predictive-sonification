# predictive-sonification

Environmental data played as music in the browser.
A rework of my thesis project, [generative_music_iot](https://github.com/Phevoso/generative_music_iot) with several improvements.

Each reading is forecast before it arrives. One voice follows what was expected, another reacts
when the reading departs from the forecast, and patterns that come back return as motifs.



## Sources

- Weather for any city, hourly, from [Open-Meteo](https://open-meteo.com/)
- Mars weather from Curiosity's REMS station, one reading per sol, from
  [NASA/JPL-Caltech/CAB](https://mars.nasa.gov/msl/mission/weather/)
- Real-time solar wind at L1, one reading per minute, from
  [NOAA SWPC](https://www.swpc.noaa.gov/products/real-time-solar-wind)

If a feed is not available, a snapshot in `assets/data` is used instead.

## Architecture

### Forecasting memory

Every source has its own predictor in `memory.js`. Before a sample arrives it predicts the value,
then scores the real one against it and updates. Most of the music reacts to that error instead of
the raw value.

The prediction is a baseline for the hour of day, or the season on Mars, plus a one-pole term on
the last error. It keeps a running variance of its own error, which grows when samples are
missing.

The error is normalized by that variance, combined across channels and ranked against the
source's history. That rank is the departure. I down-weight channels that move together.
Missing data and wide predictions go into a separate uncertainty value.

The primary channel is also read in short windows and classified by slope and curvature into one
of six shapes. When a shape repeats, it is matched to an earlier episode and its motif comes back.

Before playback the predictor runs over the earlier history.

### Voices

- The pads play the forecast: the mode follows the expected temperature, and the chords
  move with the direction it is heading.
- The piano plays the motifs of recurring shapes and, on strong departures, single notes.
- The weather noise always plays, a slow brown-noise bed that opens with the wind. The rain~ port
  is still there behind a switch.
- Bass and clicks come and go with the shape of the data.
- The key starts somewhere random and drifts with the long-term trend.

## Running it

```
python3 serve.py
```

Open http://localhost:8030/demo/

## Layout

```
src/engine.js      transport and scheduling
src/memory.js      forecasting, departures, episodes
src/music/         harmony, orchestration, melody
src/voices/        pads, piano, bass, noise, clicks
src/sources/       weather, Mars, solar wind
src/worklets/      rain~ and vangex~ ports
src/garden.js      the visual
demo/              run and view it
tools/             calibrate.html, checks each voice's level
```

## Credits

Piano samples: Salamander Grand Piano by Alexander Holm, CC BY 3.0.

## License

MIT, see `LICENSE`.
