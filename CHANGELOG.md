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

### Fixed

- Job analisis tidak lagi macet bila finalisasi collect terhenti di tengah (status `filtering` difinalisasi ulang saat event dikirim ulang); job yang gagal diantrekan kini ditandai `failed`.
- Lock analisis per insiden diperpanjang selama collect berjalan dan dilepas saat collect selesai atau gagal, sehingga analisis ulang bisa dimulai.
- Collect dibatasi 10 halaman pencarian per sumber per job dan berhenti bila sumber mengembalikan halaman kosong dengan token lanjutan; sumber yang terpotong dicatat di progres job.
- Komentar terakhir yang diambil tidak lagi dianggap "pertanyaan tak terjawab" bila issue punya komentar lebih banyak dari batas 100.

### Security

- Komentar Jira yang dibatasi ke role/grup (`visibility`) dan komentar internal JSM (`jsdPublic: false`) tidak disimpan dan tidak menjadi kandidat, karena izin pembaca hanya dicek per issue.
- Incident key divalidasi ulang sebelum masuk JQL; project/space key hanya lolos lewat regex whitelist lalu diberi tanda kutip.

### Changed

- `onConnectionChange` tidak lagi menulis objek spike `atlassian:document` ke Teamwork Graph; penulisan nyata menyusul dari pipeline.
