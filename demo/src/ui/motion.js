// motion.js — GSAP choreography per DESIGN.md §6: "settling paper, morning
// light". Base ease power2.out, durations 600–900ms (unhurried — a colleague
// laying things on the desk, not an app rushing), stagger 80–160ms; nothing
// overshoots. prefers-reduced-motion collapses everything to simple fades.
//
// Degrades gracefully: all animations use gsap.from/fromTo, so elements sit in
// their final visible state by default — if the GSAP CDN failed to load (or
// window.gsap is missing), every function is a silent no-op and content stays
// fully visible. Content is never hidden by a failed animation.

/** @returns {Object|null} the GSAP global if the CDN script loaded */
function gsapOrNull() {
  return typeof window !== 'undefined' && window.gsap ? window.gsap : null;
}

function reducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * New message: slides in from its speaker's side — teacher from the right,
 * agent from the left — plus a small rise. Direction makes the exchange read
 * as two people passing notes across the desk (DESIGN.md §6 register 1).
 * @param {Element} node
 * @param {number} [delay] seconds
 * @param {{from?: 'left'|'right'|'up'}} [opts] slide origin (default 'up')
 */
export function messageIn(node, delay = 0, opts = {}) {
  const gsap = gsapOrNull();
  if (!gsap || !node) return;
  if (reducedMotion()) {
    gsap.from(node, { opacity: 0, duration: 0.28, delay });
    return;
  }
  const x = opts.from === 'left' ? -32 : opts.from === 'right' ? 32 : 0;
  const y = opts.from === 'up' || !opts.from ? 18 : 8;
  gsap.from(node, { opacity: 0, x, y, duration: 0.8, ease: 'power2.out', delay });
}

/**
 * Artifact card "dealt onto the desk": fade + rise 16px with a 0.5°→0°
 * rotation settle. Index staggers multiple cards from one turn.
 * @param {Element} node
 * @param {number} [index]
 */
export function cardIn(node, index = 0) {
  const gsap = gsapOrNull();
  if (!gsap || !node) return;
  const delay = index * 0.08;
  if (reducedMotion()) {
    gsap.from(node, { opacity: 0, duration: 0.28, delay });
    return;
  }
  gsap.from(node, {
    opacity: 0,
    y: 26,
    rotation: 0.8,
    transformOrigin: '50% 100%',
    duration: 0.9,
    ease: 'power2.out',
    delay,
  });
}

/**
 * Example-answer chips: stagger in left-to-right after the question renders.
 * @param {Element[]|NodeList} chips
 * @param {number} [delay] seconds before the first chip
 */
export function chipsIn(chips, delay = 0.15) {
  const gsap = gsapOrNull();
  const nodes = Array.from(chips ?? []);
  if (!gsap || !nodes.length) return;
  if (reducedMotion()) {
    gsap.from(nodes, { opacity: 0, duration: 0.28, delay, stagger: 0.07 });
    return;
  }
  gsap.from(nodes, { opacity: 0, y: 14, duration: 0.6, ease: 'power2.out', delay, stagger: 0.1 });
}

/**
 * Question cue-cards: dealt one after another with a slide from the right —
 * a hand laying cards on the desk. No-op on empty lists / reduced motion fades.
 * @param {Element[]|NodeList} cards
 * @param {number} [delay] seconds before the first card
 */
export function cardsIn(cards, delay = 0.1) {
  const gsap = gsapOrNull();
  const nodes = Array.from(cards ?? []);
  if (!gsap || !nodes.length) return;
  if (reducedMotion()) {
    gsap.from(nodes, { opacity: 0, duration: 0.28, delay, stagger: 0.08 });
    return;
  }
  gsap.from(nodes, { opacity: 0, x: 44, duration: 0.85, ease: 'power2.out', delay, stagger: 0.16 });
}

/**
 * Closure-loop rows: sequential reveal (90ms stagger) while each gold circle
 * draws its stroke in (SVG dashoffset).
 * @param {Element} card the closure card element
 */
export function closureIn(card) {
  const gsap = gsapOrNull();
  if (!gsap || !card) return;
  const rows = Array.from(card.querySelectorAll('.closure-row'));
  if (reducedMotion()) {
    gsap.from(card, { opacity: 0, duration: 0.28 });
    if (rows.length) gsap.from(rows, { opacity: 0, duration: 0.28, stagger: 0.09 });
    return;
  }
  gsap.from(card, { opacity: 0, y: 16, duration: 0.7, ease: 'power2.out' });
  if (rows.length) {
    gsap.from(rows, { opacity: 0, y: 10, duration: 0.6, ease: 'power2.out', stagger: 0.12, delay: 0.1 });
  }
  rows.forEach((row, i) => {
    const circle = row.querySelector('.gold-circle circle');
    if (!circle) return;
    const r = Number(circle.getAttribute('r')) || 12;
    const length = 2 * Math.PI * r;
    gsap.fromTo(
      circle,
      { strokeDasharray: length, strokeDashoffset: length },
      { strokeDashoffset: 0, duration: 0.8, ease: 'power2.out', delay: 0.25 + i * 0.09 },
    );
  });
}

/**
 * Quiet fade for small notes (awaiting-feedback line, error notice).
 * @param {Element} node
 * @param {number} [delay]
 */
export function fadeIn(node, delay = 0) {
  const gsap = gsapOrNull();
  if (!gsap || !node) return;
  gsap.from(node, { opacity: 0, duration: 0.32, delay });
}
