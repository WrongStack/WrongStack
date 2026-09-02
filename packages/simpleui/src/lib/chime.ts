/** Play a short completion chime using the Web Audio API.
 *  Best-effort — never throws, silently degrades when audio is unavailable. */
export function playChime(): void {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    // Two-note ascending chime (C5 → E5), 80ms each, triangle-wave
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'triangle';
    osc1.frequency.value = 523.25; // C5
    gain1.gain.setValueAtTime(0.12, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc1.connect(gain1).connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.12);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.value = 659.25; // E5
    gain2.gain.setValueAtTime(0.12, now + 0.08);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    osc2.connect(gain2).connect(ctx.destination);
    osc2.start(now + 0.08);
    osc2.stop(now + 0.22);

    // Clean up after the sound finishes
    setTimeout(() => {
      try {
        ctx.close();
      } catch {
        /* best-effort */
      }
    }, 300);
  } catch {
    // Audio unavailable (e.g. no user gesture yet, privacy-restricted context)
  }
}
