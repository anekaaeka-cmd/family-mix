// Интерфейс «Семейного микса»: экраны, карта, викторина, сеть.
import { Bus, LocalBus, secureOK } from './net.js';
import { HostGame } from './game.js';
import { BOARD, CITIES, EVENTS, AVATARS, SECRET_AVATARS, CATS } from './data.js';
import { GEO } from './map-geo.js';
import { play, unlockAudio, sfx, setMuted } from './sfx.js';
import { sha256, bytesToHex } from '../vendor/nostr-sign.min.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);
const LOCAL = params.get('local') === '1';            // тестовый режим без интернета (вкладки одного браузера)
const FAST = params.get('fast') === '1';              // ускоренные анимации для автотестов
const store = {
  get(k, d) { try { const v = localStorage.getItem('fm_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('fm_' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('fm_' + k); } catch {} },
};
const AUTHOR_HASHES = ['edf65f0a0fd9bc65db0699d6e198fb8d57648e261d3a34a901e18fd625f8cb0c', '751862e261ad40cf30f8307c9850f86b2627a2d098fa81d715b363185ff01d8c'];
const T = FAST ? { dice: 250, step: 60, land: 120, event: 500, reveal: 1200, grace: 800 } : { dice: 1300, step: 330, land: 500, event: 2800, reveal: 6500, grace: 1800 };

// ---------- состояние приложения ----------
const me = {
  id: sessionStorage.getItem('fm_cid_s') || store.get('cid', null),
  name: store.get('name', ''), av: store.get('av', ''),
};
if (!me.id) { me.id = 'p' + Math.random().toString(36).slice(2, 10); store.set('cid', me.id); }
if (params.get('newid') === '1') { me.id = 'p' + Math.random().toString(36).slice(2, 10); sessionStorage.setItem('fm_cid_s', me.id); }

let role = null;          // 'host' | 'client'
let bus = null, game = null, S = null, boot = null, lastV = -1;
let pendingAfterProfile = null;
let joinCode = '';
let hostLost = null, pingTimer = null, helloTimer = null, bcastTimer = null, presenceTimer = null, wakeLock = null;
const seen = { dice: 0, event: 0, quiz: 0, reveal: 0, phase: null, turnSound: null };
const anim = { id: null, pos: null, until: 0 };
let quizLocal = null;     // { n, start, picked, sentMs }
window.FM = { get S() { return S; }, me, get role() { return role; }, get game() { return game; } }; // для отладки/тестов

// ---------- экраны ----------
const SCREENS = ['scrHome', 'scrProfile', 'scrJoin', 'scrLobby', 'scrGame'];
function show(id) {
  SCREENS.forEach(s => $(s).classList.toggle('hidden', s !== id));
  $('btnHome').classList.toggle('hidden', id === 'scrHome');
  window.scrollTo(0, 0);
}
function toast(t, ms = 2500) { const el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), ms); }
function modal(html) { $('modalBody').innerHTML = html; $('ovModal').classList.remove('hidden'); document.querySelector('#ovModal .card').scrollTop = 0; }
function closeModal() { $('ovModal').classList.add('hidden'); }
$('modalClose').onclick = closeModal;
function rain(ch = '🍩', n = 28) {
  const box = $('rain');
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span'); s.textContent = Array.isArray(ch) ? ch[i % ch.length] : ch;
    s.style.left = Math.random() * 100 + 'vw'; s.style.animationDuration = 2 + Math.random() * 2.5 + 's'; s.style.animationDelay = Math.random() * 1.2 + 's';
    box.appendChild(s); setTimeout(() => s.remove(), 6000);
  }
}
document.addEventListener('pointerdown', unlockAudio, { capture: true });
function updMute() { $('btnMute').textContent = sfx.muted ? '🔇' : '🔊'; }
$('btnMute').onclick = () => { setMuted(!sfx.muted); updMute(); play.click(); };
updMute();

// ---------- главная ----------
function refreshHome() {
  $('authorLine').textContent = 'Автор игры: ' + (store.get('author', 'Аниса') || 'Аниса');
  const saved = store.get('hostSave', null);
  $('btnResume').classList.toggle('hidden', !(saved && Date.now() - saved.t < 6 * 3600e3 && saved.snap.s.phase !== 'lobby'));
  if (saved) $('btnResume').textContent = `↩️ Вернуться в игру ${saved.snap.s.code}`;
}
$('btnHome').onclick = () => {
  if ((role && S && S.phase !== 'lobby' && S.phase !== 'end') && !confirm('Выйти из игры?')) return;
  leaveRoom(); show('scrHome'); refreshHome();
};
$('btnCreate').onclick = () => needProfile(createRoom);
$('btnJoin').onclick = () => needProfile(() => { show('scrJoin'); $('inpCode').focus(); });
$('btnResume').onclick = () => needProfile(resumeRoom);
$('btnHow').onclick = () => modal(`<h2>Как играть ❓</h2><ol>
<li>Один человек нажимает <b>«Создать комнату»</b> и говорит всем <b>код из 6 цифр</b> (или отправляет ссылку кнопкой «Позвать родных»).</li>
<li>Остальные нажимают <b>«Войти по коду»</b> на своих телефонах — Samsung, iPhone, планшет или компьютер.</li>
<li>Все по очереди бросают кубик 🎲 и путешествуют по карте Казахстана.</li>
<li>Попал в город — получаешь <b>значок города</b> (+100), а <b>все</b> отвечают на вопрос. Чем быстрее правильный ответ, тем больше очков!</li>
<li>Клетки-сюрпризы: баурсаки 🍩, конь 🐎, беркут 🦅 и другие.</li>
<li>Кто наберёт больше всех очков за все круги — победил! 🏆</li></ol>
<p>👶 Для малышей: у каждого вопроса есть картинка, а кнопка 🔈 читает вопрос вслух.</p>`);

// ---------- профиль ----------
function unlockedAvatars() { return store.get('secretAv', []); }
function renderAvatars() {
  const list = [...AVATARS, ...SECRET_AVATARS.filter(a => unlockedAvatars().includes(a))];
  $('avatarGrid').innerHTML = list.map(a => `<button data-a="${a}" class="${a === me.av ? 'sel' : ''} ${SECRET_AVATARS.includes(a) ? 'secret' : ''}">${a}</button>`).join('');
}
$('avatarGrid').onclick = e => { const b = e.target.closest('button'); if (!b) return; me.av = b.dataset.a; play.click(); renderAvatars(); };
function needProfile(next) {
  if (!secureOK() && !LOCAL) { modal('<h2>Нужна безопасная ссылка 🔒</h2><p>Открой игру по адресу, который начинается с <b>https://</b>.</p>'); return; }
  pendingAfterProfile = next;
  $('inpName').value = me.name; if (!me.av) me.av = AVATARS[Math.floor(Math.random() * AVATARS.length)];
  renderAvatars(); show('scrProfile');
}
$('btnProfileOk').onclick = () => {
  const name = $('inpName').value.trim().replace(/\s+/g, ' ').slice(0, 14);
  if (!name) { toast('Напиши своё имя 🙂'); $('inpName').focus(); return; }
  // пасхалка: Хот-Дог
  if (/^х[оa]т[\s-]?д[оo]г$/i.test(name) && !unlockedAvatars().includes('🌭')) {
    store.set('secretAv', [...unlockedAvatars(), '🌭']); me.av = '🌭'; rain('🌭', 30); play.dombra(); toast('Секретный герой Хот-Дог открыт! 🌭', 3500);
  }
  me.name = name; store.set('name', name); store.set('av', me.av);
  play.click();
  const f = pendingAfterProfile; pendingAfterProfile = null; f && f();
};
$('inpName').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnProfileOk').click(); });

// пасхалка: 7 нажатий на солнце
let sunTaps = 0, sunT = 0;
$('logoSun').onclick = () => {
  const now = Date.now(); sunTaps = now - sunT < 900 ? sunTaps + 1 : 1; sunT = now;
  play.tick();
  if (sunTaps >= 7) {
    sunTaps = 0; rain(['🍩', '🍎', '🐆', '⭐', '🍩'], 40); play.dombra();
    if (!unlockedAvatars().includes('🐆')) { store.set('secretAv', [...unlockedAvatars(), '🐆']); toast('Ты нашёл(ла) секрет! Открыт герой Снежный барс 🐆', 4000); }
    else toast('Баурсачный дождь! 🍩🍩🍩');
  }
};

// ---------- сеть ----------
function makeBus(code, onMessage) {
  const B = LOCAL ? LocalBus : Bus;
  return new B({ code, myId: me.id, onMessage, onStatus: (n, total) => {
    const p = $('netPill'); p.classList.remove('hidden');
    p.textContent = (n ? '📶 ' : '⚠️ ') + n + '/' + total; p.classList.toggle('bad', n === 0);
    p.title = n ? 'Связь есть' : 'Нет связи — проверь интернет';
  } });
}
function leaveRoom() {
  [pingTimer, helloTimer, bcastTimer, presenceTimer].forEach(t => { clearInterval(t); clearTimeout(t); });
  if (bus) bus.close(); bus = null;
  if (game) clearTimeout(game.timer); game = null;
  role = null; S = null; lastV = -1; boot = null; quizLocal = null;
  Object.assign(seen, { dice: 0, event: 0, quiz: 0, reveal: 0, phase: null, turnSound: null });
  anim.id = null; anim.pos = null; tokLayer = null;
  $('netPill').classList.add('hidden');
  ['ovDice', 'ovEvent', 'ovQuiz', 'ovEnd'].forEach(o => $(o).classList.add('hidden'));
  speechSynthesis && speechSynthesis.cancel && speechSynthesis.cancel();
  releaseWake();
}
async function wake() { try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => { wakeLock = null; }; } } catch {} }
function releaseWake() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && role) { wake(); if (role === 'client' && bus) bus.send({ t: 'hello', name: me.name, av: me.av }); if (role === 'host') broadcastNow(); }
});

// ----- ведущий -----
function familyQs() { return store.get('familyQs', []).map((q, i) => ({ ...q, id: 'f' + i, cat: 'family' })); }
function newCode() { const a = new Uint32Array(1); crypto.getRandomValues ? crypto.getRandomValues(a) : (a[0] = Math.random() * 1e9); return String(100000 + (a[0] % 900000)); }
async function createRoom(code = newCode(), snap = null) {
  leaveRoom();
  role = 'host'; boot = Math.random().toString(36).slice(2, 8);
  game = new HostGame({ code, hostId: me.id, familyQs: familyQs(), timers: T, onChange: s => { s.boot = boot; onState(s); scheduleBroadcast(); store.set('hostSave', { t: Date.now(), snap: game.snapshot() }); } });
  bus = makeBus(code, hostMessage);
  await bus.start();
  if (snap) { game.restore(snap); game.join(me.id, me.name, me.av); }
  else { const saved = store.get('hostSettings', null); if (saved) game.s.settings = { ...game.s.settings, ...saved }; game.join(me.id, me.name, me.av); }
  bcastTimer = setInterval(broadcastNow, 6000);
  presenceTimer = setInterval(() => game && game.checkPresence(), 4000);
  wake();
}
function resumeRoom() { const saved = store.get('hostSave', null); if (!saved) return; createRoom(saved.snap.s.code, saved.snap); }
let bcastPending = false;
function scheduleBroadcast() { if (bcastPending) return; bcastPending = true; setTimeout(() => { bcastPending = false; broadcastNow(); }, 120); }
function broadcastNow() { if (role === 'host' && bus && game) bus.send({ t: 'state', s: game.s }); }
function hostMessage(m) {
  if (!game) return;
  if (m.t === 'hello') {
    const ok = game.join(m.from, m.name, m.av);
    if (!ok) bus.send({ t: 'reject', to: m.from, why: 'full' }); else broadcastNow();
    return;
  }
  if (!game.s.players[m.from]) { bus.send({ t: 'reject', to: m.from, why: 'unknown' }); return; }
  if (m.t === 'ping') return game.seen(m.from);
  game.handle(m.from, m);
}

// ----- игрок -----
$('btnJoinGo').onclick = () => {
  const code = $('inpCode').value.replace(/\D/g, '');
  if (code.length !== 6) { showJoinErr('Код — это 6 цифр'); return; }
  joinRoom(code);
};
$('inpCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnJoinGo').click(); });
function showJoinErr(t) { const e = $('joinErr'); e.textContent = t; e.classList.toggle('hidden', !t); }
async function joinRoom(code) {
  leaveRoom(); showJoinErr('');
  role = 'client'; joinCode = code;
  bus = makeBus(code, clientMessage);
  await bus.start();
  const hello = () => bus && bus.send({ t: 'hello', name: me.name, av: me.av });
  hello();
  let tries = 0;
  helloTimer = setInterval(() => { if (!S) { tries++; hello(); if (tries === 6) showJoinErr('Ищем комнату… Проверь код и что у создателя открыта игра.'); } }, 2500);
  pingTimer = setInterval(() => {
    if (!bus) return;
    bus.send({ t: S ? 'ping' : 'hello', name: me.name, av: me.av });
    if (S && hostLost && Date.now() - hostLost > 25000) $('lastLbl').textContent = '⚠️ Нет связи с ведущим… ждём';
  }, 10000);
  $('btnJoinGo').disabled = true; $('btnJoinGo').textContent = '⏳ Подключаемся…';
  setTimeout(() => { $('btnJoinGo').disabled = false; $('btnJoinGo').textContent = 'Войти ➜'; }, 4000);
  wake();
}
function clientMessage(m) {
  if (m.t === 'state') {
    const s = m.s;
    if (!s || s.code !== joinCode) return;
    if (s.boot !== boot) { boot = s.boot; lastV = -1; }
    if (s.v <= lastV) return;
    lastV = s.v; hostLost = Date.now();
    if (!s.players[me.id]) { bus.send({ t: 'hello', name: me.name, av: me.av }); }
    onState(s);
  } else if (m.t === 'reject') {
    if (m.why === 'full') { showJoinErr('Комната заполнена (максимум 10 игроков) 😕'); leaveRoom(); show('scrJoin'); }
    else if (m.why === 'unknown') bus.send({ t: 'hello', name: me.name, av: me.av });
  }
}
function sendAction(m) {
  if (role === 'host') game.handle(me.id, m);
  else if (bus) bus.send(m);
}

// ---------- отрисовка состояния ----------
function onState(s) {
  S = s;
  if (s.phase === 'lobby') { renderLobby(); show('scrLobby'); hideOverlays(); return; }
  if ($('scrGame').classList.contains('hidden')) { show('scrGame'); buildMap(); }
  renderGame();
}
function hideOverlays() { ['ovDice', 'ovEvent', 'ovQuiz', 'ovEnd'].forEach(o => $(o).classList.add('hidden')); }
const pl = id => S.players[id];

function renderLobby() {
  $('lobbyCode').textContent = S.code;
  const ids = S.order;
  $('lobbyCount').textContent = `(${ids.length}/10)`;
  $('lobbyPlayers').innerHTML = ids.map(id => {
    const p = pl(id);
    return `<div class="player ${p.online ? '' : 'off'}"><span class="av" style="background:${p.color}22;border-color:${p.color}">${esc(p.av)}</span><span class="nm">${esc(p.name)}${id === me.id ? ' (ты)' : ''}</span>${id === S.hostId ? '<span class="tag">создатель</span>' : ''}${role === 'host' && id !== me.id ? `<button class="kick" data-kick="${id}" title="Убрать">✖</button>` : ''}</div>`;
  }).join('');
  $('hostSettings').classList.toggle('hidden', role !== 'host');
  $('lobbyWait').textContent = role === 'host' ? 'Когда все зайдут, нажми «Начать игру».' : `Ждём, когда ${pl(S.hostId)?.name || 'создатель'} начнёт игру… ⏳`;
  if (role === 'host') {
    document.querySelectorAll('#hostSettings .seg').forEach(seg => {
      const k = seg.dataset.set; const v = S.settings[k];
      seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', k === 'family' ? (b.dataset.v === '1') === v : +b.dataset.v === v));
    });
    const n = familyQs().length; $('famCount').textContent = n ? `(${n})` : '(пока нет)';
  }
}
$('lobbyPlayers').onclick = e => { const b = e.target.closest('[data-kick]'); if (b && game && confirm('Убрать игрока из комнаты?')) game.kick(b.dataset.kick); };
$('hostSettings').onclick = e => {
  const b = e.target.closest('.seg button'); if (!b || !game) return;
  const k = b.closest('.seg').dataset.set; const v = k === 'family' ? b.dataset.v === '1' : +b.dataset.v;
  game.setSettings({ [k]: v }); store.set('hostSettings', game.s.settings); play.click();
};
$('btnStart').onclick = () => { if (!game) return; game.familyQs = familyQs(); game.start(); play.turn(); };
$('btnShare').onclick = async () => {
  const url = location.origin + location.pathname + '#join=' + S.code;
  const text = `Заходи играть в «Семейный микс» 🇰🇿! Код комнаты: ${S.code}`;
  try { if (navigator.share) { await navigator.share({ title: 'Семейный микс', text, url }); return; } } catch { return; }
  try { await navigator.clipboard.writeText(text + '\n' + url); toast('Ссылка скопирована! 📋'); } catch { modal(`<h2>Позови родных</h2><p>${esc(text)}</p><p style="word-break:break-all">${esc(url)}</p>`); }
};

// ---------- карта ----------
const SVGNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, parent) { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
let tokLayer = null, ringEls = [];
// где подписывать город: сдвиг x, y и выравнивание
const LABELS = { astana: [-26, 6, 'end'], burabay: [0, -28, 'middle'], karaganda: [0, 42, 'middle'], oskemen: [0, 42, 'middle'], charyn: [6, 44, 'middle'],
  almaty: [0, -28, 'middle'], kordai: [-4, 44, 'middle'], shymkent: [10, 42, 'middle'], turkestan: [-24, -14, 'end'], baikonur: [0, -28, 'middle'], aktau: [0, 42, 'middle'], atyrau: [0, -28, 'middle'] };
function buildMap() {
  const svg = $('map'); svg.innerHTML = '';
  svg.setAttribute('viewBox', `0 0 ${GEO.W} ${GEO.H}`);
  el('rect', { x: 0, y: 0, width: GEO.W, height: GEO.H, fill: '#f3e3b5' }, svg);           // соседние земли
  el('path', { d: GEO.caspian, fill: '#5cc3f0', stroke: '#2a8fc4', 'stroke-width': 3 }, svg);
  el('path', { d: GEO.kz, fill: '#9fdc6f', stroke: '#1d2340', 'stroke-width': 5, 'stroke-linejoin': 'round' }, svg);
  el('path', { d: GEO.aral, fill: '#5cc3f0', stroke: '#2a8fc4', 'stroke-width': 3 }, svg);
  el('path', { d: GEO.balkhash, fill: '#5cc3f0', stroke: '#2a8fc4', 'stroke-width': 3 }, svg);
  const label = (x, y, t, size = 16, fill = '#2a6f99') => { const e = el('text', { x, y, 'font-size': size, 'font-weight': 800, fill, 'text-anchor': 'middle', opacity: .8 }, svg); e.textContent = t; };
  label(70, 400, 'Каспий', 16); label(352, 318, 'Арал', 12); label(745, 326, 'Балхаш', 13);
  // горы и декор
  [[800, 520, '🏔️'], [930, 300, '🌲'], [350, 140, '🌾'], [300, 420, '🐪'], [690, 330, '🦅'], [500, 220, '🌾']].forEach(([x, y, t]) => { const e = el('text', { x, y, 'font-size': 26, 'text-anchor': 'middle', opacity: .85 }, svg); e.textContent = t; });
  // дорожка
  const pts = BOARD.map(b => `${b.x},${b.y}`).join(' ');
  el('polygon', { points: pts, fill: 'none', stroke: '#fff', 'stroke-width': 12, 'stroke-linejoin': 'round', opacity: .9 }, svg);
  el('polygon', { points: pts, fill: 'none', stroke: '#c0712b', 'stroke-width': 4, 'stroke-dasharray': '10 8', 'stroke-linejoin': 'round' }, svg);
  ringEls = [];
  BOARD.forEach((b, i) => {
    const g = el('g', {}, svg);
    if (b.type === 'city') {
      const r = el('circle', { cx: b.x, cy: b.y, r: 21, class: 'city-ring' }, g); ringEls[i] = r;
      const t = el('text', { x: b.x, y: b.y + 8, 'font-size': 22, 'text-anchor': 'middle' }, g); t.textContent = CITIES[b.city].e;
      const [dx, dy, anc] = LABELS[b.city] || [0, 40, 'middle'];
      const n = el('text', { x: b.x + dx, y: b.y + dy, 'text-anchor': anc, class: 'city-name' }, g); n.textContent = CITIES[b.city].name.replace('Чарынский каньон', 'Чарын');
    } else {
      el('circle', { cx: b.x, cy: b.y, r: 14, class: 'fun' }, g);
      const t = el('text', { x: b.x, y: b.y + 6, 'font-size': 16, 'text-anchor': 'middle' }, g); t.textContent = EVENTS[b.ev].e;
    }
  });
  tokLayer = el('g', {}, svg);
}
function tokenXY(pos, idx, count) {
  const b = BOARD[pos];
  if (count <= 1) return [b.x, b.y - 4];
  const ang = (idx / count) * Math.PI * 2 - Math.PI / 2, rr = 16 + Math.min(count, 6) * 1.5;
  return [b.x + Math.cos(ang) * rr, b.y + Math.sin(ang) * rr];
}
function displayPos(id) { return anim.id === id && anim.pos != null ? anim.pos : pl(id).pos; }
function renderTokens() {
  if (!tokLayer) return;
  const groups = {};
  S.order.forEach(id => { const p = displayPos(id); (groups[p] = groups[p] || []).push(id); });
  const existing = new Map([...tokLayer.children].map(c => [c.dataset.id, c]));
  S.order.forEach(id => {
    const p = displayPos(id), grp = groups[p], [x, y] = tokenXY(p, grp.indexOf(id), grp.length);
    let g = existing.get(id);
    if (!g) {
      g = el('g', { class: 'tok' }, tokLayer); g.dataset.id = id;
      el('circle', { cx: 0, cy: 0, r: 15, fill: pl(id).color, stroke: '#1d2340', 'stroke-width': 3 }, g);
      const t = el('text', { x: 0, y: 7, 'font-size': 19, 'text-anchor': 'middle' }, g); t.textContent = pl(id).av;
    }
    existing.delete(id);
    g.classList.toggle('me', id === me.id);
    g.style.opacity = pl(id).online ? 1 : .45;
    g.style.transform = `translate(${x}px, ${y}px)`;
    if (id === S.turn) tokLayer.appendChild(g);
  });
  existing.forEach(g => g.remove());
  ringEls.forEach((r, i) => r && r.classList.toggle('active', !!S.turn && pl(S.turn) && displayPos(S.turn) === i));
}
function scrollToToken(id) {
  const wrap = $('mapWrap'), svg = $('map'); if (!id || !pl(id)) return;
  const b = BOARD[displayPos(id)]; const scale = svg.clientWidth / GEO.W;
  wrap.scrollLeft = Math.max(0, b.x * scale - wrap.clientWidth / 2);
}

// ---------- игра ----------
function renderGame() {
  const s = S;
  $('roundLbl').textContent = s.phase === 'end' ? '🏁 Финиш!' : `Круг ${s.round} из ${s.settings.rounds}`;
  $('lastLbl').textContent = s.last || '';
  // счёт
  const ids = [...s.order].sort((a, b) => pl(b).score - pl(a).score);
  $('scoreRow').innerHTML = ids.map(id => { const p = pl(id); return `<div class="chip ${id === s.turn && s.phase !== 'end' ? 'turn' : ''} ${p.online ? '' : 'off'}" style="border-color:${p.color}"><span class="a">${esc(p.av)}</span>${esc(p.name)}${id === me.id ? '⭐' : ''} <b>${p.score}</b><span class="b">🏅${p.badges.length}</span></div>`; }).join('');
  $('hostBar').classList.toggle('hidden', role !== 'host' || s.phase === 'end');
  handleDice(); handleEvent(); handleQuiz(); handleEnd();
  renderTurnBar(); renderTokens();
}
function renderTurnBar() {
  const s = S, bar = $('turnBar');
  if (s.phase === 'turn' && s.turn === me.id) {
    if (!bar.querySelector('#btnRoll')) { bar.innerHTML = `<button class="big-btn green" id="btnRoll">🎲 Бросить кубик!</button>`; $('btnRoll').onclick = () => { const b = $('btnRoll'); b.disabled = true; play.dice(); sendAction({ t: 'roll' }); setTimeout(() => { if (b.isConnected) b.disabled = false; }, 4000); }; }
    const key = s.round + ':' + s.turn + ':' + s.seq; if (seen.turnSound !== key) { seen.turnSound = key; play.turn(); try { navigator.vibrate && navigator.vibrate(120); } catch {} scrollToToken(me.id); }
  } else if (s.phase === 'turn') {
    const p = pl(s.turn); bar.innerHTML = p ? `<div>Ходит ${esc(p.av)} <span style="color:${p.color}">${esc(p.name)}</span>…</div>` : '';
    scrollToToken(s.turn);
  } else if (s.phase === 'end') bar.innerHTML = '';
  else if (!bar.querySelector('.wait')) bar.innerHTML = '<div class="wait">✨</div>';
}
function drawDice(v) {
  const on = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] }[v] || [];
  $('dice').innerHTML = Array.from({ length: 9 }, (_, i) => `<i class="${on.includes(i) ? '' : 'o'}"></i>`).join('');
}
function handleDice() {
  const d = S.dice;
  if (!d || d.n === seen.dice) return;
  seen.dice = d.n;
  const p = pl(d.by); if (!p) return;
  const walk = () => {
    anim.id = d.by; anim.pos = d.from; let i = 0;
    scrollToToken(d.by);
    const stepper = setInterval(() => {
      anim.pos = d.path[i++]; play.step(); renderTokens(); scrollToToken(d.by);
      if (i >= d.path.length) { clearInterval(stepper); setTimeout(() => { anim.id = null; anim.pos = null; renderTokens(); }, 150); }
    }, T.step);
    renderTokens();
  };
  if (d.value) {
    $('ovDice').classList.remove('hidden'); $('diceWho').textContent = `${p.av} ${p.name}`;
    $('dice').classList.add('rolling'); play.dice();
    const spin = setInterval(() => drawDice(1 + Math.floor(Math.random() * 6)), 90);
    anim.id = d.by; anim.pos = d.from;
    setTimeout(() => { clearInterval(spin); $('dice').classList.remove('rolling'); drawDice(d.value); }, T.dice * 0.6);
    setTimeout(() => { $('ovDice').classList.add('hidden'); walk(); }, T.dice);
  } else walk();
}
function handleEvent() {
  const e = S.event;
  if (!e || e.n === seen.event) return;
  seen.event = e.n;
  setTimeout(() => {
    $('evEmoji').textContent = e.e; $('evText').textContent = `${pl(e.by)?.name || ''}: ${e.t}`;
    $('ovEvent').classList.remove('hidden'); play.event();
    setTimeout(() => $('ovEvent').classList.add('hidden'), T.event - 300);
  }, 50);
}

// ---------- викторина ----------
const SHAPES = ['▲', '◆', '●', '■'];
let quizTimer = null;
function handleQuiz() {
  const q = S.quiz, s = S;
  if ((s.phase === 'quiz' || s.phase === 'reveal') && q) {
    if (!quizLocal || quizLocal.n !== q.n) {
      quizLocal = { n: q.n, start: performance.now(), picked: null };
      $('ovDice').classList.add('hidden'); $('ovEvent').classList.add('hidden');
      const c = CITIES[q.city], by = pl(q.by);
      $('qCity').textContent = `${c.e} ${c.name}`;
      $('qBadge').classList.toggle('hidden', !q.badge);
      if (q.badge) $('qBadge').textContent = `🏅 ${by?.av || ''} ${by?.name || ''} получает значок «${c.name}» (+100)!`;
      $('qEmoji').textContent = q.q.e; $('qText').textContent = q.q.text;
      $('qAnswers').innerHTML = q.q.answers.map((a, i) => `<button class="ans a${i}" data-i="${i}"><span class="sh">${SHAPES[i]}</span><span>${esc(a)}</span></button>`).join('');
      $('qReveal').classList.add('hidden'); $('qStatus').textContent = '';
      $('ovQuiz').classList.remove('hidden');
      play.quiz(); if (q.badge && q.by === me.id) setTimeout(play.badge, 500);
      clearInterval(quizTimer);
      let lastSec = null;
      quizTimer = setInterval(() => {
        const left = Math.max(0, q.time - (performance.now() - quizLocal.start) / 1000);
        $('qTimer').style.width = (left / q.time * 100) + '%'; const sec = Math.ceil(left); $('qSec').textContent = sec;
        if (sec !== lastSec && sec <= 5 && sec > 0 && quizLocal.picked == null) play.tick(); lastSec = sec;
        if (left <= 0) { clearInterval(quizTimer); if (quizLocal.picked == null && S.phase === 'quiz') { $('qStatus').textContent = '⏰ Время вышло!'; lockAnswers(); } }
      }, 100);
    }
    if (s.phase === 'quiz') {
      const n = q.answered.length, tot = s.order.filter(id => pl(id).online).length;
      if (quizLocal.picked != null) $('qStatus').textContent = `✅ Ответ принят! Ждём остальных… (${n}/${tot})`;
      else if (!$('qStatus').textContent.startsWith('⏰')) $('qStatus').textContent = `Ответили: ${n}/${tot}`;
    }
    if (s.phase === 'reveal' && S.reveal && S.reveal.n !== seen.reveal) showReveal();
  } else {
    if (!$('ovQuiz').classList.contains('hidden')) $('ovQuiz').classList.add('hidden');
    clearInterval(quizTimer);
  }
}
function lockAnswers() { document.querySelectorAll('#qAnswers .ans').forEach(b => { b.disabled = true; }); }
$('qAnswers').onclick = e => {
  const b = e.target.closest('.ans'); if (!b || !S || S.phase !== 'quiz' || !quizLocal || quizLocal.picked != null) return;
  const i = +b.dataset.i; const ms = Math.round(performance.now() - quizLocal.start);
  if (ms > S.quiz.time * 1000) return;
  quizLocal.picked = i; play.click();
  document.querySelectorAll('#qAnswers .ans').forEach(x => x.classList.toggle('dim', x !== b)); b.classList.add('picked'); lockAnswers();
  $('qStatus').textContent = '✅ Ответ принят! Ждём остальных…';
  sendAction({ t: 'ans', n: S.quiz.n, c: i, ms });
  // если сообщение потерялось — повторим (ведущий примет только первый ответ)
  if (role === 'client') setTimeout(() => { if (S && S.phase === 'quiz' && S.quiz.n === quizLocal.n && !S.quiz.answered.includes(me.id)) bus && bus.send({ t: 'ans', n: S.quiz.n, c: i, ms }); }, 3000);
};
function showReveal() {
  const r = S.reveal; seen.reveal = r.n; clearInterval(quizTimer);
  $('qTimer').style.width = '0%'; $('qSec').textContent = '';
  document.querySelectorAll('#qAnswers .ans').forEach((b, i) => { b.disabled = true; b.classList.toggle('dim', i !== r.correct); b.classList.toggle('right', i === r.correct); });
  const mine = r.res[me.id];
  const rows = Object.entries(r.res).filter(([, x]) => x.ok).sort((a, b) => b[1].pts - a[1].pts).slice(0, 5)
    .map(([id, x]) => `<div class="row"><span>${esc(pl(id)?.av)} ${esc(pl(id)?.name)}</span><b>+${x.pts}</b></div>`).join('');
  $('qReveal').innerHTML = `<div class="me">${mine ? (mine.ok ? `🎉 Правильно! +${mine.pts}` : '🙈 Не угадал(а)…') : '⏰ Без ответа'}</div>
    ${r.fact ? `<div class="fact">💡 ${esc(r.fact)}</div>` : ''}${rows ? `<div>Быстрее всех:</div>${rows}` : '<div class="center">В этот раз никто не угадал 🤔</div>'}`;
  $('qReveal').classList.remove('hidden'); $('qStatus').textContent = '';
  if (mine && mine.ok) { play.good(); rain('⭐', 10); } else play.bad();
}
$('btnSpeak').onclick = () => {
  if (!S || !S.quiz || !('speechSynthesis' in window)) { toast('Чтение вслух не поддерживается 😕'); return; }
  speechSynthesis.cancel();
  const q = S.quiz.q; const u = new SpeechSynthesisUtterance(q.text + '. ' + q.answers.map((a, i) => ['Красный', 'Синий', 'Жёлтый', 'Зелёный'][i] + ': ' + a).join('. '));
  u.lang = 'ru-RU'; u.rate = 0.95; speechSynthesis.speak(u);
};

// ---------- финал ----------
function handleEnd() {
  if (S.phase !== 'end') { $('ovEnd').classList.add('hidden'); return; }
  if (!$('ovEnd').classList.contains('hidden')) return;
  $('ovQuiz').classList.add('hidden');
  const f = S.final || S.order;
  const top = f.slice(0, 3).map(id => pl(id));
  const order = [1, 0, 2].filter(i => top[i]);
  $('podium').innerHTML = order.map(i => `<div class="pod p${i + 1}"><div class="a">${esc(top[i].av)}</div><div>${esc(top[i].name)}</div><div class="bar">${['🥇', '🥈', '🥉'][i]}</div></div>`).join('');
  $('endList').innerHTML = f.map((id, k) => { const p = pl(id); return `<div class="player"><span>${k + 1}.</span><span class="av" style="border-color:${p.color}">${esc(p.av)}</span><span class="nm">${esc(p.name)}<br><small>${p.badges.map(c => CITIES[c].e).join('') || '—'}</small></span><b>${p.score}</b></div>`; }).join('');
  $('btnAgain').classList.toggle('hidden', role !== 'host');
  $('ovEnd').classList.remove('hidden'); play.win(); rain(['🎉', '⭐', '🍩', '🏆'], 36);
  if (role === 'host') store.del('hostSave');
}
$('btnAgain').onclick = () => { $('ovEnd').classList.add('hidden'); game && game.backToLobby(); };
$('btnEndHome').onclick = () => { leaveRoom(); show('scrHome'); refreshHome(); };
$('btnSkip').onclick = () => { if (game && confirm('Пропустить текущий ход?')) { if (game.s.phase === 'quiz') game.endQuiz(); else game.nextTurn(); } };
$('btnEnd').onclick = () => { if (game && confirm('Закончить игру и показать итоги?')) game.finish(); };

// ---------- режим автора ----------
$('btnCreator').onclick = () => {
  if (sessionStorage.getItem('fm_author') === '1') return openCreator();
  modal(`<h2>✏️ Для автора</h2><p>Введи секретный код автора:</p><input id="authCode" class="inp" autocomplete="off" autocapitalize="off" type="password"><div class="row-btns"><button class="big-btn blue" id="authGo" style="width:100%">Открыть</button></div>`);
  const go = () => {
    const v = $('authCode').value.trim().toLowerCase().replace(/\s+/g, '');
    const h = bytesToHex(sha256(new TextEncoder().encode('fm-author:' + v)));
    if (AUTHOR_HASHES.includes(h)) { sessionStorage.setItem('fm_author', '1'); play.badge(); openCreator(); }
    else { play.bad(); toast('Неверный код 🙅'); }
  };
  $('authGo').onclick = go; $('authCode').addEventListener('keydown', e => { if (e.key === 'Enter') go(); }); $('authCode').focus();
};
function openCreator(editIdx = null) {
  const qs = store.get('familyQs', []);
  const ed = editIdx != null ? qs[editIdx] : null;
  modal(`<h2>✏️ Мастерская автора</h2>
  <p>Привет, автор! Здесь можно придумать <b>семейные вопросы</b>. Они появляются в игре примерно каждый третий раз, если в настройках комнаты включено «Семейные вопросы». Вопросы хранятся на этом устройстве — создавай комнату с него.</p>
  <h3>Мои вопросы (${qs.length})</h3>
  <div id="fqList">${qs.length ? qs.map((q, i) => `<div class="fq"><span style="font-size:24px">${esc(q.e || '❓')}</span><span class="t">${esc(q.q)}<br><small>✅ ${esc(q.a[0])}</small></span><button class="small-btn" data-ed="${i}">✏️</button><button class="small-btn" data-del="${i}">🗑️</button></div>`).join('') : '<p class="small">Пока пусто. Придумай первый вопрос! Например: «Какое любимое блюдо бабушки?», «Кто в семье лучше всех играет в асык?», «Где мы отдыхали прошлым летом?»</p>'}</div>
  <h3>${ed ? 'Изменить вопрос' : 'Новый вопрос'}</h3>
  <div class="form-grid">
    <input id="fE" maxlength="6" placeholder="Картинка-эмодзи, например 🍲" value="${esc(ed?.e || '')}">
    <textarea id="fQ" rows="2" maxlength="140" placeholder="Вопрос, например: Какое любимое блюдо бабушки?">${esc(ed?.q || '')}</textarea>
    <input id="fA0" class="ok" maxlength="40" placeholder="✅ Правильный ответ" value="${esc(ed?.a[0] || '')}">
    <input id="fA1" maxlength="40" placeholder="❌ Неправильный ответ 1" value="${esc(ed?.a[1] || '')}">
    <input id="fA2" maxlength="40" placeholder="❌ Неправильный ответ 2" value="${esc(ed?.a[2] || '')}">
    <input id="fA3" maxlength="40" placeholder="❌ Неправильный ответ 3" value="${esc(ed?.a[3] || '')}">
    <input id="fF" maxlength="120" placeholder="Интересный факт после ответа (можно не писать)" value="${esc(ed?.f || '')}">
    <button class="big-btn green" id="fSave">${ed ? '💾 Сохранить' : '➕ Добавить вопрос'}</button>
  </div>
  <h3 style="margin-top:14px">Ещё</h3>
  <div class="form-grid"><input id="fAuthor" maxlength="20" placeholder="Подпись автора" value="${esc(store.get('author', 'Аниса'))}"></div>
  <div class="row-btns">
    <button class="small-btn" id="fAuthorSave">💾 Подпись</button>
    <button class="small-btn" id="fExport">📤 Сохранить вопросы в файл</button>
    <label class="small-btn">📥 Загрузить из файла<input type="file" id="fImport" accept=".json,application/json" hidden></label>
    <button class="small-btn" id="fLock">🔒 Выйти из режима автора</button>
  </div>
  <p class="small">Не пиши в вопросах адреса, телефоны и другие секреты — только весёлые вещи про семью.</p>`);
  $('fqList').onclick = e => {
    const ebtn = e.target.closest('[data-ed]'), dbtn = e.target.closest('[data-del]');
    if (ebtn) openCreator(+ebtn.dataset.ed);
    if (dbtn && confirm('Удалить вопрос?')) { qs.splice(+dbtn.dataset.del, 1); store.set('familyQs', qs); openCreator(); }
  };
  $('fSave').onclick = () => {
    const q = { e: $('fE').value.trim() || '❓', q: $('fQ').value.trim(), a: [0, 1, 2, 3].map(i => $('fA' + i).value.trim()), f: $('fF').value.trim() };
    if (!q.q || q.a.some(a => !a)) { toast('Заполни вопрос и все 4 ответа'); return; }
    if (new Set(q.a.map(a => a.toLowerCase())).size < 4) { toast('Ответы должны быть разными'); return; }
    if (ed) qs[editIdx] = q; else { if (qs.length >= 100) { toast('Максимум 100 вопросов'); return; } qs.push(q); }
    store.set('familyQs', qs); play.good(); toast('Сохранено! ✅'); openCreator();
  };
  $('fAuthorSave').onclick = () => { store.set('author', $('fAuthor').value.trim() || 'Аниса'); refreshHome(); toast('Подпись сохранена'); };
  $('fExport').onclick = () => {
    const blob = new Blob([JSON.stringify({ app: 'family-mix', familyQs: qs }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'semeynye-voprosy.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('fImport').onchange = async e => {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      const arr = (data.familyQs || []).filter(q => q && typeof q.q === 'string' && Array.isArray(q.a) && q.a.length === 4 && q.a.every(a => typeof a === 'string'))
        .map(q => ({ e: String(q.e || '❓').slice(0, 6), q: q.q.slice(0, 140), a: q.a.map(a => a.slice(0, 40)), f: String(q.f || '').slice(0, 120) }));
      store.set('familyQs', [...qs, ...arr].slice(0, 100)); toast(`Загружено вопросов: ${arr.length}`); openCreator();
    } catch { toast('Не получилось прочитать файл'); }
  };
  $('fLock').onclick = () => { sessionStorage.removeItem('fm_author'); closeModal(); };
}

// ---------- старт ----------
function boot0() {
  refreshHome(); show('scrHome');
  const m = location.hash.match(/join=(\d{6})/);
  if (m) { $('inpCode').value = m[1]; history.replaceState(null, '', location.pathname + location.search); needProfile(() => joinRoom(m[1])); }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost') && !LOCAL && !FAST) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot0();
