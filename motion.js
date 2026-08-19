// Motion engine — ONE rAF driver for JS tweens + a registry of everything moving (tweens, CSS
// transitions/animations, scrollers). `motion.idle()` is the single truthful "nothing is moving"
// signal; zero-motion mode and the harness hang off it rather than sampling geometry.
// Spec: docs/superpowers/specs/2026-08-04-motion-engine-unification.md
export const EASE_OUT = p => 1 - Math.pow(1 - p, 3);

const tweens = new Map();      // key (any value; e.g. the scroller element) -> step(now) => boolean alive
const css = new Map();         // Element -> Set<'t:prop' | 'a:name'>
const scrollers = new Set();   // elements (or document) mid-scroll; cleared by scrollend
let rafId = 0;

const pump = now => {
  for (const [k, step] of tweens) if (!step(now)) tweens.delete(k);
  rafId = tweens.size ? requestAnimationFrame(pump) : 0;
};
const mark = (el, tag) => { let s = css.get(el); if (!s) css.set(el, s = new Set()); s.add(tag); };
const clear = (el, tag) => { const s = css.get(el); if (s) { s.delete(tag); if (!s.size) css.delete(el); } };
// Ambient loops (spinners, breathing glows) never end — exclude them or idle() wedges forever.
const ambient = e => {
  // pass the pseudo (::before/::after) through — bare getComputedStyle(e.target) reads the PARENT's styles,
  // which mis-classified .cl-now::after's infinite cl-breathe as non-ambient and wedged idle() on the calendar
  const cs = getComputedStyle(e.target, e.pseudoElement || undefined), names = cs.animationName.split(', '), i = names.indexOf(e.animationName);
  const counts = cs.animationIterationCount.split(', ');
  return i >= 0 && counts[i % counts.length] === 'infinite';   // CSS repeats short lists cyclically
};

let forced = null;   // zero-motion override (harness/test mode); null → follow the OS preference
// scale 0 kills CSS motion at the stylesheet level too — this IS the app's reduced-motion switch
// (transitions/animations collapse to instant state changes; smooth scrolling goes immediate)
const zeroStyle = () => {
  const on = motion.scale === 0, el = document.getElementById('motion-zero');
  if (on && !el) { const st = document.createElement('style'); st.id = 'motion-zero';
    st.textContent = '*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; scroll-behavior: auto !important; }';
    document.head.append(st); }
  else if (!on && el) el.remove();
};

export const motion = {
  // THE reduced-motion dial: 0 = jump to end states, 1 = animate. Every JS check routes through
  // here so zero-motion is one trustworthy switch instead of 27 scattered matchMedia reads.
  get scale() { return forced ?? (matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1); },
  force(v) { forced = v; zeroStyle(); },
  // Felt-time constants (hold-to-escalate thresholds, land timers, tween durations) route through here,
  // so a time-compressed test (force(0.25)) compresses the THRESHOLDS with the motion — semantics intact.
  t(ms) { return ms * this.scale; },
  // Register a per-frame step under a key. A new run with the same key SUPERSEDES the old one — a
  // second request never queues behind or races the first. step returns true while it stays alive.
  run(key, step) { tweens.set(key, step); if (!rafId) rafId = requestAnimationFrame(pump); },
  stop(key) { tweens.delete(key); },
  active() {
    for (const el of css.keys()) if (!el.isConnected) css.delete(el);                       // removed mid-flight fires no end event
    for (const el of scrollers) if (el !== document && !el.isConnected) scrollers.delete(el);
    return tweens.size + css.size + scrollers.size;
  },
  async idle() {   // 2 clean frames: a state write's transitionrun lands a frame later, a single-frame check races it
    for (let clean = 0; clean < 2;) { await new Promise(requestAnimationFrame); clean = this.active() ? 0 : clean + 1; }
  },
  install() {      // called once from app boot — module stays importable without a DOM (unit tests)
    // fractional scale accelerates CSS motion at the source: every transition/animation IS a WAAPI
    // Animation — bump its playbackRate as it starts (real motion, real events, compressed clock)
    const rate = el => { const s = motion.scale; if (s > 0 && s !== 1) for (const a of el.getAnimations()) a.playbackRate = 1 / s; };
    document.addEventListener('transitionrun', e => { mark(e.target, 't:' + e.propertyName); rate(e.target); }, true);
    for (const t of ['transitionend', 'transitioncancel']) document.addEventListener(t, e => clear(e.target, 't:' + e.propertyName), true);
    document.addEventListener('animationstart', e => { if (!ambient(e)) { mark(e.target, 'a:' + e.animationName); rate(e.target); } }, true);
    for (const t of ['animationend', 'animationcancel']) document.addEventListener(t, e => clear(e.target, 'a:' + e.animationName), true);
    document.addEventListener('scroll', e => scrollers.add(e.target), { capture: true, passive: true });
    document.addEventListener('scrollend', e => scrollers.delete(e.target), true);
    window.__motion = motion;   // the ONE test-facing line (spec: minimal in-app test surface)
    zeroStyle();                // OS-level reduced-motion users get the kill switch from first paint
  },
};
