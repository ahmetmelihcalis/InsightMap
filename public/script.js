(() => {
  const reveals = document.querySelectorAll('.reveal');

  if ('IntersectionObserver' in window && reveals.length > 0) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('is-visible'));
  }

  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const id = link.getAttribute('href');
      if (!id || id === '#') return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  const header = document.querySelector('header');
  if (header) {
    let last = 0;
    window.addEventListener(
      'scroll',
      () => {
        const y = window.scrollY;
        if (y > 8 && last <= 8) header.classList.add('shadow-[0_1px_0_0_rgba(255,255,255,0.04)]');
        if (y <= 8 && last > 8) header.classList.remove('shadow-[0_1px_0_0_rgba(255,255,255,0.04)]');
        last = y;
      },
      { passive: true }
    );
  }
})();
