// Motion engine — ONE rAF driver for JS tweens + a registry of everything moving (tweens, CSS
// transitions/animations, scrollers). `motion.idle()` is the single truthful "nothing is moving"
// signal; zero-motion mode and the harness hang off it rather than sampling geometry.
// Spec: docs/superpowers/specs/2026-08-04-motion-engine-unification.md
import DESIGN from './design.json' with { type: 'json' };
export const EASE_OUT = p => 1 - Math.pow(1 - p, 3);

const seqs = new Map();       // key -> the sequence playing under it (motion.seq)
const tweens = new Map();      // key (any value; e.g. the scroller element) -> step(now) => boolean alive
const css = new Map();         // Element -> Set<'t:prop' | 'a:name'>
const scrollers = new Map();   // element (or document) mid-scroll -> scroll-event count; cleared by scrollend or a silent frame
let rafId = 0;

const pump = now => {
  let at;
  try { for (const [k, step] of tweens) { at = k; if (!step(now)) tweens.delete(k); } }
  catch (err) { tweens.delete(at); throw err; }   // a step that throws ends; the rest step on next frame
  finally { rafId = tweens.size ? requestAnimationFrame(pump) : 0; }
};
const mark = (el, tag) => { let s = css.get(el); if (!s) css.set(el, s = new Set()); s.add(tag); };
const clear = (el, tag) => { const s = css.get(el); if (s) { s.delete(tag); if (!s.size) css.delete(el); } };
const running = () => document.getAnimations().filter(a => a.playState === 'running' && a.effect.getComputedTiming().iterations !== Infinity);
// Ambient loops (spinners, breathing glows) never end — exclude them or idle() wedges forever.
const ambient = e => {
  // pass the pseudo (::before/::after) through — bare getComputedStyle(e.target) reads the PARENT's styles,
  // which mis-classified .cl-now::after's infinite cl-breathe as non-ambient and wedged idle() on the calendar
  const cs = getComputedStyle(e.target, e.pseudoElement || undefined), names = cs.animationName.split(', '), i = names.indexOf(e.animationName);
  const counts = cs.animationIterationCount.split(', ');
  return i >= 0 && counts[i % counts.length] === 'infinite';   // CSS repeats short lists cyclically
};

let forced = null;   // harness override: 0 = zero motion (tests assert end states), a fraction compresses time; null → the OS
let reduceMQ; const osReduced = () => (reduceMQ ??= matchMedia('(prefers-reduced-motion: reduce)'));   // lazy: bun unit tests import this with no matchMedia
// Zero motion kills CSS motion at the stylesheet level (transitions/animations collapse to instant state changes).
// OS reduced motion is gentler, not zero: soften() trims each animation as it starts.
const zeroStyle = () => {
  const on = forced === 0, el = document.getElementById('motion-zero');
  if (on && !el) { const st = document.createElement('style'); st.id = 'motion-zero';
    st.textContent = '*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; transition-delay: 0s !important; animation-delay: 0s !important; scroll-behavior: auto !important; }';
    document.head.append(st); }
  else if (!on && el) el.remove();
};
const META = new Set(['offset', 'computedOffset', 'easing', 'composite']), FADE = /^(opacity|visibility)$|color$/i;   // reduced motion keeps fades (they show what changed); the rest is movement
// the animation an event is about — a pseudo-element's isn't in its host's bare getAnimations()
const animOf = (e, match) => e.target.getAnimations({ subtree: !!e.pseudoElement }).find(a => a.effect.target === e.target && (a.effect.pseudoElement || '') === e.pseudoElement && match(a));
// One animation as it starts, through the dial: a fraction compresses its clock; at 0 an ambient loop holds still and
// movement jumps to its end — when gentle, the fade part survives, capped at 150ms.
const soften = a => {
  if (!a) return;
  const s = motion.scale, fx = a.effect;
  if (s > 0) a.playbackRate = 1 / s;
  else if (fx.getTiming().iterations === Infinity) a.cancel();
  else {
    const props = new Set(motion.gentle ? fx.getKeyframes().flatMap(Object.keys) : []);
    for (const k of META) props.delete(k);
    const fades = [...props].filter(k => FADE.test(k));   // a transition is one property: all fade or all movement
    if (!fades.length) return a.finish();
    if (fades.length < props.size) fx.setKeyframes(fx.getKeyframes().map(f => Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'computedOffset' && (META.has(k) || FADE.test(k))))));
    fx.updateTiming({ duration: Math.min(fx.getTiming().duration, 150) });
  }
};

export const motion = {
  // THE reduced-motion dial: 0 = JS movement jumps to its end state, 1 = animate. Every JS check routes through
  // here so reduced motion is one trustworthy switch instead of 27 scattered matchMedia reads.
  get scale() { return forced ?? (osReduced().matches ? 0 : 1); },
  get gentle() { return forced == null && osReduced().matches; },   // the OS preference: drop movement, keep short fades
  force(v) { forced = v; zeroStyle(); },
  soften,   // for a JS el.animate(), which fires no event for the listeners below
  // Felt-time constants (hold-to-escalate thresholds, land timers, tween durations) route through here,
  // so a time-compressed test (force(0.25)) compresses the THRESHOLDS with the motion — semantics intact.
  // Only the forced dial scales time: OS reduced motion drops movement, not the user's thresholds.
  t(ms) { return ms * (forced ?? 1); },
  rand: Math.random,   // reward rolls draw here; a test pins it
  // A sequence: its phases play one after another, each starting when the last one's animations end. A new sequence
  // under the same key first hurries the old one to its end (every animation finishes, the rest of its phases run
  // instantly), so a second tap never overlaps the first or plays it twice. A phase gets the sequence `s` and returns
  // what it waits on (animations, promises); it reads the DOM when it runs, never before the sequence starts.
  async seq(key, ...phases) {
    const prev = seqs.get(key);
    if (prev) { prev.hurry(); await prev.done; }
    const s = { fast: false, anims: new Set(), hurry() { this.fast = true; for (const a of this.anims) a.finish(); } };
    seqs.set(key, s);
    s.done = (async () => {
      try { for (const phase of phases) await Promise.allSettled([await phase(s)].flat().map(x => x?.finished ?? x)); }
      finally { if (seqs.get(key) === s) seqs.delete(key); }
    })();
    return s.done;
  },
  // One animation through the dial (reduced motion, the test clock), joined to sequence `s` if given. `fill: 'backwards'`
  // holds its first frame through a delay, so a move set up before paint never shows its end state first.
  go(s, el, keyframes, opts) {
    if (!el) return null;
    const a = el.animate(keyframes, { fill: 'backwards', ...opts });
    soften(a);
    if (s) { s.anims.add(a); if (s.fast) a.finish(); }
    return a;
  },
  // The primitives (docs/ui/motion.md): named moves the app composes, timed by tier (design.json motion).
  // Fill: `el` grows down from its transform-origin (a line filling with colour). Set the origin in CSS.
  fill(s, el, tier = 'daily') {
    return motion.go(s, el, { scale: ['1 0', '1 1'] }, { duration: DESIGN.motion[tier], easing: DESIGN.ease['in-out'] });
  },
  // Light: `el` takes class `cls` (its colour, from CSS) and pops once.
  light(s, el, cls = 'lit', tier = 'constant') {
    el?.classList.add(cls);
    return motion.go(s, el, { scale: [.6, 1] }, { duration: DESIGN.motion[tier], easing: DESIGN.ease.spring });
  },
  // Push: the new content (`incoming`, already in place) rises `d` px into `box` while `outgoing` (a frozen copy of the
  // old, laid over it) rises out by the same `d`; `box` clips both. The old is gone before the new fades in, so two texts
  // never show at once. `carried` (the same text, moving on) rides the move unfaded. The calendar's month titles move the
  // same way, driven by scroll (_clPositionZone). Reduced motion keeps only the fades: out, then in.
  push(s, box, outgoing, incoming, d, carried = [], tier = 'daily') {
    const o = { duration: DESIGN.motion[tier], easing: DESIGN.ease.drawer }, rise = { translate: [`0 ${d}px`, '0 0'] }, fadeIn = { opacity: [0, 0, 1] };
    box.classList.add('pushing');
    const runs = [motion.go(s, outgoing, [{ translate: '0 0', opacity: 1 }, { opacity: 0, offset: .3 }, { translate: `0 ${-d}px`, opacity: 0 }], { ...o, fill: 'forwards' }),
      ...incoming.map(el => motion.go(s, el, { ...rise, ...fadeIn }, o)),
      ...carried.map(el => motion.go(s, el, { ...rise, ...motion.gentle && fadeIn }, o))];   // reduced, it can't move, so it fades in like the rest
    Promise.allSettled(runs.map(a => a?.finished)).then(() => { box.classList.remove('pushing'); outgoing?.remove(); });
    return runs;
  },
  // Register a per-frame step under a key. A new run with the same key SUPERSEDES the old one — a
  // second request never queues behind or races the first. step returns true while it stays alive.
  run(key, step) { tweens.set(key, step); if (!rafId) rafId = requestAnimationFrame(pump); },
  stop(key) { tweens.delete(key); },
  running(key) { return tweens.has(key); },
  active() {
    // detached mid-flight, its end/cancel fires where document can't hear it — whether it stays out or is re-inserted
    for (const el of css.keys()) if (!el.getAnimations({ subtree: true }).length) css.delete(el);
    for (const el of scrollers.keys()) if (el !== document && !el.isConnected) scrollers.delete(el);
    return tweens.size + css.size + scrollers.size;
  },
  // 2 clean frames: a state write's transitionrun lands a frame later, a single-frame check races it — and on a loaded
  // CPU a transition can still be pending (no event yet) past both, so the page's own finite animations count too.
  // Bounded, frames or none: a wedge rejects naming what still moves instead of hanging its caller to a test timeout.
  async idle(ms = 9000) {
    let frames = 0, clean = 0, timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`motion.idle: not idle after ${ms}ms, ${frames} frames — ${this.moving().join(', ') || 'nothing moving now'}`)), ms); });
    try {
      while (clean < 2) {
        await Promise.race([new Promise(requestAnimationFrame), late]); frames++;
        clean = this.active() || running().length ? 0 : clean + 1;
      }
    } finally { clearTimeout(timer); }
  },
  moving() {   // what holds idle(), by name
    this.active();
    const name = k => k?.nodeType === 1 ? k.tagName.toLowerCase() + [...k.classList].map(c => '.' + c).join('') : k === document ? 'document' : String(k);
    return [...[...tweens.keys()].map(k => 'tween ' + name(k)), ...[...css].map(([el, tags]) => name(el) + ' ' + [...tags].join(' ')),
      ...[...scrollers.keys()].map(k => 'scroll ' + name(k)), ...running().map(a => (a.animationName || a.transitionProperty || 'animate()') + ' on ' + name(a.effect.target))];
  },
  install() {      // called once from app boot — module stays importable without a DOM (unit tests)
    // every transition/animation IS a WAAPI Animation — soften() adjusts it as it starts (real events, adjusted clock)
    document.addEventListener('transitionrun', e => { mark(e.target, 't:' + e.propertyName); if (motion.scale !== 1) soften(animOf(e, a => a.transitionProperty === e.propertyName)); }, true);
    for (const t of ['transitionend', 'transitioncancel']) document.addEventListener(t, e => clear(e.target, 't:' + e.propertyName), true);
    document.addEventListener('animationstart', e => { if (!ambient(e)) mark(e.target, 'a:' + e.animationName); if (motion.scale !== 1) soften(animOf(e, a => a.animationName === e.animationName)); }, true);
    for (const t of ['animationend', 'animationcancel']) document.addEventListener(t, e => clear(e.target, 'a:' + e.animationName), true);
    // A layout clamp or anchoring jump fires `scroll` and NEVER `scrollend` (that wedged idle() after Lists, parked deep,
    // lost its height to Plan). A running scroll fires every frame — so one silent frame after the last event = stopped.
    // (A rAF queued during dispatch runs this same frame; the nested one runs after the NEXT frame's scroll events.)
    document.addEventListener('scroll', e => {
      const el = e.target, n = (scrollers.get(el) || 0) + 1; scrollers.set(el, n);
      requestAnimationFrame(() => requestAnimationFrame(() => { if (scrollers.get(el) === n) scrollers.delete(el); }));
    }, { capture: true, passive: true });
    document.addEventListener('scrollend', e => scrollers.delete(e.target), true);
    window.__motion = motion;   // the ONE test-facing line (spec: minimal in-app test surface)
  },
};
