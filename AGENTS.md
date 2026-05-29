# Agent Startup

This repo uses Obsidian as the central project brain.

Before changing traffic accounting, live speed, rollups, dashboard labels,
security alerts, remote auth/push, map/device behavior, PPETO update delivery,
or data rewrites, read these Obsidian notes first:

1. `TendaTraffic/🏠 HOME.md`
2. `TendaTraffic/Project/Memory Brain.md`
3. `TendaTraffic/Skills/Diagnosis and Verification.md`
4. The relevant concern note:
   - `TendaTraffic/Data/SQLite Truth Sources.md`
   - `TendaTraffic/Architecture/System Overview.md`
   - `TendaTraffic/Architecture/Decisions and Constraints.md`
   - `TendaTraffic/Operations/Runbook.md`
   - `TendaTraffic/Project/Roadmap and Open Threads.md`
5. The latest note under `TendaTraffic/Sessions/`.

Core boundaries:

- Keep live speed router-only. Do not use host NIC, macOS counters, `netstat`,
  or monitor-machine traffic as production telemetry.
- Treat `samples_raw` as the first diagnosis base for accounting; rollups are
  derived caches and may need repair after logic changes.
- Do not claim a fix from code inspection alone. Verify through DB/API/browser
  evidence for the affected surface.
- Do not store secrets, raw `.env`, router passwords, push auth material,
  Telegram tokens, raw MACs, hostnames, or identifiable device telemetry in
  Obsidian.
