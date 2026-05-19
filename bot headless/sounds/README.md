# Sound Files

The following MP3 files must be copied from the repo root `sounds/` directory into this folder before building:

- `sound.mp3`
- `sound1.mp3`
- `sound2.mp3`

These files are bundled into the `.exe` by `pkg` via the `assets` config in `package.json`.
They are played by `src/audio.js` when a shift is successfully booked.

To copy them (from repo root):

```
cp ../sounds/sound.mp3 .
cp ../sounds/sound1.mp3 .
cp ../sounds/sound2.mp3 .
```
