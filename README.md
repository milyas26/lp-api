# lp-agent: backend (bot)

Agent otomatis buat LP di **Meteora DLMM** (Solana). Jalan sendiri di server dari awal sampai akhir: **screening → keputusan → open posisi → kelola → close → zap out ke SOL**. Logika strateginya diterjemahkan dari materi di [`dlmm/materi`](dlmm/materi/00-INDEX.md).

> Software ini belum diaudit dan menggerakkan dana asli. Mulai dengan `DRY_RUN=true` (paper trading), lalu wallet khusus bot dengan modal kecil. Bukan nasihat keuangan.

## Satu siklus (default tiap 60 detik)

```
1. Market regime   SOL turun ≥4%/1h atau ≥10%/24h → close semua, pause (Modul 9.4)
2. Manage          tiap posisi: valuasi dalam SOL → exit rules → claim & jual fee token
3. Gate            daily loss limit, max posisi, budget deploy
4. Screening       Meteora Data API → filter (mcap >$1M, umur ≥1 hari, volume, fee/TVL, bin step)
5. Keputusan       AI loop (DeepSeek): analisa chart, cek risiko, bandingkan bin step, simulasi,
                   lalu pilih pool + bin step + strategi + shape + range + size, atau tidak buka.
                   Tanpa DEEPSEEK_API_KEY: rule engine (fase → strategi → shape + range + size).
6. Pagar           keputusan AI dicek ulang oleh rule sebelum dieksekusi
7. Open            one-sided SOL di bawah harga, satu entry per siklus
```

### Fase token → strategi (Modul 7.1)

| Fase (deteksi otomatis) | Strategi | Shape / range | SL / TP / max hold |
|---|---|---|---|
| Baru nge-top / ketinggalan run-up | S2 wide bid-ask | BidAsk −65% (cap besar lebih sempit, bawah di bawah support 24h) | −22% / +20% / 72j |
| Post-top, mcap ≥ $20M | S1 play the drop | BidAsk −35…−50% | −20% / +15% / 24j |
| Udah dump ≥55% dan stabil | S10 post-dump | Spot −50% | −15% / +12% / 24j |
| Umur ≥3 hari, ranging | S8 slow cook | Spot −40…−65% | −15% / +25% / 7 hari |
| Run-up + volume gila (`ALLOW_AGGRESSIVE`) | S4 heart attack | Spot −20% | −6% / +8% / 2j |
| Falling knife / volume mati | skip | | |

Size per posisi ikut mcap (3% / 5% / 8% / 12% bankroll), dikecilkan kalau ada warning RugCheck, indikasi PvP, atau hari Sabtu.

### Exit rules (Modul 8.5, 9.2): dieksekusi tanpa debat

Diurutkan dari yang paling penting buat bertahan hidup:

1. **Rug candle**: candle 15m atau antar-siklus turun ≥40% → close + zap out
2. **Stop loss** per strategi (P&L posisi termasuk fee)
3. **Out of range bawah** terlalu lama → close (pelajaran Dog 10M→1M)
4. **Take profit**
5. **Bounce exit**: dump masuk dalam ke range, lalu harga balik ke atas dengan profit → kunci
6. **Pumped out top** setelah sempat terisi → close (semua SOL + fee)
7. **Idle**: range nggak pernah kesentuh 90 menit → close, nanti re-range
8. **Volume decay**: volume 1h < 25% rata-rata → "risk signals", keluar
9. **Max hold**

Fee token di-claim dan langsung dijual ke SOL lewat Jupiter (`SELL_FEE_TOKENS`).

### Keputusan entry oleh AI: DeepSeek dalam loop (opsional)

Isi `DEEPSEEK_API_KEY` di `.env`, AI langsung aktif (`LLM_ENABLED=false` untuk mematikan, model lewat `LLM_MODEL`). Tiap siklus, kandidat teratas hasil screening (`DEEP_CHECK_COUNT`) diserahkan ke DeepSeek bersama bankroll, budget, kondisi SOL, dan posisi yang sedang terbuka. AI bekerja dalam loop function calling (maksimal `LLM_MAX_STEPS` putaran) dengan tool berikut:

| Tool | Isi |
|---|---|
| `analyze_token` | chart 15m: ATH, drawdown, perubahan 1/6/24 jam, swing, stabil, volume dan trennya, fee/TVL, porsi Meteora, fase lifecycle, draft rencana rule engine |
| `check_risk` | RugCheck (danger/warning) dan PvP ticker kembaran |
| `compare_bin_steps` | semua pool DLMM token itu (bin step berbeda, termasuk dari DexScreener): TVL, volume, fee/TVL, base fee, jumlah bin untuk range yang diminta, muat atau tidak, rent bin array (live) |
| `simulate_position` | nilai posisi kalau harga turun 5% sampai dasar range (IL sebelum fee) dan estimasi fee per hari |
| `skip_candidate` | coret kandidat (jurnal + cooldown 30 menit) |
| `open_position` / `skip_all` | keputusan akhir |

**Pagar keras** yang tidak bisa ditembus AI (dicek ulang di kode, `open_position` ditolak dan AI boleh memperbaiki): token sudah dianalisa dan dicek risiko, tidak ada danger RugCheck, PvP < 30%, fase bukan DEAD/FALLING_KNIFE, umur ≥ `MIN_AGE_HOURS`, range 15-85%, jumlah bin ≤ `MAX_BINS_PER_POSITION`, confidence ≥ 0.55, size dipotong ke batas (min `MAX_POSITION_SOL`, budget, bankroll × 1.5 × size dasar per mcap, dikurangi untuk warning RugCheck dan hari Sabtu), stop loss hanya boleh lebih ketat dari template strategi. Exit rules ikut template strategi yang dipilih. Kalau API gagal di tengah loop, tidak ada posisi baru (fail-closed). Kandidat yang sudah dianalisa saat AI memilih `skip_all` masuk cooldown 30 menit supaya tidak dibaca ulang tiap siklus.

Setiap putaran (pertimbangan AI, tiap tool, penolakan pagar, keputusan) dikirim ke dashboard sebagai langkah siklus. **Exit tidak pernah diserahkan ke LLM**: stop loss tetap rule.

## Penyimpanan: PostgreSQL + Prisma

`DATABASE_URL` wajib (mis. `postgresql://USER@localhost:5432/lp-agent`). Skema ada di [`prisma/schema.prisma`](prisma/schema.prisma), migrasi di `prisma/migrations`:

| Tabel (model) | Isi |
|---|---|
| `positions` (`Position`) | semua posisi, terbuka dan sudah ditutup (`status`, `realized_sol`, `close_reason`, `bin_step`, `decided_by`, ...). Data lengkap posisi di kolom `data` (jsonb) |
| `bot_state` (`BotState`) | satu baris: statistik hari ini, cooldown pool, saldo paper |
| `journal` (`JournalEntry`) | semua open, close, claim, skip, halt |
| `cycles` (`Cycle`) | siklus yang selesai beserta langkah dan jejak keputusan AI, jadi dashboard tetap punya riwayat setelah restart |

```bash
npm run db:migrate        # terapkan migrasi (prisma migrate deploy)
npm run db:migrate:dev    # setelah mengubah schema.prisma: buat migrasi baru
npm run db:studio         # lihat isi tabel di browser
npm run import-legacy     # sekali saja: impor data/state.json + data/journal.jsonl ke tabel yang masih kosong
```

Contoh query:

```bash
psql -d lp-agent -c "select pool_name, strategy, bin_step, realized_sol, close_reason from positions where status = 'closed' order by closed_at desc limit 20"
```

## Setup

```bash
npm install             # sekaligus prisma generate
cp .env.example .env    # isi RPC_URL, WALLET_PRIVATE_KEY, DATABASE_URL, cek semua threshold
createdb lp-agent
npm run db:migrate
```

Pakai RPC private buat live (public RPC sering gagal pas lagi rame).

## Jalanin

```bash
npm run once        # satu siklus, cocok buat cek
npm start           # loop terus
npm run status      # lihat posisi + P&L hari ini dari database
npm run close-all   # darurat: tutup semua posisi yang dibuka bot + zap out
```

`DRY_RUN=true` = paper trading: saldo virtual 10 SOL, harga & fee/TVL asli, nilai posisi disimulasikan per bin (cocok dengan tabel IL di Modul 4). Biarkan beberapa hari, baca jurnalnya (tabel `journal`), baru live.

### Server (Docker)

Jalankan dari folder root project (bukan folder ini), karena compose-nya menyalakan backend + dashboard sekaligus. Lihat [README root](../README.md).

Container menjalankan `prisma migrate deploy` lalu bot. Dari dalam container, `localhost` bukan mesin host: compose sudah memetakan `host.docker.internal`, jadi isi `DATABASE_URL=postgresql://USER@host.docker.internal:5432/lp-agent` (Postgres harus menerima koneksi dari jaringan Docker), atau pakai service Postgres sendiri. Restart aman: posisi dibaca ulang dari database + on-chain.

### API dashboard

Saat `npm start`, backend juga membuka API (Fastify) untuk [frontend](../frontend):

| Endpoint | Isi |
|---|---|
| `GET /api/overview` | status bot, snapshot (bankroll, posisi, batas), 30 siklus terakhir beserta langkahnya |
| `GET /api/stream` | Server-Sent Events: `hello`, `cycle` (tiap langkah berubah), `status`, `snapshot`, `ping` tiap 15 dtk |
| `GET /api/journal?limit=100&type=close` | jurnal terbaru dulu, `type` opsional |
| `GET /api/positions?closedLimit=50` | posisi terbuka + riwayat posisi yang sudah ditutup |
| `POST /api/opening` `{"paused": true}` | jeda / lanjutkan buka posisi baru (posisi yang ada tetap dikelola) |
| `POST /api/positions/:pubkey/close` | tutup satu posisi sekarang (alasan `manual`). Menunggu siklus yang sedang jalan selesai dulu |
| `GET /api/settings` | konfigurasi yang bisa diubah dari dashboard: nilai sekarang, nilai `.env`, dan apakah sedang ditimpa |
| `PUT /api/settings` `{"values": {"risk.dailyLossLimitSol": 0.5}}` | ubah konfigurasi (satuan tampilan: detik, menit). `null` mengembalikan ke nilai `.env`. Semua atau tidak sama sekali |

`API_TOKEN` adalah kata sandi API dashboard. Kalau diisi, semua endpoint kecuali `/api/health` butuh `Authorization: Bearer <API_TOKEN>` (atau `?token=` untuk stream), dan dashboard akan memintanya sekali. Wajib kalau `API_HOST` bukan localhost (misalnya backend di VPS). Tanpa `API_TOKEN`, API hanya listen di localhost dan request yang mengubah sesuatu (`POST`/`PUT`) hanya diterima dari halaman di localhost, supaya situs lain yang terbuka di browser yang sama tidak bisa menutup posisi atau mengubah pengaturan.

### Pengaturan dari dashboard

Batas posisi, screening, risiko, eksekusi, jeda siklus, dan putaran AI bisa diubah dari layar Pengaturan. Nilainya disimpan di tabel `settings` dan menimpa `backend/.env` sampai dikembalikan. Berlaku mulai siklus berikutnya, tanpa restart. Yang sengaja tidak bisa diubah dari dashboard: `DRY_RUN`, kunci wallet, RPC, API key DeepSeek, Telegram, `DATABASE_URL`, dan pengaturan API. Daftar lengkapnya di `src/modules/settings/domain/setting-definitions.ts`.

### Server (systemd)

```bash
npm ci && npm run build && npm run db:migrate
sudo cp deploy/lp-agent.service /etc/systemd/system/   # sesuaikan User/WorkingDirectory
sudo systemctl enable --now lp-agent
```

## Catatan penting

- Bot **cuma mengelola posisi yang dia buka sendiri**. Posisi manual di wallet yang sama dibiarkan (ada warning di log).
- Range >69 bins pakai extended position (rent lebih besar tapi balik saat close). Rent bin array baru **tidak balik**; pool yang butuh lebih dari `MAX_BIN_ARRAY_COST_SOL` di-skip.
- `SIGTERM`/`Ctrl+C` hanya menghentikan loop; posisi tetap terbuka. Pakai `close-all` kalau mau keluar total.
- Yang belum diotomasi dari materi: hybrid spot+bid-ask, flip, recovery position (S7), LP-out token-only di atas harga, sinyal smart wallet / KOL / Twitter. Semuanya butuh data atau penilaian yang belum ada sumber API-nya, atau terlalu berisiko buat bot tanpa pengawasan.

## Layout

Clean architecture per modul. Tiap modul punya `domain/` (tipe, aturan murni, interface repository), `application/` (use case), `infrastructure/` (Prisma, API luar, Solana), dan `http/` (route Fastify). Arah dependensi: http → application → domain, dan infrastructure mengimplementasikan interface di domain. Semua kelas konkret dirakit di `container.ts`.

```
prisma/                  schema.prisma + migrations
src/
  main.ts                CLI: run | once | status | close-all | import-legacy
  app.ts                 Fastify: CORS, auth token, error handler, route tiap modul di /api
  container.ts           composition root
  shared/                config, logger, http client, Prisma client, Telegram, keypair + konstanta Solana
  generated/prisma/      Prisma Client hasil generate (tidak di-commit)
  modules/
    activity/            tracer langkah siklus (dikirim ke dashboard) + repository siklus
    market/              kondisi SOL; klien GeckoTerminal, DexScreener, RugCheck
    screening/           Meteora Data API, ranker filter awal, cooldown kandidat
    strategy/            domain murni: fitur chart, playbook fase → strategi, range math, simulator paper
    decision/            EntryDecider: AiDecider (loop DeepSeek + tool research) atau RuleDecider
    execution/           DLMM SDK (open/close/claim/valuasi), Jupiter zap-out, kirim tx
    positions/           posisi + exit rules; ManagePositions, OpenPosition, ClosePosition; /api/positions
    journal/             jurnal; GET /api/journal
    settings/            konfigurasi yang bisa diubah dari dashboard, disimpan di DB; /api/settings
    bot/                 state harian, RunCycle, CloseAll, ImportLegacy, overview; /api/overview, /api/stream, /api/opening
```
