// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The turn-end chime's sound — one sound, wherever it plays: the Agent View
// plays it as a turn ends, Settings plays it when the user asks to hear it.
// Two soft tones made with Web Audio: no audio file, nothing the page's
// security policy has to admit. Chromium starts audio only for a page the
// user has touched, so a page's audio context is made inside a touch
// (`armChime`) or a click that plays at once, then held suspended — resumed
// for each chime and suspended after, so no audio device is held open
// between chimes. A touched page that is hidden can still resume it.

/** Two rising tones (E5, B5), each a quick swell and a slow fade. */
const TONES = [659.25, 987.77];
const TONE_GAP_S = 0.14;
const TONE_LENGTH_S = 0.9;
const PEAK_GAIN = 0.2;

let audio: AudioContext | null = null;
let sounding = 0;

/** Whether the user has touched this page since it loaded. */
export const pageTouched = (): boolean => navigator.userActivation?.hasBeenActive ?? false;

/** Makes the page's audio context inside the user's touch, where Chromium
 * lets it run, and holds it suspended until a chime. */
export function armChime(): void {
  if (audio !== null) return;
  audio = new AudioContext();
  void audio.suspend();
}

export function playChime(): void {
  const ctx = (audio ??= new AudioContext());
  sounding++;
  void ctx.resume().then(() => {
    const start = ctx.currentTime + 0.02;
    TONES.forEach((frequency, i) => {
      const at = start + i * TONE_GAP_S;
      const tone = ctx.createOscillator();
      const gain = ctx.createGain();
      tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + TONE_LENGTH_S);
      tone.connect(gain).connect(ctx.destination);
      tone.start(at);
      tone.stop(at + TONE_LENGTH_S);
      if (i < TONES.length - 1) return;
      tone.onended = () => {
        sounding -= 1;
        if (sounding === 0) void ctx.suspend();
      };
    });
  });
}
