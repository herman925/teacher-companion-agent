// motion.js — GSAP choreography per DESIGN.md §6: "settling paper, morning
// light". Base ease power2.out, durations 280–420ms, stagger 60–80ms; nothing
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
 * New message (agent or teacher): rise 12px + fade in.
 * @param {Element} node
 * @param {number} [delay] seconds
 */
export function messageIn(node, delay = 0) {
  const gsap = gsapOrNull();
  if (!gsap || !node) return;
  if (reducedMotion()) {
    gsap.from(node, { opacity: 0, duration: 0.28, delay });
    return;
  }
  gsap.from(node, { opacity: 0, y: 12, duration: 0.36, ease: 'power2.out', delay });
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
    y: 16,
    rotation: 0.5,
    transformOrigin: '50% 100%',
    duration: 0.42,
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
  gsap.from(nodes, { opacity: 0, y: 8, duration: 0.3, ease: 'power2.out', delay, stagger: 0.07 });
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
  gsap.from(card, { opacity: 0, y: 16, duration: 0.38, ease: 'power2.out' });
  if (rows.length) {
    gsap.from(rows, { opacity: 0, y: 10, duration: 0.34, ease: 'power2.out', stagger: 0.09, delay: 0.1 });
  }
  rows.forEach((row, i) => {
    const circle = row.querySelector('.gold-circle circle');
    if (!circle) return;
    const r = Number(circle.getAttribute('r')) || 12;
    const length = 2 * Math.PI * r;
    gsap.fromTo(
      circle,
      { strokeDasharray: length, strokeDashoffset: length },
      { strokeDashoffset: 0, duration: 0.5, ease: 'power2.out', delay: 0.18 + i * 0.09 },
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
