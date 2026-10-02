# Recorded world audio

All files ship locally, so playback needs neither an API key nor a third-party request.
Prepared 2026-09-27 with `tools/prepare-world-audio.py`: mono PCM16 at 24 kHz,
DC removal, level matching, short transient fades; loops use a 100 ms seam crossfade.
These are edited recordings / foley library assets, not ElevenLabs generations.

| Files | Recording / creator | License |
| --- | --- | --- |
| `step-*.wav` (five takes per surface) | [Kenney Impact Sounds](https://kenney.nl/assets/impact-sounds), Kenney | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `engine-idle.wav` | [engine_idle_loop_1.wav](https://freesound.org/people/RichieMcMullen/sounds/386793/), RichieMcMullen; HQ preview edited | CC0 |
| `engine-start.wav` | [CarEngine.wav](https://freesound.org/people/prometheus888/sounds/458461/), prometheus888; first 1.65 seconds of HQ preview | CC0 |
| `engine-load.wav`, `road-roll.wav`, `engine-stop.wav` | [Car on a Road #1286](https://bigsoundbank.com/car-on-a-road-s1286.html), Joseph SARDIN; onboard Peugeot 107 recording, filtered excerpts | CC0 |
| `door-open.wav`, `door-close.wav` | [Car_door_SFX](https://opengameart.org/content/cardoorsfx), looneybits | CC0 |

Source downloads:
- https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip
- https://cdn.freesound.org/previews/386/386793_7236624-hq.mp3
- https://cdn.freesound.org/previews/458/458461_63692-hq.mp3
- https://bigsoundbank.com/UPLOAD/mp3/1286.mp3
- https://opengameart.org/sites/default/files/door_opening.wav
- https://opengameart.org/sites/default/files/door_closing.wav

Engine load and road layers are separated by frequency filtering of the onboard recording;
they are approximations, not isolated multi-RPM recordings of the modeled sedan. The game
crossfades these with the idle recording, varies pitch with simulated RPM and filters the cabin view.
