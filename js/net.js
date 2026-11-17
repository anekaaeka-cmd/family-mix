// Сеть «Семейного микса».
// Без своего сервера: сообщения идут через несколько бесплатных публичных
// Nostr-релеев (обычный WebSocket на порту 443, как любой сайт).
// Всё содержимое шифруется AES-GCM ключом из кода комнаты, поэтому релеи
// и посторонние видят только шум. Одно и то же событие отправляется сразу
// во все релеи, а получатель отбрасывает дубликаты, так что если какой-то
// релей не работает, игра идёт через остальные.
import { generateSecretKey, finalizeEvent } from '../vendor/nostr-sign.min.js';

export const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://yabu.me',
  'wss://offchain.pub',
  'wss://relay.nostr.net',
];
const KIND = 21337;            // «эфемерный» тип событий: релеи их не хранят
const APP = 'family-mix-kz-v1';

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = buf => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');

export function secureOK() { return !!(window.crypto && crypto.subtle && window.WebSocket); }

export class Bus {
  constructor({ code, myId, onMessage, onStatus, relays = RELAYS }) {
    this.code = code; this.myId = myId; this.onMessage = onMessage; this.onStatus = onStatus || (() => {});
    this.relays = relays; this.sockets = new Map(); this.seen = new Map(); this.queue = [];
    this.sk = generateSecretKey(); this.closed = false; this.sentCount = 0;
  }
  async start() {
    const raw = enc.encode(APP + ':' + this.code);
    this.tag = hex(await crypto.subtle.digest('SHA-256', raw)).slice(0, 40);
    const base = await crypto.subtle.importKey('raw', raw, 'PBKDF2', false, ['deriveKey']);
    this.key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode('fm-salt-' + APP), iterations: 50000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    this.relays.forEach(u => this._open(u, 0));
    this._gc = setInterval(() => { const cut = Date.now() - 120000; for (const [k, t] of this.seen) if (t < cut) this.seen.delete(k); }, 30000);
  }
  _open(url, attempt) {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return this._retry(url, attempt); }
    const rec = { ws, open: false };
    this.sockets.set(url, rec);
    ws.onopen = () => {
      rec.open = true; attempt = 0;
      ws.send(JSON.stringify(['REQ', 'fm', { kinds: [KIND], '#t': [this.tag], since: Math.floor(Date.now() / 1000) - 20 }]));
      for (const ev of this.queue) ws.send(JSON.stringify(['EVENT', ev]));
      this._status();
    };
    ws.onmessage = m => {
      let d; try { d = JSON.parse(m.data); } catch { return; }
      if (d[0] === 'EVENT' && d[2]) this._incoming(d[2]);
    };
    ws.onclose = () => { rec.open = false; this._status(); if (this.sockets.get(url) === rec) this._retry(url, attempt + 1); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  _retry(url, attempt) {
    if (this.closed) return;
    setTimeout(() => this._open(url, attempt), Math.min(15000, 1000 * Math.pow(1.7, attempt)));
  }
  _status() { this.onStatus(this.connectedCount(), this.relays.length); }
  connectedCount() { let n = 0; for (const r of this.sockets.values()) if (r.open) n++; return n; }
  async _incoming(ev) {
    if (!ev || ev.kind !== KIND || this.seen.has(ev.id)) return;
    this.seen.set(ev.id, Date.now());
    try {
      const [iv, data] = ev.content.split('.');
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, this.key, unb64(data));
      const msg = JSON.parse(dec.decode(plain));
      if (msg.from === this.myId) return;
      if (msg.to && msg.to !== this.myId) return;
      this.onMessage(msg);
    } catch (e) { /* не наш ключ или мусор — игнорируем */ }
  }
  async send(msg) {
    if (this.closed) return;
    msg.from = this.myId; msg.mid = Math.random().toString(36).slice(2, 10);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, enc.encode(JSON.stringify(msg)));
    const ev = finalizeEvent({ kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [['t', this.tag]], content: b64(iv) + '.' + b64(data) }, this.sk);
    this.seen.set(ev.id, Date.now());
    this.sentCount++;
    // держим 3 последних события, чтобы досылать их релеям, которые подключатся позже
    this.queue.push(ev); if (this.queue.length > 3) this.queue.shift();
    const s = JSON.stringify(['EVENT', ev]);
    for (const r of this.sockets.values()) if (r.open) { try { r.ws.send(s); } catch {} }
  }
  close() {
    this.closed = true; clearInterval(this._gc);
    for (const r of this.sockets.values()) { try { r.ws.close(); } catch {} }
    this.sockets.clear();
  }
}

// Локальная «сеть» для тестов в одном браузере (?local=1): вкладки общаются через BroadcastChannel.
export class LocalBus {
  constructor({ code, myId, onMessage, onStatus }) { this.code = code; this.myId = myId; this.onMessage = onMessage; this.onStatus = onStatus || (() => {}); }
  async start() { this.ch = new BroadcastChannel('fm-' + this.code); this.ch.onmessage = e => { const m = e.data; if (m.from !== this.myId && (!m.to || m.to === this.myId)) this.onMessage(m); }; this.onStatus(1, 1); }
  connectedCount() { return 1; }
  async send(msg) { msg.from = this.myId; this.ch.postMessage(JSON.parse(JSON.stringify(msg))); }
  close() { this.ch && this.ch.close(); }
}
