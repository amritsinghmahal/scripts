// ==UserScript==
// @name         Hotstar Zoom to Fill
// @namespace    hotstar-zoom-fill
// @version      1.0
// @description  Remove black bars on Hotstar. Z = toggle, [ and ] = zoom more/less, scroll on button = zoom
// @match        *://*.hotstar.com/*
// @match        *://*.jiohotstar.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  let on = localStorage.getItem('tmFillOn') === '1';
  let zoom = parseFloat(localStorage.getItem('tmFillZoom')) || 1;
  let hideTimer;

  const style = document.createElement('style');
  style.textContent = `
    html.tm-fill-on video {
      object-fit: cover !important;
      width: 100% !important;
      height: 100% !important;
      transform: scale(var(--tm-zoom, 1)) !important;
      transform-origin: center center !important;
    }
    html.tm-fill-on *:has(> video) {
      overflow: hidden !important;
    }
    #tm-fill-btn {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 2147483647;
      padding: 6px 12px;
      font: 600 13px sans-serif;
      color: #fff;
      background: rgba(0, 0, 0, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.4);
      border-radius: 6px;
      cursor: pointer;
      transition: opacity 0.3s;
    }
  `;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'tm-fill-btn';

  function apply() {
    document.documentElement.classList.toggle('tm-fill-on', on);
    document.documentElement.style.setProperty('--tm-zoom', zoom);
    if (on) {
      btn.textContent = 'Fill ON · ' + Math.round(zoom * 100) + '%';
    } else {
      btn.textContent = 'Fill OFF';
    }
    localStorage.setItem('tmFillOn', on ? '1' : '0');
    localStorage.setItem('tmFillZoom', zoom);
  }

  function showBtn() {
    btn.style.opacity = '1';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      btn.style.opacity = '0';
    }, 3000);
  }

  function toggle() {
    on = !on;
    apply();
    showBtn();
  }

  function changeZoom(step) {
    if (!on) return;
    zoom = Math.round((zoom + step) * 100) / 100;
    if (zoom < 1) zoom = 1;
    if (zoom > 2) zoom = 2;
    apply();
    showBtn();
  }

  function placeBtn() {
    let parent = document.fullscreenElement || document.body;
    if (parent.tagName === 'VIDEO') parent = document.body;
    if (btn.parentElement !== parent) parent.appendChild(btn);
  }

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    toggle();
  });

  btn.addEventListener('wheel', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.deltaY < 0) changeZoom(0.05);
    else changeZoom(-0.05);
  }, { passive: false });

  window.addEventListener('keydown', function (e) {
    const t = e.target;
    if (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'z' || e.key === 'Z') toggle();
    else if (e.key === ']') changeZoom(0.05);
    else if (e.key === '[') changeZoom(-0.05);
    else return;

    e.preventDefault();
    e.stopPropagation();
  }, true);

  document.addEventListener('mousemove', showBtn);
  document.addEventListener('fullscreenchange', placeBtn);

  setInterval(function () {
    placeBtn();
    if (document.querySelector('video')) btn.style.display = 'block';
    else btn.style.display = 'none';
  }, 1000);

  apply();
  placeBtn();
  showBtn();
})();
