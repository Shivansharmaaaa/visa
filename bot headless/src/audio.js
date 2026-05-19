'use strict';

const path = require('path');
const player = require('play-sound')({});

/**
 * Resolves the path to a bundled sound file.
 * When running as a pkg exe, sounds live next to the .exe.
 * When running as node, sounds live in ../sounds/ relative to this file.
 * @param {string} filename
 * @returns {string}
 */
function resolveSoundPath(filename) {
  if (process.pkg) {
    return path.join(path.dirname(process.execPath), 'sounds', filename);
  }
  return path.join(__dirname, '..', 'sounds', filename);
}

/**
 * Plays an audio alert using play-sound.
 * Errors are caught and logged — never throws.
 * @param {string} [soundFile='sound.mp3']
 * @returns {Promise<void>}
 */
async function playAlert(soundFile = 'sound.mp3') {
  const soundPath = resolveSoundPath(soundFile);
  return new Promise((resolve) => {
    try {
      player.play(soundPath, (err) => {
        if (err) {
          console.warn('[audio] playAlert error:', err.message || err);
        }
        resolve();
      });
    } catch (err) {
      console.warn('[audio] playAlert exception:', err.message || err);
      resolve();
    }
  });
}

module.exports = { playAlert, resolveSoundPath };
