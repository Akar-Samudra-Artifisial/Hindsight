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
