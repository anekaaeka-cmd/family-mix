// Маленькие 8-битные звуки без файлов (WebAudio).
let ctx = null;
export const sfx = { muted: localStorage.getItem('fm_mute') === '1' };
export function unlockAudio() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {}
}
function tone(freq, dur = 0.12, type = 'square', when = 0, vol = 0.08) {
  if (sfx.muted || !ctx) return;
  const t = ctx.currentTime + when;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur + 0.02);
}
export const play = {
  click: () => tone(660, 0.05),
  dice: () => { for (let i = 0; i < 8; i++) tone(200 + Math.random() * 400, 0.04, 'square', i * 0.07, 0.05); },
  step: () => tone(880, 0.06, 'triangle'),
  turn: () => { tone(523, 0.1, 'square', 0); tone(784, 0.15, 'square', 0.1); },
  quiz: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.12, 'square', i * 0.09)); },
  tick: () => tone(1200, 0.03, 'triangle', 0, 0.04),
  good: () => { [659, 784, 1047].forEach((f, i) => tone(f, 0.16, 'triangle', i * 0.1, 0.1)); },
  bad: () => { tone(220, 0.25, 'sawtooth', 0, 0.06); tone(165, 0.3, 'sawtooth', 0.18, 0.06); },
  badge: () => { [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.12, 'square', i * 0.07, 0.07)); },
  event: () => { tone(988, 0.08, 'triangle'); tone(1319, 0.14, 'triangle', 0.08); },
  win: () => { [523, 523, 523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'square', i * 0.14, 0.07)); },
  // пасхалка: весёлая мелодия «домбры»
  dombra: () => { [392, 440, 494, 440, 392, 330, 392, 494, 587, 494, 440, 392].forEach((f, i) => tone(f, 0.14, 'triangle', i * 0.13, 0.09)); },
};
export function setMuted(m) { sfx.muted = m; localStorage.setItem('fm_mute', m ? '1' : '0'); }
