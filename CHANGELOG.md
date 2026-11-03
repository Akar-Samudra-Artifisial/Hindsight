# Changelog

Semua perubahan penting pada proyek ini dicatat di file ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), dan proyek ini memakai [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Kebijakan privasi `docs/PRIVACY.md` untuk listing Marketplace dan Developer Console.
- Ketentuan layanan `docs/TERMS.md`.
- Lisensi MIT (`LICENSE`).
- `README.md` awal dengan status pengembangan dan tautan ke dokumen privasi dan ketentuan.
- Scaffold app Forge: `manifest.yml` lengkap (issue panel JSM, global page, admin page, trigger event kerja dan lifecycle, tujuh antrean consumer, retensi harian, Forge SQL, Forge LLM, agen Rovo dengan enam action, `rovo:skill` `early-signal-investigation`, `rovo:mcp` read-only, dan `graph:connector` Teamwork Graph). App didaftarkan lewat `forge register`, lolos `forge lint`, dan versi 2.0.0 ter-deploy ke environment development (eligible Runs on Atlassian).
- Handler stub untuk semua fungsi, validasi input `incidentKey` dan `windowDays` beserta test Vitest, prompt agen, `SKILL.md`, dan UI placeholder per view yang di-build esbuild ke `static/<view>/build`.
- Tooling npm: `test`, `typecheck`, `build:ui`, `build`, `lint`, `deploy`.
- Spike Teamwork Graph: baca `atlassianUserInTeams` dan `atlassianUserAssignedJiraWorkItems` dari resolver `twgSpike`, serta tulis objek `atlassian:document` lewat `graph.setObjects` dari handler `onConnectionChange` (terbukti 3 Nov 2026, v2.1.0 development).
- Skema Forge SQL v001–v008 (settings, app_locks, graph_connection, service_mappings, incidents, events, analysis_jobs, signal_candidates). Migrasi berjalan otomatis setelah install/upgrade lewat antrean `schema-migrate`, dengan jeda saat limit DDL tercapai; halaman lain menampilkan "setting up" sampai selesai.
- Connector Teamwork Graph kini menyimpan `connectionId` (beserta nama connection) saat diaktifkan, diperbarui, atau dihapus; bila database belum siap, perubahan diantrekan dan disimpan setelah migrasi selesai. Halaman setup menampilkan status database dan "Connector: connected/not connected".
- Pipeline collect: antrean `collect` mengumpulkan issue Jira/JSM beserta komentarnya (maks. 500 issue per analisis, 100 komentar per issue) serta halaman dan komentar Confluence dalam cakupan service insiden. Berjalan bertahap dan bisa dilanjutkan dari cursor; saat kena limit 429 diantrekan ulang setelah 60 detik (maks. 3 kali). Isi artefak tidak disimpan, hanya referensi dan hash teks.
- Filter deterministik kandidat sinyal: skor dari service, component, kata kunci insiden, kata risiko, pertanyaan tak terjawab, dan tiket JSM yang ditutup tanpa perbaikan; 200 kandidat teratas disimpan, sisanya ditandai terpotong.
- Panel insiden: tombol "Analyze" dengan status job, funnel (scanned → stored → candidates), dan daftar kandidat. Kandidat hanya ditampilkan bila pengguna berhak melihat artefaknya; sisanya hanya dihitung.
- Scope `search:confluence` untuk pencarian CQL Confluence (perlu `forge install --upgrade`).
- Uji nyata di site dev (3 Nov 2026, v3.1.0): migrasi 8/8 selesai (dipicu saat halaman dibuka karena deploy minor tidak memicu event upgrade), `connectionId` tersimpan saat connector diputus dan disambung ulang, dan Analyze berjalan end-to-end pada insiden JSM (12 artefak dipindai, 0 kandidat; penilaian AI masih stub).
- Data demo Arkana Commerce: tombol "Load demo data" di halaman setup membuat project Jira `PAY`, project JSM `INC`, space Confluence `PLAT` (atau memakai yang sudah ada), sekitar 50 work item, tiket, halaman, dan komentar (tiga sinyal awal di antara 40 pengalih), lalu insiden "Checkout payments failing" paling akhir. Tiap artefak diberi waktu skenario relatif terhadap awal insiden, berjalan di antrean `demo-seed` dengan progres 10 langkah, bisa dilanjutkan bila waktu habis atau kena limit 429, dan tidak menggandakan artefak bila diklik ulang.
- "Reset to showcase" menghapus analisis insiden demo dan menulis ulang waktu skenario tanpa membuat ulang artefak; "Remove demo data" menghapus hanya issue dan halaman yang dibuat app (project, space, dan service mapping tetap).
- Form service mapping di halaman setup (tambah, ubah, hapus; maksimal 50 mapping, 20 nilai per daftar) dengan validasi input. Semua aksi setup hanya untuk administrator Jira yang membuka halaman setup.
- Dossier Teamwork Graph: setelah analisis, antrean `score` menulis dokumen "Early signals for <insiden>" lewat connection connector yang tersimpan. Isinya hanya jumlah kandidat, jarak hari sinyal paling awal, dan key insiden (tanpa kutipan atau judul artefak). Tanpa connection penulisan dilewati. Halaman setup punya tombol "Write test dossier" dan menampilkan hasil terakhir.
- Panel insiden menampilkan lencana "Simulated history" untuk insiden demo.
- Skema Forge SQL v009 `demo_artifacts` untuk pencatatan artefak demo.
- Scope baru `manage:jira-project`, `manage:jira-configuration`, `write:confluence-space`, `write:comment:confluence`, `delete:page:confluence` untuk data demo (major version; perlu `forge install --upgrade`). Penghapusan issue memakai `write:jira-work` yang sudah ada.
- Penilaian kandidat dengan Forge LLM di antrean `score`: batch 10 kandidat, forced tool call `score_candidates`, temperature 0, prompt `score-v1` (`src/llm/prompts.ts`, salinan `prompts/score.md`) yang menandai isi artefak sebagai data tak tepercaya dan meminta alasan blameless. Model FAST `claude-haiku-4-5-20251001` dipilih lewat `list()` dengan fallback ke model Haiku/Sonnet aktif; model dan versi prompt disimpan di job. Bisa dilanjutkan bila waktu habis; 429 diantrekan ulang setelah 60 detik (maks. 3 kali); tanpa model aktif job gagal dengan pesan "No Forge LLM model available". Job kini berakhir `done` setelah penilaian.
- Verifikasi kutipan: kutipan LLM harus ada di excerpt kandidat setelah normalisasi (15–300 karakter); bila tidak, kandidat ditandai `score_failed` (`quote_not_found`). Keluaran tidak valid dicoba ulang sekali, lalu `llm_invalid_output`.
- Skema Forge SQL v010 `signals`, v011 `signal_decisions`, v012 kolom `signal_candidates.score_error`. Sinyal unik per insiden + artefak; analisis ulang tidak mengubah sinyal yang sudah dikonfirmasi atau ditolak.
- Signal card di panel insiden: jenis sinyal, jarak hari, keyakinan, kutipan verbatim, link ke Jira/Confluence, tombol Confirm/Reject/Undo, progres "Scoring candidates with AI (n/total)", status kosong, dan banner gagal dengan Retry. Keputusan dicatat (accountId hanya untuk audit, tidak dikirim ke UI/Rovo).
- Action Rovo `find-prior-signals` mengembalikan sinyal yang boleh dilihat pengguna, dan `confirm-signal` mengonfirmasi/menolak sinyal lewat aturan yang sama dengan panel.
- Kutipan sinyal disimpan sebagai potongan verbatim dari excerpt sumber (rentang yang cocok), bukan teks yang ditulis model. Alasan sinyal dibersihkan dari accountId, email, dan @mention ("someone").
- Panel membedakan kandidat gagal karena kutipan tidak ditemukan dan karena jawaban AI tidak bisa dipakai.
- Uji nyata minggu 3 di site dev (3 Nov 2026, v4.5.0): migrasi 12/12; Forge LLM memilih `claude-haiku-4-5-20251001` dan `claude-sonnet-4-6` lewat `list()` (fallback tidak terpakai); Analyze insiden demo INC-60 selesai dalam ~18 detik (48 artefak dipindai → 5 kandidat → 4 sinyal dengan kutipan verbatim lolos verifikasi, 2.302 token); Confirm/Reject/Undo bertahan setelah reload; Remove demo data menghapus dossier dari Rovo Search. Lewat chat agen Rovo Hindsight Investigator, `find-prior-signals` menjawab 4 sinyal yang sama dengan panel (2,43 detik), dan `confirm-signal` meminta konfirmasi lewat form "Please review" sebelum mengonfirmasi sinyal INC-46 (tercatat `via: 'rovo'`, tampil Confirmed di panel).
- Skema Forge SQL v013 `reach_paths` (satu jalur jangkauan per sinyal, hanya nama tim/peran tanpa accountId) dan v014 `routes` (rute usulan unik per insiden asal + sumber). Repo: simpan/baca jalur jangkauan dan rute; hitung ulang tidak pernah menurunkan rute `active`; Reset/Remove demo data ikut menghapus keduanya.
- Pembacaan Teamwork Graph `teamsOf` (`atlassianUserInTeams` untuk account id mana pun) dan kontributor halaman Confluence (`confluencePageContributors`), di-cache per request.
- Reach sinyal: tombol "Trace reach" di panel insiden dan action Rovo `trace-signal-reach` (input `signalId` opsional) menelusuri, dengan sesi pengguna, siapa yang menyentuh artefak tiap sinyal confirmed (penulis/komentator, watcher Jira, kontributor halaman Confluence; akun app dikecualikan), team mereka lewat Teamwork Graph, dan apakah team responder (owner team mapping service) tersentuh sebelum insiden. Hasil per sinyal disimpan tanpa accountId; budget 18 detik dan maks. 20 sinyal per panggilan, sisanya "Partial" dengan tombol "Trace remaining"; 429 menghentikan penelusuran.
- Metrik reach (hanya sinyal confirmed): first signal, awareness gap, reached/confirmed (graph tak dikenal dikeluarkan dari penyebut, "time unknown" untuk sentuhan tanpa waktu) dan stop point "Stopped at X · 1 missing link to Y". Tanpa owner team id: "Graph context not available", bukan 0.
- Rute deterministik tanpa LLM: satu rute per sumber (space Confluence / project Jira / component / label) dari sinyal confirmed yang tidak sampai ke team responder, dengan perkiraan hari dihemat berbobot confidence ("~11 days earlier (up to 12) — assumes the mention is read and acted on"). Action `propose-routes` mengembalikan `routeId`; tombol "Approve" di panel dan action `create-route` mengaktifkan rute (hitung ulang tidak menurunkan rute aktif).
- Panel insiden: strip tiga metrik, tab Signals | Reach map | Routes, peta SVG tiga kolom (artefak → team yang menyentuh → team responder, node stop berpinggir merah, link hilang putus-putus) beserta daftar teks untuk pembaca layar.
- Dossier Teamwork Graph memuat blok angka reach dan rute teratas (tanpa kutipan, nama orang, atau nama team); diperbarui lewat consumer `score` setelah trace, propose, dan approve.
- Setup (admin): "Stamp demo data" menambahkan catatan "Reviewed by" ke halaman vendor demo dan menjadikan admin watcher story PAY serta dua tiket INC, agar data demo punya sentuhan manusia di Teamwork Graph.
- Prompt agen dan skill `early-signal-investigation` mengikuti urutan find → trace → propose → create.
- Spike sementara di halaman setup (khusus admin): "Run team membership spike" menguji apakah sesi pengguna bisa membaca keanggotaan team akun lain; balasan dan log hanya memuat accountId yang disingkat.
- Uji nyata minggu 4 di site dev (3 Nov 2026, v4.7.0, diulang v4.8.0): dengan team demo Arkana Platform, Arkana Payments, dan Arkana Support (dibuat manual) dan owner team `checkout` diisi lewat form setup, "Stamp demo data" selesai (1 halaman, 3 watcher, 0 gagal). INC-60 dengan 4 sinyal confirmed: first signal 12 hari, awareness gap 12 hari, reach 0/4, semua "Stopped at Arkana Platform · 1 missing link to Arkana Payments"; tiga rute usulan PLAT ~11 hari (up to 12), INC ~5, PAY ~3; Approve rute PLAT → Active dan bertahan setelah reload. Lewat chat Hindsight Investigator, `trace-signal-reach` dan `propose-routes` dipanggil dengan angka yang sama dengan panel dan status ACTIVE disebut. Sesi pengguna terbukti bisa membaca keanggotaan team akun lain lewat `atlassianUserInTeams`. Skill `early-signal-investigation` dipakai di Rovo Studio, dan tool MCP diaktifkan di admin.atlassian.com ("Expose tools to MCP-compatible apps"); uji klien MCP eksternal belum. Menambah input action opsional cukup deploy minor (4.7.0).

### Fixed

- Rute aktif kini ikut menerima alasan, perkiraan hari dihemat, `max_days_before`, `signal_ids`, dan skor terbaru saat trace ulang (sebelumnya alasan basi, mis. "stopped at no team"). Status `active`, aturan yang disetujui (`spec_json`), peringkat, `decided_by`, dan `activated_at` tetap tidak berubah.
- Insiden demo: hasil "Analyze again" stabil. Consumer `score` memakai ulang vonis LLM yang tersimpan per (insiden, event, hash teks, versi prompt), baik yang menjadi sinyal maupun yang dinilai tidak relevan, dan hanya mengirim kandidat baru ke LLM (tabel baru `score_cache`, migrasi v015; log `score cache { hits, misses }`). Reset to showcase dan Remove demo data mengosongkan cache insiden itu. Insiden non-demo tidak berubah.

- Reach: akun app tidak lagi dihitung sebagai orang. `GET /rest/api/3/myself` sebagai app ditolak (401, scope tidak cocok), jadi akun app dikenali dari `accountType: 'app'` penulis issue/komentar/halaman saat collect (disimpan tanpa penulis, id-nya diingat di settings) dan dari watcher bertipe app. Data lama perlu "Analyze again" agar id app terkumpul.
- Reach halaman Confluence: penyunting versi halaman (dibaca sebagai pengguna) ikut dihitung sebagai kontributor, sehingga stempel "Reviewed by" langsung terbaca walau Teamwork Graph belum mengindeks kontributor. Stop point kini tim yang menyentuh paling akhir, bukan "no team" dari akun app.
- "Trace remaining" kini maju: sinyal tanpa jalur yang diketahui ditelusuri lebih dulu, dan jalur `ok` yang tersimpan tidak pernah ditimpa `pending`/`unknown`. Batas waktu juga diperiksa di antara lookup team dalam satu sinyal; tanggal tidak valid tidak lagi melempar error (dihitung "time unknown").
- Rute dan baseline hanya memakai sinyal dengan graph `ok`; pesan "tidak ada rute" membedakan "semua sudah sampai", "belum ada konteks graph", dan "tidak ada sumber". Urutan rute ditampilkan ulang 1..n (rute aktif menyimpan peringkat lama).
- Jawaban action trace/propose menyebut status tiap rute (termasuk yang sudah ACTIVE).
- Peta reach mencocokkan team responder lewat id team, bukan nama.
- Analisis ulang tidak lagi menghapus sinyal milik analisis lain yang berjalan paralel: pembersihan sinyal `proposed` lama hanya menyentuh job yang dibuat lebih dulu, berjalan sebelum job ditandai `done` (bisa diulang saat redelivery), mempertahankan sinyal lama untuk kandidat yang gagal dinilai, dan ikut menghapus riwayat keputusannya. Analyze juga mengembalikan job yang masih menilai (diperbarui dalam 30 menit terakhir) alih-alih memulai job kedua.
- "Reset to showcase" dan "Remove demo data" mengosongkan status dossier terakhir di halaman setup.

- "Remove demo data" kini juga menghapus dossier Teamwork Graph insiden demo dari Rovo Search. Setiap dossier demo yang ditulis dicatat di setting `dossier_ids`, lalu dihapus lewat `deleteObjectsByExternalId` dengan connection aktif (tanpa connection: dilewati). Bila penghapusan gagal, hasil job memuat peringatan, Remove tetap selesai, dan id tetap tercatat untuk dicoba lagi. Dossier yatim dari sebelum perbaikan ini (tidak tercatat) hilang dengan memutus lalu menyambung ulang connector.
- Halaman setup kini selalu menampilkan status project/space demo setelah job selesai: peringatan untuk project/space yang sudah ada sebelumnya, dan catatan untuk project/space yang dibuat Hindsight pada Load sebelumnya dan dipertahankan oleh Remove.
- Penutupan tiket demo S2 dan insiden selalu tercatat: baris log per tiket (berhasil: slot, key, status, resolusi; gagal: slot dan transisi yang tersedia) serta ringkasan `closures` di baris log `demo load` dan di hasil job.
- Link kandidat Jira di panel insiden dan URL dossier di Rovo Search kini mengarah ke site (`https://<site>.atlassian.net/browse/...`), bukan ke `api.atlassian.com`. Base URL diambil dari `serverInfo.baseUrl`; link Jira yang sudah tersimpan diperbaiki saat Analyze berikutnya.
- Insiden demo kini ditutup lewat transisi Resolve/Done/Close, bukan Cancel/Reject; bila status awal tidak punya transisi ke Done, app melewati hingga dua status perantara. Setiap penutupan issue demo (termasuk tiket S2 "Cannot Reproduce") dicatat di log dengan slot, status, dan resolusi.
- Load demo data tidak lagi bisa menggandakan issue atau meninggalkan issue yang tak terhapus Remove bila limit 429 terjadi saat fallback pembuatan satu per satu: semua hasil bulk create dicatat dulu.
- Pesan "Ran out of time" kini menyebut tombol yang sesuai (Load demo data, Reset to showcase, atau Remove demo data).
- Job demo yang pengirimannya mati di tengah jalan dilanjutkan saat event dikirim ulang (lock jalan 13 menit, di bawah timeout 900 detik); bila antre ulang setelah 429 gagal, job langsung ditandai gagal alih-alih macet sampai 15 menit.
- "Write test dossier" hanya memakai analisis yang collect-nya sudah selesai dan menampilkan pesan jelas bila belum ada; antrean `score` melewati dossier untuk job yang belum selesai atau gagal.
- Job analisis tidak lagi macet bila finalisasi collect terhenti di tengah (status `filtering` difinalisasi ulang saat event dikirim ulang); job yang gagal diantrekan kini ditandai `failed`.
- Lock analisis per insiden diperpanjang selama collect berjalan dan dilepas saat collect selesai atau gagal, sehingga analisis ulang bisa dimulai.
- Collect dibatasi 10 halaman pencarian per sumber per job dan berhenti bila sumber mengembalikan halaman kosong dengan token lanjutan; sumber yang terpotong dicatat di progres job.
- Komentar terakhir yang diambil tidak lagi dianggap "pertanyaan tak terjawab" bila issue punya komentar lebih banyak dari batas 100.

### Security

- Metrik dan daftar rute reach hanya dihitung dari sinyal yang bisa dilihat pemanggil; rute yang seluruh sinyalnya tak terlihat disembunyikan dan tidak dihapus oleh pemanggil itu.
- Dossier Teamwork Graph (terlihat semua orang) hanya menyebut tipe sumber rute teratas ("a Confluence space"), bukan key-nya.
- Action reach: cloudId diambil dari context pemanggil lebih dulu (payload hanya fallback tervalidasi), dan balasan memuat catatan bahwa nama team/space/project/label adalah data tak tepercaya.
- Langkah reach yang tersimpan membulatkan waktu ke hari, dan node "people in no team" tidak membawa peran atau waktu.
- Prompt penilai `score-v2`: ringkasan dan kata kunci insiden juga dibungkus elemen data tak tepercaya `<incident>`.
- Deskripsi action `confirm-signal` dan prompt agen: hanya dipanggil atas permintaan eksplisit pengguna untuk sinyal tertentu. Keluaran `find-prior-signals` menandai `quote`, `title`, `reason` sebagai teks tak tepercaya (`untrustedFields`, `untrustedNote`).
- Signal card hanya merender link `https:`; URL lain tampil sebagai teks.

- Dossier Teamwork Graph (terlihat semua pengguna site) hanya ditulis untuk insiden demo. Penulisan untuk semua insiden adalah opt-in admin lewat setting `dossier_all_incidents` (default mati; UI menyusul minggu 6).
- Komentar Jira yang dibatasi ke role/grup (`visibility`) dan komentar internal JSM (`jsdPublic: false`) tidak disimpan dan tidak menjadi kandidat, karena izin pembaca hanya dicek per issue.
- Incident key divalidasi ulang sebelum masuk JQL; project/space key hanya lolos lewat regex whitelist lalu diberi tanda kutip.

### Changed

- Setup: setelah Load/Reset selesai tampil checklist pra-rekam ("Before recording: … Do not Reset or Analyze again while recording.").
- `onConnectionChange` tidak lagi menulis objek spike `atlassian:document` ke Teamwork Graph; penulisan nyata menyusul dari pipeline.
- Antrean `score` kini menulis dossier ke Teamwork Graph setelah tiap analisis. Setelah penilaian AI, dossier memuat jumlah sinyal (bukan kandidat) beserta sinyal paling awal; tetap tanpa kutipan atau nama.
- Panel insiden menampilkan sinyal yang sudah dinilai, bukan lagi daftar kandidat mentah.
- "Reset to showcase" dan "Remove demo data" juga menghapus sinyal dan keputusan sinyal insiden demo.
- Load dan Reset hanya membuat service mapping `checkout` bila belum ada; editan admin tidak lagi ditimpa.
- Bila project `PAY`/`INC` atau space `PLAT` sudah ada, progres job dan halaman setup menampilkan peringatan bahwa data demo ditambahkan ke sana dan dihapus oleh Remove demo data.
