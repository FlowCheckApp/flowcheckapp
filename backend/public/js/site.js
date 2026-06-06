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
