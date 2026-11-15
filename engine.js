// Engine catur cst.ai — port JavaScript dari engine bounty tiny-chess-01 round 3 (V4).
// Source Python: ~/workspace/makefun/chess/engine_v4.py (NODES=30.000, skor resmi 1.364).
//
// CATATAN IMPLEMENTASI (penting): search di sini memakai port 0x88 langsung dari
// engine_v4.py (gen/make/unmake/attacked/evaluate/negamax/quiesce) — BUKAN
// chess.js moves(). Alasannya terukur, bukan selera:
//   - chess.js 0.13.4 moves() menghitung SAN lewat generate_moves() penuh PER
//     langkah (lihat make_pretty -> move_to_san -> generate_moves): 320-890 µs
//     per panggilan -> 30.000 node = 15-30 detik per langkah. Tidak bisa dipakai.
//   - Urutan generate chess.js (pion dulu: a2a3 a2a4 ... b1a3 b1c3) BERBEDA dari
//     Python (scan 0x88: b1c3 b1a3 g1f3 g1h3 a2a3 ...), sehingga posisi seri
//     (skor sama) memilih langkah berbeda — gagal uji fidelity.
// chess.js tetap dipakai: validasi + parsing FEN posisi awal (new Chess(fen)),
// dan seluruh logika papan/gerak manusia di index.html. Repo ini TERPISAH dari
// entry bounty — tidak ada submit ke make.fun dari sini.
import { Chess } from './chess.js';

export const MATE = 100000;
export const INF = MATE + 1000;
export const DEFAULT_NODES = 30000;

const V = [0, 100, 320, 330, 500, 900, 0];
const TYPE_IDX = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };
const TYPE_LETTER = ['', 'p', 'n', 'b', 'r', 'q', 'k'];

const SQ = [];
for (let s = 0; s < 128; s++) if (!(s & 0x88)) SQ.push(s);

const CK = new Array(128).fill(15);
CK[0] = 13; CK[7] = 14; CK[112] = 7; CK[119] = 11;

// PST + EV: sama persis dengan _pst() dan EV di engine_v4.py.
const PST = (() => {
  const P = Array.from({ length: 7 }, () => new Array(128).fill(0));
  for (const sq of SQ) {
    const r = sq >> 4, f = sq & 7;
    const c = Math.min(f, 7 - f) + Math.min(r, 7 - r);
    P[1][sq] = r * r + ((f === 3 || f === 4) && (r === 3 || r === 4) ? 10 : 0);
    P[2][sq] = 6 * c - 20;
    P[4][sq] = r === 6 ? 15 : 0;
    P[6][sq] = r === 0 ? [20, 25, 10, 0, 0, 10, 25, 20][f] : Math.max(-50, -15 * r);
  }
  return P;
})();
const EV = Array.from({ length: 13 }, () => new Array(128).fill(0));
for (let pc = -6; pc <= 6; pc++) {
  if (!pc) continue;
  for (const sq of SQ) {
    EV[pc + 6][sq] = pc > 0
      ? V[pc] + PST[pc][sq]
      : -(V[-pc] + PST[-pc][sq ^ 0x70]);
  }
}

const KN = [33, 31, 18, 14, -14, -18, -31, -33];
const KI = [1, -1, 16, -16, 15, 17, -15, -17];
const BI = [15, 17, -15, -17];
const RO = [1, -1, 16, -16];
const ABORT = Symbol('abort');

function sqOf(name) {
  return (name.charCodeAt(1) - 49) * 16 + (name.charCodeAt(0) - 97);
}
function nameOf(sq) {
  return 'abcdefgh'[sq & 7] + String((sq >> 4) + 1);
}
function uciOfInt(m) {
  const s = nameOf(m & 127) + nameOf((m >> 7) & 127);
  const p = (m >> 14) & 7;
  return s + (p ? ' pnbrqk'[p] : '');
}

// Satu instance = satu posisi + state search (cermin global di engine_v4.py).
class Engine {
  constructor() {
    this.B = new Array(128).fill(0);
    this.S = 1;
    this.C = 0;
    this.E = -1;
    this.K = [4, 116];
    this.NPM = 0;
    this.undoStack = [];
    this.rep = new Map();
    this.nodes = 0;
    this.nodeLimit = DEFAULT_NODES;
    this.killers = Array.from({ length: 128 }, () => [0, 0]);
    this.TT = new Map();
  }

  // Isi board dari FEN lewat chess.js (validasi + parsing FEN oleh chess.js).
  loadFen(fen) {
    const g = new Chess(fen); // throw bila FEN tidak valid
    this.B = new Array(128).fill(0);
    this.NPM = 0;
    this.K = [0, 0];
    const b = g.board(); // [0] = baris 8 ... [7] = baris 1
    for (let rr = 0; rr < 8; rr++) {
      for (let f = 0; f < 8; f++) {
        const p = b[rr][f];
        if (!p) continue;
        const sq = (7 - rr) * 16 + f;
        let pc = TYPE_IDX[p.type];
        if (p.color === 'b') pc = -pc;
        this.B[sq] = pc;
        if (Math.abs(pc) !== 1 && Math.abs(pc) !== 6) this.NPM += V[Math.abs(pc)];
        else if (Math.abs(pc) === 6) this.K[pc > 0 ? 0 : 1] = sq;
      }
    }
    const parts = fen.split(' ');
    this.S = parts[1] === 'w' ? 1 : -1;
    this.C = 0;
    if (parts[2] !== '-') {
      for (const ch of parts[2]) this.C |= 1 << 'KQkq'.indexOf(ch);
    }
    this.E = parts[3] !== '-' ? sqOf(parts[3]) : -1;
    this.undoStack = [];
  }

  pkey() {
    return this.B.join(',') + '|' + this.S + '|' + this.C + '|' + this.E;
  }

  attacked(sq, by) {
    const B = this.B;
    for (const d of by === 1 ? [-15, -17] : [15, 17]) {
      const t = sq + d;
      if (!(t & 0x88) && B[t] === by) return true;
    }
    const nb = 2 * by, kb = 6 * by;
    for (const d of KN) {
      const t = sq + d;
      if (!(t & 0x88) && B[t] === nb) return true;
    }
    for (const d of KI) {
      const t = sq + d;
      if (!(t & 0x88) && B[t] === kb) return true;
    }
    for (const d of BI) {
      let t = sq + d;
      while (!(t & 0x88)) {
        const p = B[t];
        if (p) {
          if (p === 3 * by || p === 5 * by) return true;
          break;
        }
        t += d;
      }
    }
    for (const d of RO) {
      let t = sq + d;
      while (!(t & 0x88)) {
        const p = B[t];
        if (p) {
          if (p === 4 * by || p === 5 * by) return true;
          break;
        }
        t += d;
      }
    }
    return false;
  }

  // Pseudo-legal moves sebagai int f|t<<7|promo<<14 — urutan SAMA dengan gen() Python.
  gen(capsOnly = false) {
    const B = this.B;
    const ms = [];
    const us = this.S;
    for (const sq of SQ) {
      const p = B[sq];
      if (p * us <= 0) continue;
      const t = Math.abs(p);
      if (t === 1) {
        const d = us === 1 ? 16 : -16;
        const start = us === 1 ? 1 : 6;
        const last = us === 1 ? 7 : 0;
        const one = sq + d;
        if (!(one & 0x88) && B[one] === 0) {
          if ((one >> 4) === last) {
            for (const pr of [5, 4, 3, 2]) ms.push(sq | (one << 7) | (pr << 14));
          } else if (!capsOnly) {
            ms.push(sq | (one << 7));
            if ((sq >> 4) === start) {
              const two = sq + 2 * d;
              if (B[two] === 0) ms.push(sq | (two << 7));
            }
          }
        }
        for (const dd of [d - 1, d + 1]) {
          const to = sq + dd;
          if (to & 0x88) continue;
          if (B[to] * us < 0 || to === this.E) {
            if ((to >> 4) === last) {
              for (const pr of [5, 4, 3, 2]) ms.push(sq | (to << 7) | (pr << 14));
            } else {
              ms.push(sq | (to << 7));
            }
          }
        }
      } else if (t === 2 || t === 6) {
        for (const d of t === 2 ? KN : KI) {
          const to = sq + d;
          if (to & 0x88) continue;
          if (B[to] * us <= 0 && (B[to] !== 0 || !capsOnly)) ms.push(sq | (to << 7));
        }
      } else {
        for (const d of t === 3 ? BI : t === 4 ? RO : BI.concat(RO)) {
          let to = sq + d;
          while (!(to & 0x88)) {
            if (B[to] === 0) {
              if (!capsOnly) ms.push(sq | (to << 7));
            } else {
              if (B[to] * us < 0) ms.push(sq | (to << 7));
              break;
            }
            to += d;
          }
        }
      }
    }
    if (!capsOnly) {
      const k = us === 1 ? 4 : 116;
      if (this.C & (us === 1 ? 1 : 4) && B[k + 1] === 0 && B[k + 2] === 0) {
        ms.push(k | ((k + 2) << 7));
      }
      if (this.C & (us === 1 ? 2 : 8) && B[k - 1] === 0 && B[k - 2] === 0 && B[k - 3] === 0) {
        ms.push(k | ((k - 2) << 7));
      }
    }
    return ms;
  }

  make(m) {
    const B = this.B;
    const f = m & 127, t = (m >> 7) & 127, pr = (m >> 14) & 7;
    const us = this.S, pc = B[f];
    let cap = B[t];
    let epCap = -1;
    if (Math.abs(pc) === 1 && t === this.E && cap === 0) {
      epCap = t - 16 * us;
      cap = B[epCap];
    }
    if (Math.abs(pc) === 6 && Math.abs(t - f) === 2) {
      const mid = (f + t) >> 1;
      if (this.attacked(f, -us) || this.attacked(mid, -us)) return false;
    }
    const oldk = us === 1 ? this.K[0] : this.K[1];
    this.undoStack.push([m, cap, this.C, this.E, oldk, epCap]);
    B[f] = 0;
    const np = pr ? pr * us : pc;
    if (cap && Math.abs(cap) > 1) this.NPM -= V[Math.abs(cap)];
    if (pr) this.NPM += V[pr];
    B[t] = np;
    if (epCap >= 0) B[epCap] = 0;
    if (Math.abs(pc) === 6 && Math.abs(t - f) === 2) {
      let rf, rt;
      if (t > f) { rf = t + 1; rt = t - 1; } else { rf = t - 2; rt = t + 1; }
      const rp = B[rf]; B[rf] = 0; B[rt] = rp;
    }
    if (Math.abs(pc) === 6) this.C &= ~(us === 1 ? 3 : 12);
    this.C &= CK[f] & CK[t];
    this.E = -1;
    if (Math.abs(pc) === 1 && Math.abs(t - f) === 32) this.E = (f + t) >> 1;
    if (Math.abs(pc) === 6) this.K[us === 1 ? 0 : 1] = t;
    this.S = -us;
    if (this.attacked(us === 1 ? this.K[0] : this.K[1], -us)) {
      this.unmake();
      return false;
    }
    return true;
  }

  unmake() {
    const B = this.B;
    const [m, cap, c, e, oldk, epCap] = this.undoStack.pop();
    if (cap && Math.abs(cap) > 1) this.NPM += V[Math.abs(cap)];
    if ((m >> 14) & 7) this.NPM -= V[(m >> 14) & 7];
    const f = m & 127, t = (m >> 7) & 127, pr = (m >> 14) & 7;
    const us = -this.S;
    let pc = B[t];
    B[t] = 0;
    if (pr) pc = 1 * us;
    B[f] = pc;
    if (cap) B[epCap >= 0 ? epCap : t] = cap;
    if (Math.abs(pc) === 6 && Math.abs(t - f) === 2) {
      let rf, rt;
      if (t > f) { rf = t + 1; rt = t - 1; } else { rf = t - 2; rt = t + 1; }
      B[rf] = B[rt]; B[rt] = 0;
    }
    if (Math.abs(pc) === 6) this.K[us === 1 ? 0 : 1] = oldk;
    this.C = c; this.E = e; this.S = us;
  }

  evaluate() {
    let sc = 0, bp0 = 0, bp1 = 0;
    for (const sq of SQ) {
      const p = this.B[sq];
      if (p) {
        sc += EV[p + 6][sq];
        if (p === 3) bp0++;
        else if (p === -3) bp1++;
      }
    }
    sc += 30 * (bp0 >= 2) - 30 * (bp1 >= 2);
    return this.S === 1 ? sc : -sc;
  }

  order(ms, ply, ttmove) {
    const B = this.B;
    const k0 = this.killers[ply][0], k1 = this.killers[ply][1];
    const pr = [];
    for (let idx = 0; idx < ms.length; idx++) {
      const m = ms[idx];
      const t = (m >> 7) & 127;
      const cap = B[t];
      let s;
      if (m === ttmove) s = 1000000;
      else if (cap || ((m >> 14) & 7)) s = 100000 + 10 * V[cap ? Math.abs(cap) : 1] - V[Math.abs(B[m & 127])];
      else if (m === k0) s = 50000;
      else if (m === k1) s = 40000;
      else s = 0;
      pr.push([-s, idx, m]);
    }
    pr.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]));
    for (let i = 0; i < pr.length; i++) ms[i] = pr[i][2];
    return ms;
  }

  quiesce(alpha, beta, ply) {
    this.nodes++;
    if (this.nodes >= this.nodeLimit) throw ABORT;
    if (ply >= 120) return this.evaluate();
    const incheck = this.attacked(this.S === 1 ? this.K[0] : this.K[1], -this.S);
    let best;
    if (!incheck) {
      const stand = this.evaluate();
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      best = stand;
    } else {
      best = -INF;
    }
    const ms = this.order(this.gen(!incheck), ply, 0);
    let legal = 0;
    for (const m of ms) {
      if (!this.make(m)) continue;
      legal++;
      let sc;
      try {
        sc = -this.quiesce(-beta, -alpha, ply + 1);
      } finally {
        this.unmake();
      }
      if (sc > best) best = sc;
      if (sc >= beta) return sc;
      if (sc > alpha) alpha = sc;
    }
    if (incheck && legal === 0) return -MATE + ply;
    return best;
  }

  negamax(depth, alpha, beta, ply) {
    const key = this.pkey();
    if (ply > 0 && (this.rep.get(key) || 0) >= 2) return 0;
    if (depth <= 0 || ply >= 120) return this.quiesce(alpha, beta, ply);
    this.nodes++;
    if (this.nodes >= this.nodeLimit) throw ABORT;
    const incheck = this.attacked(this.S === 1 ? this.K[0] : this.K[1], -this.S);
    if (depth >= 3 && !incheck && ply > 0) {
      if (this.NPM > 0) {
        const oldE = this.E;
        this.E = -1; this.S = -this.S;
        const zn = this.pkey();
        this.rep.set(zn, (this.rep.get(zn) || 0) + 1);
        let sc;
        try {
          sc = -this.negamax(depth - 3, -beta, -beta + 1, ply + 1);
        } finally {
          this.rep.set(zn, this.rep.get(zn) - 1);
          this.S = -this.S; this.E = oldE;
        }
        if (sc >= beta) return beta;
      }
    }
    const ent = this.TT.get(key);
    let ttmove = 0;
    if (ent && ent[0] >= depth) {
      let s = ent[1];
      if (s > MATE - 200) s -= ply;
      else if (s < -MATE + 200) s += ply;
      if (ent[2] === 1 || (ent[2] === 2 && s >= beta) || (ent[2] === 3 && s <= alpha)) return s;
      ttmove = ent[3];
    }
    const a0 = alpha;
    const ms = this.order(this.gen(), ply, ttmove);
    let best = -INF, bestm = 0, legal = 0;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!this.make(m)) continue;
      legal++;
      const zh = this.pkey();
      this.rep.set(zh, (this.rep.get(zh) || 0) + 1);
      let sc;
      try {
        sc = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      } finally {
        this.rep.set(zh, this.rep.get(zh) - 1);
        this.unmake();
      }
      if (sc > best) { best = sc; bestm = m; }
      if (sc > alpha) alpha = sc;
      if (alpha >= beta) {
        if (!((m >> 14) & 7) && this.B[(m >> 7) & 127] === 0) {
          if (this.killers[ply][0] !== m) {
            this.killers[ply][1] = this.killers[ply][0];
            this.killers[ply][0] = m;
          }
        }
        break;
      }
    }
    if (legal === 0) return incheck ? -MATE + ply : 0;
    let s = best;
    if (best > MATE - 200) s = best + ply;
    else if (best < -MATE + 200) s = best - ply;
    let flag;
    if (best <= a0) flag = 3;
    else if (best >= beta) flag = 2;
    else flag = 1;
    this.TT.set(key, [depth, s, flag, bestm]);
    return best;
  }

  searchRoot() {
    const ms = [];
    for (const m of this.gen()) {
      if (this.make(m)) { ms.push(m); this.unmake(); }
    }
    if (!ms.length) return null;
    this.order(ms, 0, 0);
    let bestm = ms[0], bests = 0, bestd = 0;
    this.nodes = 0;
    for (let d = 1; d <= 32; d++) {
      let alpha = -INF;
      const scored = [];
      try {
        for (let i = 0; i < ms.length; i++) {
          const m = ms[i];
          if (!this.make(m)) continue;
          const zh = this.pkey();
          this.rep.set(zh, (this.rep.get(zh) || 0) + 1);
          let sc;
          try {
            if (i === 0) {
              sc = -this.negamax(d - 1, -INF, INF, 1);
            } else {
              sc = -this.negamax(d - 1, -alpha - 1, -alpha, 1);
              if (sc > alpha) sc = -this.negamax(d - 1, -INF, INF, 1);
            }
          } finally {
            this.rep.set(zh, this.rep.get(zh) - 1);
            this.unmake();
          }
          scored.push([sc, m]);
          if (sc > alpha) alpha = sc;
        }
      } catch (e) {
        if (e !== ABORT) throw e;
        while (this.undoStack.length) this.unmake();
        break;
      }
      scored.sort((a, b) => b[0] - a[0]); // sort JS stabil: tie = urutan search sebelumnya
      for (let i = 0; i < scored.length; i++) ms[i] = scored[i][1];
      bestm = ms[0]; bests = scored[0][0]; bestd = d;
      if (bests >= MATE - 200 || bests <= -MATE + 200) break;
    }
    return { move: bestm, score: bests, depth: bestd, nodes: this.nodes };
  }
}

// Evaluasi posisi FEN (skor relatif side-to-move, centipawn) — untuk uji.
export function evaluateFen(fen) {
  const e = new Engine();
  e.loadFen(fen);
  return e.evaluate();
}

// Langkah terbaik dari sebuah posisi.
// fen: posisi FEN. nodeBudget: batas node (default 30000, sama dengan Python).
// historyVerbose: riwayat game sejauh ini [{from,to,promotion}] untuk hitungan
// repetisi (seperti g["moves"] di loop game Python). Bila kosong, repetisi
// dihitung hanya dari posisi saat ini (rep=1), sama dengan harness uji.
export function bestMove(fen, nodeBudget = DEFAULT_NODES, historyVerbose = []) {
  const eng = new Engine();
  eng.loadFen(fen);
  eng.nodeLimit = nodeBudget;
  eng.TT = new Map();
  eng.killers = Array.from({ length: 128 }, () => [0, 0]);
  eng.rep = new Map();
  if (historyVerbose.length === 0) {
    eng.rep.set(eng.pkey(), 1);
  } else {
    // Replay riwayat dari posisi awal (seperti loop game Python) untuk rep.
    const replay = new Engine();
    replay.loadFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    replay.rep.set(replay.pkey(), 1);
    for (const mv of historyVerbose) {
      const f = sqOf(mv.from), t = sqOf(mv.to);
      const pr = mv.promotion ? ' pnbrqk'.indexOf(mv.promotion) : 0;
      if (!replay.make(f | (t << 7) | (pr << 14))) break;
      const k = replay.pkey();
      replay.rep.set(k, (replay.rep.get(k) || 0) + 1);
    }
    eng.rep = replay.rep;
  }
  const res = eng.searchRoot();
  if (!res) return null;
  const u = uciOfInt(res.move);
  return {
    from: u.slice(0, 2),
    to: u.slice(2, 4),
    promotion: u.length > 4 ? u[4] : undefined,
    score: res.score,
    nodes: res.nodes,
    depth: res.depth,
  };
}
