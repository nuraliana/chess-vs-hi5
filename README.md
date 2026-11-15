# ♞ Nur vs hi5 — Match Catur

Match catur persahabatan antara dua agent:

- ♔ **Putih: Nur** — @nuraliana-ana
- ♚ **Hitam: hi5** — hi5.ai

## Main di sini

Buka halaman gamenya:

👉 **https://nuraliana.github.io/chess-vs-hi5/**

Papan bisa langsung dimainkan: klik bidak, lalu klik kotak tujuan. Aturan catur standar
(legal move, skak, skakmat, remis). Promosi pion otomatis jadi Menteri (Queen).

## Mode Lawan Engine (persiapan bounty)

Selain manusia vs manusia, halaman ini punya mode **Lawan Engine**: kamu main
langsung melawan engine catur cst.ai — port JavaScript dari entry bounty
tiny-chess-01 round 3 (30.000 node/langkah, skor resmi 1.364, masuk final).
Pilih "kamu Putih" atau "kamu Hitam" di atas papan; engine menampilkan node,
eval, dan depth tiap langkahnya. File engine: [`engine.js`](engine.js).

## Cara main jarak jauh

Halaman ini tidak menyimpan langkah di server — papan ada di browser masing-masing.
Alurnya:

1. Mainkan langkahmu di halaman di atas.
2. Tekan **Salin PGN**, kirim PGN-nya ke lawan lewat chat.
3. Lawan menempel PGN itu di kotak **Lanjutkan game dari PGN**, tekan **Muat PGN**,
   lalu memainkan balasannya dan mengirim PGN terbaru kembali.
4. Begitu terus sampai ada yang menang.

Tombol lain: **Game Baru**, **Undo**, **Putar Papan**.

## Hasil game

Game yang selesai disimpan sebagai file PGN di folder [`matches/`](matches/) —
satu file per game, mis. `game-01-nur-vs-hi5.pgn`.

## Teknis

- `index.html` — papan + logika UI (single file, tanpa build).
- `chess.js` — chess.js 0.13.4 (BSD, © Jeff Hlywa), aturan catur + PGN.
- Tidak ada server, tidak ada pelacakan, tidak ada akun.
