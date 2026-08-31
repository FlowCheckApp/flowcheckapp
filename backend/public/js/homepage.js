document.documentElement.classList.add('js');

document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.querySelector('[data-nav-toggle]');
  const menu = document.querySelector('[data-mobile-nav]');

  const setMenu = (open) => {
    if (!toggle || !menu) return;
    toggle.setAttribute('aria-expanded', String(open));
    menu.dataset.open = String(open);
    document.body.style.overflow = open ? 'hidden' : '';
  };

  toggle?.addEventListener('click', () => {
    setMenu(toggle.getAttribute('aria-expanded') !== 'true');
  });

  menu?.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => setMenu(false));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setMenu(false);
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 880) setMenu(false);
  });

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reveals = document.querySelectorAll('.reveal');

  if (reducedMotion || !('IntersectionObserver' in window)) {
    reveals.forEach((element) => element.classList.add('is-visible'));
  } else {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });

    reveals.forEach((element) => observer.observe(element));
  }

  const supportSearch = document.querySelector('[data-support-search]');
  const supportEmpty = document.querySelector('[data-support-empty]');

  supportSearch?.addEventListener('input', () => {
    const query = supportSearch.value.trim().toLocaleLowerCase();
    let visibleCount = 0;

    document.querySelectorAll('[data-support-group]').forEach((group) => {
      let groupCount = 0;

      group.querySelectorAll('[data-support-item]').forEach((item) => {
        const matches = !query || item.textContent.toLocaleLowerCase().includes(query);
        item.hidden = !matches;
        if (matches) groupCount += 1;
      });

      group.hidden = groupCount === 0;
      visibleCount += groupCount;
    });

    if (supportEmpty) supportEmpty.hidden = visibleCount !== 0;
  });
});
