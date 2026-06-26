/* ============================================================
   PayPulse — pixel sprites + prototype runtime
   - bitmap sprite renderer (coins / bill / coin-buddy mascot)
   - pixel icon set (currentColor)
   - i18n (zh/en) + theme + helpers
   - CoinFlow engine: the signature "money floating in" effect
   ============================================================ */

/* ---------- bitmap renderer ---------- */
function pixmap(rows, pal, scale = 3, cls = '') {
  const w = rows[0].length, h = rows.length;
  let r = '';
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const f = pal[ch];
      if (f) r += `<rect x="${x}" y="${y}" width="1" height="1" fill="${f}"/>`;
    });
  });
  return `<svg class="sprite ${cls}" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${r}</svg>`;
}

const PAL_COIN = { '.': null, o: '#c75e3a', g: '#ffcd75', d: '#e0a52a', G: '#fff6d0', e: '#1a1c2c', m: '#c75e3a' };
const PAL_BILL = { '.': null, o: '#1c6b3a', g: '#38b764', l: '#a7f070', w: '#e8ffe9', s: '#16633a' };
const PAL_STACK = { '.': null, o: '#0e3320', g: '#2fae5a', d: '#1c6b3a', l: '#86e69b', b: '#f0e6c0' };

/* shiny coin (flying) 8x8 */
const COIN8 = [
  '..oooo..',
  '.oGggdo.',
  'oGgggddo',
  'ogggdddo',
  'ogggdddo',
  'oggddddo',
  '.oddddo.',
  '..oooo..',
];
/* banknote 12x8 */
const BILL = [
  'oooooooooooo',
  'olgggggggglo',
  'ogwsllllswgo',
  'oglw.ww.wlgo',
  'oglw.ww.wlgo',
  'ogwsllllswgo',
  'olgggggggglo',
  'oooooooooooo',
];
/* coin-buddy mascot 11x11 (eyes + smile) */
const BUDDY = [
  '...ooooo...',
  '.ooGgggGoo.',
  'oGgggggggdo',
  'oGgggggggdo',
  'oggegggeggo',
  'oggggggggdo',
  'oggggggggdo',
  'oggmmmmmgdo',
  'oggggggggdo',
  '.oodddddoo.',
  '...ooooo...',
];
/* blinking buddy (eyes closed) */
const BUDDY_BLINK = [
  '...ooooo...',
  '.ooGgggGoo.',
  'oGgggggggdo',
  'oGgggggggdo',
  'oggmgggmggo',
  'oggggggggdo',
  'oggggggggdo',
  'oggmmmmmgdo',
  'oggggggggdo',
  '.oodddddoo.',
  '...ooooo...',
];

/* a banded stack/wad of US dollar bills (greenback) 14x12 */
const STACK = [
  '.oooooooooooo.',
  '.ogggggggggdo.',
  '.ollllllllldo.',
  '.obbbbbbbbbbo.',
  '.obbbbbbbbbbo.',
  '.oggggggggddo.',
  '.ollllllllldo.',
  '.oooooooooooo.',
  '.oddddddddddo.',
  '.ogggggggggdo.',
  '.oddddddddddo.',
  '.oooooooooooo.',
];

const SPRITE = {
  coin: (s = 3, c = '') => pixmap(COIN8, PAL_COIN, s, c),
  bill: (s = 3, c = '') => pixmap(BILL, PAL_BILL, s, c),
  buddy: (s = 4, c = '') => pixmap(BUDDY, PAL_COIN, s, c),
  buddyBlink: (s = 4, c = '') => pixmap(BUDDY_BLINK, PAL_COIN, s, c),
  stack: (s = 2, c = '') => pixmap(STACK, PAL_STACK, s, c),
};

/* ---------- pixel icons (inherit currentColor) ---------- */
const ICONS = {
  play: '<polygon points="4,3 4,13 13,8" fill="currentColor"/>',
  pause: '<rect x="4" y="3" width="3" height="10" fill="currentColor"/><rect x="9" y="3" width="3" height="10" fill="currentColor"/>',
  stop: '<rect x="4" y="4" width="8" height="8" fill="currentColor"/>',
  settings: '<rect x="2" y="4" width="12" height="2" fill="currentColor"/><rect x="9" y="2" width="3" height="6" fill="currentColor"/><rect x="2" y="10" width="12" height="2" fill="currentColor"/><rect x="4" y="8" width="3" height="6" fill="currentColor"/>',
  chart: '<rect x="2" y="9" width="3" height="4" fill="currentColor"/><rect x="6" y="5" width="3" height="8" fill="currentColor"/><rect x="10" y="7" width="3" height="6" fill="currentColor"/><rect x="2" y="13" width="12" height="1" fill="currentColor"/>',
  bell: '<rect x="6" y="2" width="4" height="2" fill="currentColor"/><rect x="4" y="4" width="8" height="6" fill="currentColor"/><rect x="3" y="10" width="10" height="2" fill="currentColor"/><rect x="7" y="13" width="2" height="2" fill="currentColor"/>',
  power: '<rect x="7" y="2" width="2" height="6" fill="currentColor"/><rect x="4" y="5" width="2" height="2" fill="currentColor"/><rect x="10" y="5" width="2" height="2" fill="currentColor"/><rect x="3" y="7" width="2" height="4" fill="currentColor"/><rect x="11" y="7" width="2" height="4" fill="currentColor"/><rect x="5" y="11" width="6" height="2" fill="currentColor"/>',
  moon: '<rect x="5" y="2" width="6" height="2" fill="currentColor"/><rect x="4" y="4" width="3" height="8" fill="currentColor"/><rect x="4" y="12" width="6" height="2" fill="currentColor"/><rect x="7" y="4" width="2" height="2" fill="currentColor"/>',
  sun: '<rect x="6" y="6" width="4" height="4" fill="currentColor"/><rect x="7" y="2" width="2" height="2" fill="currentColor"/><rect x="7" y="12" width="2" height="2" fill="currentColor"/><rect x="2" y="7" width="2" height="2" fill="currentColor"/><rect x="12" y="7" width="2" height="2" fill="currentColor"/><rect x="3" y="3" width="2" height="2" fill="currentColor"/><rect x="11" y="3" width="2" height="2" fill="currentColor"/><rect x="3" y="11" width="2" height="2" fill="currentColor"/><rect x="11" y="11" width="2" height="2" fill="currentColor"/>',
  globe: '<rect x="5" y="2" width="6" height="2" fill="currentColor"/><rect x="3" y="4" width="10" height="2" fill="currentColor"/><rect x="2" y="6" width="12" height="4" fill="currentColor"/><rect x="3" y="10" width="10" height="2" fill="currentColor"/><rect x="5" y="12" width="6" height="2" fill="currentColor"/><rect x="7" y="2" width="2" height="12" fill="#1a1c2c"/><rect x="2" y="7" width="12" height="2" fill="#1a1c2c"/>',
  plus: '<rect x="6" y="2" width="4" height="12" fill="currentColor"/><rect x="2" y="6" width="12" height="4" fill="currentColor"/>',
  minus: '<rect x="2" y="6" width="12" height="4" fill="currentColor"/>',
  pin: '<rect x="6" y="2" width="4" height="7" fill="currentColor"/><rect x="3" y="8" width="10" height="2" fill="currentColor"/><rect x="7" y="10" width="2" height="4" fill="currentColor"/>',
  minimize: '<rect x="3" y="11" width="10" height="2" fill="currentColor"/>',
  close: '<rect x="3" y="3" width="2" height="2" fill="currentColor"/><rect x="5" y="5" width="2" height="2" fill="currentColor"/><rect x="7" y="7" width="2" height="2" fill="currentColor"/><rect x="9" y="5" width="2" height="2" fill="currentColor"/><rect x="11" y="3" width="2" height="2" fill="currentColor"/><rect x="9" y="9" width="2" height="2" fill="currentColor"/><rect x="11" y="11" width="2" height="2" fill="currentColor"/><rect x="5" y="9" width="2" height="2" fill="currentColor"/><rect x="3" y="11" width="2" height="2" fill="currentColor"/>',
  fire: '<rect x="7" y="2" width="2" height="3" fill="currentColor"/><rect x="6" y="4" width="4" height="2" fill="currentColor"/><rect x="5" y="6" width="6" height="5" fill="currentColor"/><rect x="4" y="8" width="8" height="4" fill="currentColor"/><rect x="6" y="11" width="4" height="2" fill="#ffcd75"/>',
};
function icon(name, size = 16, cls = '') {
  return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${ICONS[name] || ''}</svg>`;
}

/* ---------- i18n ---------- */
const I18N = {
  app: { zh: '薪跳', en: 'PayPulse' },
  today: { zh: '今日已赚', en: 'EARNED TODAY' },
  perSec: { zh: '每秒进账', en: 'PER SECOND' },
  rate: { zh: '时薪', en: 'HOURLY' },
  start: { zh: '上班', en: 'CLOCK IN' },
  pause: { zh: '摸鱼', en: 'PAUSE' },
  resume: { zh: '继续', en: 'RESUME' },
  stop: { zh: '下班', en: 'CLOCK OUT' },
  working: { zh: '搬砖中', en: 'WORKING' },
  paused: { zh: '摸鱼中', en: 'PAUSED' },
  idle: { zh: '待机', en: 'IDLE' },
  session: { zh: '本次时长', en: 'SESSION' },
  week: { zh: '本周', en: 'THIS WEEK' },
  month: { zh: '本月', en: 'THIS MONTH' },
  total: { zh: '累计', en: 'ALL TIME' },
  goal: { zh: '今日目标', en: 'DAILY GOAL' },
  settings: { zh: '设置', en: 'SETTINGS' },
  salary: { zh: '月薪', en: 'MONTHLY SALARY' },
  hours: { zh: '每日工时', en: 'HOURS / DAY' },
  workdays: { zh: '月工作天数', en: 'WORKDAYS / MO' },
  pay_model: { zh: '薪资模型', en: 'PAY MODEL' },
  appearance: { zh: '外观', en: 'APPEARANCE' },
  opacity: { zh: '小窗透明度', en: 'WINDOW OPACITY' },
  decimals: { zh: '小数位数', en: 'DECIMALS' },
  decimals_desc: { zh: '首屏金额小数点后位数', en: 'Fraction digits on the counter' },
  theme: { zh: '主题', en: 'THEME' },
  lang: { zh: '语言', en: 'LANGUAGE' },
  notify: { zh: '里程碑通知', en: 'MILESTONE ALERTS' },
  autostart: { zh: '开机自启', en: 'LAUNCH ON START' },
  overtime: { zh: '加班倍率', en: 'OVERTIME RATE' },
  notify_desc: { zh: '每赚到整数金额提醒一次', en: 'Ping on each round milestone' },
  auto_desc: { zh: '登录系统时自动驻留状态栏', en: 'Run in tray at login' },
  ot_desc: { zh: '超出每日工时后的费率倍数', en: 'Multiplier past daily hours' },
  trend: { zh: '近 7 日趋势', en: '7-DAY TREND' },
  milestone: { zh: '达成里程碑！', en: 'MILESTONE!' },
  coffee: { zh: '≈ 一杯咖啡', en: '≈ one coffee' },
  save: { zh: '保存', en: 'SAVE' },
  monthly: { zh: '月薪制', en: 'MONTHLY' },
  hourly: { zh: '时薪制', en: 'HOURLY' },
  yearly: { zh: '年薪制', en: 'YEARLY' },
};
function t(k, lang) { return (I18N[k] && I18N[k][lang]) || k; }
function applyI18n(lang) {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n, lang); });
  document.documentElement.setAttribute('data-lang', lang);
}

/* ---------- money fmt (configurable decimals, carry-safe) ---------- */
function splitMoney(n, decimals = 2) {
  let whole = Math.floor(n);
  const f = Math.pow(10, decimals);
  let frac = Math.round((n - whole) * f);
  if (frac >= f) { whole += 1; frac -= f; }          // carry on rounding edge (e.g. .9996 → +1)
  const dec = decimals > 0 ? frac.toString().padStart(decimals, '0') : '';
  return { whole: whole.toLocaleString('en-US'), dec };
}

/* ---------- CoinFlow: the "money floating in" engine ---------- */
/* Spawns pixel coins/bills from edges that arc toward a target and absorb. */
function CoinFlow(stage, target, opt = {}) {
  const o = Object.assign({ minGap: 220, maxGap: 620, scale: 3, billChance: 0.18, edges: [0, 1, 2, 3] }, opt);
  let timer = null, alive = true;

  function center(el) {
    const s = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 };
  }
  function spawn() {
    if (!alive) return;
    const tgt = center(typeof target === 'function' ? target() : target);
    const sb = stage.getBoundingClientRect();
    const edge = o.edges[Math.floor(Math.random() * o.edges.length)];
    let sx, sy;
    if (edge === 0) { sx = Math.random() * sb.width; sy = -16; }
    else if (edge === 1) { sx = sb.width + 16; sy = Math.random() * sb.height; }
    else if (edge === 2) { sx = Math.random() * sb.width; sy = sb.height + 16; }
    else { sx = -16; sy = Math.random() * sb.height; }

    const isBill = Math.random() < o.billChance;
    const el = document.createElement('div');
    el.className = 'coinflow';
    el.innerHTML = isBill ? SPRITE.bill(o.scale) : SPRITE.coin(o.scale);
    el.style.cssText = `position:absolute;left:0;top:0;will-change:transform,opacity;z-index:8;`;
    stage.appendChild(el);

    const apexX = (sx + tgt.x) / 2 + (Math.random() * 40 - 20);
    const apexY = Math.min(sy, tgt.y) - (40 + Math.random() * 40);
    const dur = 820 + Math.random() * 620;
    const anim = el.animate(
      [
        { transform: `translate(${sx}px,${sy}px) scale(1)`, opacity: 0 },
        { transform: `translate(${apexX}px,${apexY}px) scale(1.1)`, opacity: 1, offset: 0.45 },
        { transform: `translate(${tgt.x}px,${tgt.y}px) scale(.5)`, opacity: 0 },
      ],
      { duration: dur, easing: 'cubic-bezier(.4,.05,.6,1)', fill: 'forwards' }
    );
    /* pixel spin */
    el.firstChild.style.animation = `spin3d ${260 + Math.random() * 200}ms steps(1) infinite`;
    anim.onfinish = () => { el.remove(); pop(tgt); };
  }
  function pop(tgt) {
    const s = document.createElement('div');
    s.className = 'absorb';
    s.style.cssText = `position:absolute;left:${tgt.x}px;top:${tgt.y}px;width:10px;height:10px;margin:-5px;
      background:var(--gain);z-index:9;animation:pulseRing .4s steps(4) forwards;`;
    stage.appendChild(s);
    setTimeout(() => s.remove(), 420);
  }
  function loop() {
    if (!alive) return;
    spawn();
    timer = setTimeout(loop, o.minGap + Math.random() * (o.maxGap - o.minGap));
  }
  return {
    start() { alive = true; loop(); },
    burst(n = 6) { for (let i = 0; i < n; i++) setTimeout(spawn, i * 80); },
    stop() { alive = false; clearTimeout(timer); },
  };
}

/* ---------- hold-to-confirm: long-press a button to fire (anti mis-tap) ---------- */
function holdToConfirm(btn, opts = {}) {
  const ms = opts.ms || 800;
  let fill = btn.querySelector('.hold-fill');
  if (!fill) { fill = document.createElement('i'); fill.className = 'hold-fill'; btn.insertBefore(fill, btn.firstChild); }
  let anim = null;
  const reset = () => { btn.classList.remove('holding'); if (anim) { anim.cancel(); anim = null; } };
  const start = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    btn.classList.add('holding');
    anim = fill.animate([{ width: '0%' }, { width: '100%' }], { duration: ms, easing: 'linear', fill: 'forwards' });
    anim.onfinish = () => {
      btn.classList.remove('holding'); btn.classList.add('confirmed');
      setTimeout(() => { btn.classList.remove('confirmed'); if (anim) { anim.cancel(); anim = null; } }, 460);
      opts.onConfirm && opts.onConfirm();
    };
    try { btn.setPointerCapture(e.pointerId); } catch (_) {}
  };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', reset);
  btn.addEventListener('pointercancel', reset);
  btn.addEventListener('pointerleave', reset);
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); }); // single tap does nothing
}

/* ---------- inject sprite defs sheet hint ---------- */
window.PixelKit = { pixmap, SPRITE, icon, applyI18n, t, splitMoney, CoinFlow, ICONS, holdToConfirm };
