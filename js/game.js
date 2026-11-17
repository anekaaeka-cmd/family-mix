// Логика игры. Работает только у ведущего (того, кто создал комнату):
// он бросает кубик, считает очки и рассылает всем одно общее «состояние».
import { BOARD, CITIES, EVENTS, QUESTIONS, COLORS } from './data.js';

export const MAX_PLAYERS = 10;
const rnd = n => Math.floor(Math.random() * n);
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export class HostGame {
  constructor({ code, hostId, onChange, familyQs = [], timers = {} }) {
    this.onChange = onChange || (() => {});
    this.familyQs = familyQs;
    this.T = { dice: 1300, step: 330, land: 500, event: 2800, reveal: 6500, grace: 1800, ...timers };
    this.s = {
      v: 0, code, hostId, phase: 'lobby', round: 1, turn: null,
      settings: { rounds: 4, qTime: 20, family: true },
      players: {}, order: [], dice: null, event: null, quiz: null, reveal: null, last: '', seq: 0,
    };
    this.p = { correct: null, used: [], quizCount: 0, answers: {}, quizStart: 0 };
    this.timer = null;
  }
  // ----- служебное -----
  changed() { this.s.v++; this.onChange(this.s); }
  later(ms, fn) { clearTimeout(this.timer); this.timer = setTimeout(fn, ms); }
  snapshot() { return JSON.parse(JSON.stringify({ s: this.s, p: this.p })); }
  restore(snap) {
    this.s = snap.s; this.p = snap.p;
    Object.values(this.s.players).forEach(pl => { pl.seen = Date.now(); }); // игроки получат шанс переподключиться
    const ph = this.s.phase;
    if (ph === 'moving' || ph === 'event') this.later(500, () => this.land(true));
    else if (ph === 'quiz') this.later(1500, () => this.endQuiz());
    else if (ph === 'reveal') this.later(1500, () => this.nextTurn());
    this.changed();
  }
  onlineIds() { return this.s.order.filter(id => this.s.players[id] && this.s.players[id].online); }

  // ----- игроки -----
  join(id, name, av) {
    const s = this.s;
    name = String(name || 'Игрок').slice(0, 14); av = String(av || '🦊').slice(0, 4);
    if (s.players[id]) { Object.assign(s.players[id], { name, av, online: true, seen: Date.now() }); this.changed(); return true; }
    if (s.order.length >= MAX_PLAYERS) return false;
    const used = new Set(Object.values(s.players).map(p => p.color));
    const color = COLORS.find(c => !used.has(c)) || COLORS[s.order.length % COLORS.length];
    s.players[id] = { id, name, av, color, pos: 0, score: 0, badges: [], online: true, seen: Date.now() };
    s.order.push(id);
    s.last = `${av} ${name} в игре!`;
    if (s.phase !== 'lobby' && !s.turn) s.turn = id;
    this.changed();
    return true;
  }
  seen(id) { const p = this.s.players[id]; if (!p) return; p.seen = Date.now(); if (!p.online) { p.online = true; this.changed(); } }
  checkPresence(timeoutMs = 35000) {
    let ch = false; const now = Date.now();
    for (const p of Object.values(this.s.players)) {
      if (p.id === this.s.hostId) continue;
      if (p.online && now - p.seen > timeoutMs) { p.online = false; ch = true; }
    }
    if (ch) {
      this.changed();
      const s = this.s;
      if (s.phase === 'turn' && s.turn && !s.players[s.turn]?.online) this.nextTurn();
      if (s.phase === 'quiz') this.maybeEndQuiz();
    }
  }
  kick(id) {
    const s = this.s; if (id === s.hostId || !s.players[id]) return;
    const wasTurn = s.turn === id && s.phase === 'turn';
    if (wasTurn) this.nextTurn(true);
    delete s.players[id]; s.order = s.order.filter(x => x !== id);
    this.changed();
  }
  setSettings(st) {
    const o = this.s.settings;
    if ([2, 3, 4, 6, 8].includes(st.rounds)) o.rounds = st.rounds;
    if ([10, 15, 20, 30].includes(st.qTime)) o.qTime = st.qTime;
    if (typeof st.family === 'boolean') o.family = st.family;
    this.changed();
  }

  // ----- ход игры -----
  start() {
    const s = this.s;
    for (const p of Object.values(s.players)) Object.assign(p, { pos: 0, score: 0, badges: [] });
    s.order = shuffle(s.order);
    Object.assign(s, { phase: 'turn', round: 1, dice: null, event: null, quiz: null, reveal: null, final: null });
    s.turn = this.onlineIds()[0] || s.order[0];
    this.p.used = []; this.p.quizCount = 0;
    s.last = 'Игра началась! Все стартуют в Астане.';
    this.changed();
  }
  backToLobby() {
    clearTimeout(this.timer);
    Object.assign(this.s, { phase: 'lobby', dice: null, event: null, quiz: null, reveal: null, turn: null });
    this.changed();
  }
  roll(by) {
    const s = this.s;
    if (s.phase !== 'turn' || by !== s.turn) return;
    const value = 1 + rnd(6);
    const pl = s.players[by];
    const from = pl.pos, path = [];
    for (let i = 1; i <= value; i++) path.push((from + i) % BOARD.length);
    pl.pos = path[path.length - 1];
    s.seq++;
    s.dice = { n: s.seq, value, by, from, path };
    s.event = null; s.phase = 'moving';
    s.last = `${pl.av} ${pl.name} выбросил(а) ${value}`;
    this.changed();
    this.later(this.T.dice + value * this.T.step + this.T.land, () => this.land(false));
  }
  land(afterEvent) {
    const s = this.s, pl = s.players[s.turn];
    if (!pl) return this.nextTurn();
    const sp = BOARD[pl.pos];
    if (sp.type === 'city') return this.startQuiz(sp.city, pl);
    if (afterEvent) return this.nextTurn();
    // клетка-сюрприз
    const ev = EVENTS[sp.ev];
    s.seq++;
    s.event = { n: s.seq, e: ev.e, t: ev.t, by: pl.id };
    if (ev.pts) pl.score += ev.pts;
    if (ev.all) for (const id of this.onlineIds()) s.players[id].score += ev.all;
    s.phase = 'event';
    s.last = `${pl.av} ${pl.name}: ${ev.e} ${ev.t}`;
    this.changed();
    this.later(this.T.event, () => {
      if (ev.again) { s.phase = 'turn'; s.event = null; s.dice = null; this.changed(); return; }
      if (ev.move) {
        const from = pl.pos, path = [];
        const dir = Math.sign(ev.move);
        for (let i = 1; i <= Math.abs(ev.move); i++) path.push((from + dir * i + BOARD.length) % BOARD.length);
        pl.pos = path[path.length - 1];
        s.seq++;
        s.dice = { n: s.seq, value: null, by: pl.id, from, path };
        s.phase = 'moving'; s.event = null;
        this.changed();
        this.later(Math.abs(ev.move) * this.T.step + this.T.land, () => this.land(true));
        return;
      }
      this.nextTurn();
    });
  }
  pickQuestion(city) {
    const used = new Set(this.p.used);
    this.p.quizCount++;
    const fam = this.s.settings.family ? this.familyQs.filter(q => !used.has(q.id)) : [];
    if (fam.length && this.p.quizCount % 3 === 0) return fam[rnd(fam.length)];
    let pool = QUESTIONS.filter(q => q.city === city && !used.has(q.id));
    if (!pool.length) pool = QUESTIONS.filter(q => !q.city && !used.has(q.id));
    if (!pool.length) pool = fam;
    if (!pool.length) { this.p.used = []; pool = QUESTIONS.filter(q => !q.city || q.city === city); }
    return pool[rnd(pool.length)];
  }
  startQuiz(city, pl) {
    const s = this.s;
    const q = this.pickQuestion(city);
    this.p.used.push(q.id);
    const order = shuffle([0, 1, 2, 3]);
    this.p.correct = order.indexOf(0);
    this.p.fact = q.f || '';
    this.p.answers = {};
    this.p.quizStart = Date.now();
    let badge = null;
    if (!pl.badges.includes(city)) { pl.badges.push(city); pl.score += 100; badge = city; }
    s.seq++;
    s.quiz = { n: s.seq, city, by: pl.id, badge, q: { text: q.q, e: q.e || '❓', cat: q.cat, answers: order.map(i => q.a[i]) }, time: s.settings.qTime, answered: [] };
    s.reveal = null; s.dice = null; s.event = null;
    s.phase = 'quiz';
    s.last = `${pl.av} ${pl.name} прибыл(а) в ${CITIES[city].name}!`;
    this.changed();
    this.later(s.settings.qTime * 1000 + this.T.grace, () => this.endQuiz());
  }
  answer(by, n, choice, ms) {
    const s = this.s;
    if (s.phase !== 'quiz' || !s.quiz || s.quiz.n !== n || !s.players[by] || this.p.answers[by]) return;
    if (!(choice >= 0 && choice <= 3)) return;
    const limit = s.quiz.time * 1000;
    const hostMs = Date.now() - this.p.quizStart;
    ms = Math.max(0, Math.min(Number(ms) || hostMs, hostMs + 500, limit));
    this.p.answers[by] = { c: choice, ms };
    s.quiz.answered.push(by);
    this.changed();
    this.maybeEndQuiz();
  }
  maybeEndQuiz() {
    const s = this.s;
    if (s.phase !== 'quiz') return;
    if (this.onlineIds().every(id => this.p.answers[id])) this.later(700, () => this.endQuiz());
  }
  endQuiz() {
    const s = this.s;
    if (s.phase !== 'quiz') return;
    const limit = s.quiz.time * 1000, res = {};
    for (const [id, a] of Object.entries(this.p.answers)) {
      const ok = a.c === this.p.correct;
      const pts = ok ? Math.round(1000 - 500 * Math.min(1, a.ms / limit)) : 0;
      if (s.players[id]) s.players[id].score += pts;
      res[id] = { c: a.c, ok, pts };
    }
    s.reveal = { n: s.quiz.n, correct: this.p.correct, fact: this.p.fact, res };
    s.phase = 'reveal';
    this.changed();
    this.later(this.T.reveal, () => this.nextTurn());
  }
  nextTurn(silent) {
    const s = this.s;
    clearTimeout(this.timer);
    if (s.phase === 'end' || s.phase === 'lobby') return;
    const ord = s.order;
    if (!ord.length) return;
    let idx = ord.indexOf(s.turn), wrapped = false;
    for (let k = 0; k < ord.length; k++) {
      idx++;
      if (idx >= ord.length) { idx = 0; wrapped = true; }
      if (s.players[ord[idx]]?.online) break;
    }
    if (wrapped) s.round++;
    if (s.round > s.settings.rounds) return this.finish();
    s.turn = ord[idx];
    Object.assign(s, { phase: 'turn', dice: null, event: null, quiz: null });
    if (!silent) this.changed();
  }
  finish() {
    const s = this.s;
    clearTimeout(this.timer);
    s.round = s.settings.rounds;
    s.phase = 'end'; s.dice = null; s.event = null; s.quiz = null;
    s.final = Object.values(s.players).sort((a, b) => b.score - a.score || b.badges.length - a.badges.length).map(p => p.id);
    s.last = 'Игра окончена!';
    this.changed();
  }
  // ----- сообщения от игроков -----
  handle(from, m) {
    this.seen(from);
    switch (m.t) {
      case 'roll': return this.roll(from);
      case 'ans': return this.answer(from, m.n, m.c, m.ms);
    }
  }
}
