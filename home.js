// Homepage only: the screenshot viewer, its enlarged view and links that open a question.
(function () {
  var screens = {
    input: {
      alt: 'HIDUSBF Input tab for a DualSense Edge: the controller picture, polling rate buttons set to 8000, filter switches and live stick readings.',
      caption: 'Input: the polling rate, the filter switches and live stick readings.'
    },
    calibration: {
      alt: 'HIDUSBF Calibration tab: a note that changes are temporary, Smart calibration, manual center, range and fine-tune tools, and a list of past snapshots to restore.',
      caption: 'Calibration: Smart and manual tools, with snapshots you can restore.'
    },
    customize: {
      alt: 'HIDUSBF Customize tab: light bar colors, player and mute LEDs, trigger resistance and a rumble test.',
      caption: 'Customize: lights, trigger resistance and a rumble test.'
    },
    welcome: {
      alt: 'HIDUSBF welcome screen with the app icon, a short introduction and buttons to take the tour or skip it.',
      caption: 'Welcome: a first-start screen that offers a short tour.'
    }
  };

  var tabs = Array.prototype.slice.call(document.querySelectorAll('.h-tabs [role=tab]'));
  var panel = document.getElementById('h-panel');
  var image = document.getElementById('h-screen');
  var caption = document.getElementById('h-caption-text');

  function select(key) {
    if (!screens[key]) return;
    tabs.forEach(function (tab) {
      var on = tab.dataset.screen === key;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
    });
    image.src = 'assets/app/' + key + '.png';
    image.alt = screens[key].alt;
    caption.textContent = screens[key].caption;
    panel.setAttribute('aria-labelledby', 'tab-' + key);
  }

  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { select(tab.dataset.screen); });
    tab.addEventListener('keydown', function (e) {
      var next = null;
      if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
      if (e.key === 'ArrowLeft') next = (i + tabs.length - 1) % tabs.length;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = tabs.length - 1;
      if (next === null) return;
      e.preventDefault();
      select(tabs[next].dataset.screen);
      tabs[next].focus();
    });
  });

  // "See the ... tab" links scroll to the viewer through their href; this picks the matching tab.
  document.querySelectorAll('.h-link[data-target]').forEach(function (link) {
    link.addEventListener('click', function () { select(link.dataset.target); });
  });

  var dialog = document.getElementById('h-lightbox');
  var large = document.getElementById('h-lightbox-img');
  document.getElementById('h-expand').addEventListener('click', function () {
    large.src = image.src;
    large.alt = image.alt;
    dialog.showModal();
  });
  document.getElementById('h-lightbox-close').addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });

  // A link to a question opens it, whether clicked here or arriving with the address.
  function openTarget() {
    var el = location.hash && document.getElementById(location.hash.slice(1));
    if (el && el.tagName === 'DETAILS') el.open = true;
  }
  window.addEventListener('hashchange', openTarget);
  document.querySelectorAll('[data-open-faq]').forEach(function (link) {
    link.addEventListener('click', function () {
      document.getElementById(link.getAttribute('href').slice(1)).open = true;
    });
  });
  openTarget();
})();
