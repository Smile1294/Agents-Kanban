---
name: scheduling
description: Scheduled runs — a brief that starts a new session at a set time on set weekdays; the next-fire and catch-up rules, persistence, the schedule_* board tools and the settings-page section
paths:
  - src/board/schedules.ts
tests:
  - src/board/__tests__/schedule.test.ts
  - src/board/__tests__/settings-schedule.test.mjs
  - smoke.mjs
last_verified: 2026-09-07
---
# Scheduling

## Owns

Time triggers: a `Schedule` (`title`, `prompt`, `hour`, `minute`, `days`,
`enabled`, `createdBy`, `lastFiredAt`) that starts a NEW session with a fixed
brief, in its own worktree, on the board like any other card. The honest model
is catch-up, not cron: a schedule fires only while the extension is running.

## Files

**`src/board/schedules.ts`**. The pure half. `nextFireAt(schedule, after)` —
anchored to `lastFiredAt`, which is what makes a missed window fire ONCE, not
once per missed day; dates are built from the local clock, so DST shifts a fire
by an hour rather than dropping or doubling it. `parseSchedules(raw)` (what is
read back from `workspaceState` is parsed, not cast), `parseScheduleDraft(raw)`
(the settings form or the `schedule_create` tool), `describeWhen(s)`,
`DAY_NAMES`, `ScheduleRun`. Test: `schedule.test.ts`.

The firing half lives in `src/extension.ts` (owned by
[extension-host.md](extension-host.md)): schedules persist under the
`workspaceState` key `schedules`; a `setInterval` calls `fireDueSchedules()`
with a re-entrancy guard, a catch-up pass runs at activation, `canRunScheduled()`
requires a repository, and `fireScheduleNow()` stamps `lastFiredAt` BEFORE the
launch (a crash between persist and start costs one run, never a double fire)
then calls `AgentManager.start()` with the schedule's prompt. The tools
(`schedule_list`, `schedule_create`, `schedule_delete`, `schedule_run`) are
defined in `src/agent/tools.ts` and stamp `createdBy` from the session title; the
three writes are in `ASKS_FIRST`. The settings page (`scheduledSection` in
`media/settings.js`) lists, edits, toggles, runs and deletes them, marks
agent-created ones with a badge, and shows a schedule that cannot fire (no repo)
as DUE, never as failed.

## How it works

Settings page or tool → `parseScheduleDraft` → saved to `workspaceState` →
`refreshAll()`. Every tick, `fireDueSchedules()` asks `nextFireAt(s,
s.lastFiredAt)` for each enabled schedule; a moment at or before now fires
`fireScheduleNow(s)`. A moment that passed while the window was closed is
caught up once at the next check. The fired session's card title is the
schedule's title.

## Change recipes

- **A new field on a schedule.** `Schedule` + `parseSchedules` +
  `parseScheduleDraft` here; the form in `media/settings.js`; the tool schema in
  `tools.ts`; a round trip in `schedule.test.ts` (and the persistence round trip
  in `smoke.mjs`).
- **A new recurrence rule.** `nextFireAt` — keep the catch-up anchored to
  `lastFiredAt` and test a missed multi-day window fires exactly once.

## Invariants

- Catch-up fires once per missed window, never once per missed day.
- `lastFiredAt` is stamped before the launch.
- Creating, deleting and running a schedule from an agent asks first — it
  starts sessions that cost money — and the creator is recorded.
- A schedule that cannot fire is shown as due, not as failed.

## Open work

- None recorded. (Nimbalyst's `schedule_wakeup` row is ✅ in NIMBALYST.md §11.)

## Recent changes

- 2026-09-07 · task/S5kc3 · area file created from the codebase audit.
