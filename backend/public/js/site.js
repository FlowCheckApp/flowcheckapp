/**
 * FlowCheck Website — Shared JavaScript
 * Scroll animations, mobile menu, active nav state
 */
(function () {
  'use strict';

  // ── Active nav link ───────────────────────────────────────────
  const path = window.location.pathname;
  document.querySelectorAll('.nav-links a:not(.nav-cta)').forEach(a => {
    const href = a.getAttribute('href');
    if (href && href !== '/' && path.startsWith(href)) {
      a.classList.add('nav-active');
    }
  });

  // ── Mobile menu toggle ────────────────────────────────────────
  const menuBtn = document.getElementById('nav-menu-btn');
  const navLinks = document.getElementById('nav-links');
  if (menuBtn && navLinks) {
    menuBtn.addEventListener('click', () => {
      const open = navLinks.classList.toggle('nav-links--open');
      menuBtn.setAttribute('aria-expanded', open);
    });
    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.nav-inner')) {
        navLinks.classList.remove('nav-links--open');
      }
    });
  }

  // ── Scroll-triggered reveal animations ───────────────────────
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -48px 0px' });

  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

  // ── Count-up stats ────────────────────────────────────────────
  // Elements carry data-count / data-suffix and ship with a static "0"
  // fallback. Nothing had ever read those attributes, so the stats bar
  // advertised "0+ Banks supported" to every visitor. Animates once, on
  // first scroll into view; respects reduced-motion by jumping to the
  // final value rather than not rendering it.
  const counters = document.querySelectorAll('[data-count]');
  if (counters.length) {
    const reduce = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const render = (el, v) =>
      el.textContent = Math.round(v).toLocaleString() + (el.dataset.suffix || '');

    const run = (el) => {
      const target = parseFloat(el.dataset.count) || 0;
      if (reduce) return render(el, target);
      const dur = 1600;
      let startTs = null;
      const ease = t => 1 - Math.pow(1 - t, 3);
      const tick = (ts) => {
        if (startTs === null) startTs = ts;
        const t = Math.min((ts - startTs) / dur, 1);
        render(el, ease(t) * target);
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    const countObs = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        run(e.target);
        countObs.unobserve(e.target);
      });
    }, { threshold: 0.5 });

    counters.forEach(el => countObs.observe(el));
  }

  // ── Smooth nav background on scroll ──────────────────────────
  const nav = document.querySelector('.nav');
  if (nav) {
    const onScroll = () => {
      nav.classList.toggle('nav--scrolled', window.scrollY > 40);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
})();
