# Deployment notes — Tuesday, Sep 22, 2026

Covers items 2, 3, 4, 5 from Firstmac's latest feedback batch, plus one
newly-found bug (not from their feedback list, found while investigating
the shift filter — see below, and read this one first). Items 1 (login/
repeated registration) and 6 (data changing after refresh) are **not** in
this build — see the client email thread for why each is still open.

## Read this one first — most severe finding in this batch

**`manilaTimeOnDay` in `sprout.js` was silently breaking shift-boundary
calculation for every employee on their plain default weekly schedule
(i.e., anyone without an active schedule adjustment for that day) —
likely a large share of the workforce, not an edge case.**

Root cause: Sprout's `workSchedule.mondayFrom` (etc.) comes back as a
full `"HH:MM:SS"` string (confirmed via a real employee's raw data in
**sandbox** — `"09:00:00"`), but the function assumed a bare `"HH:MM"`
and appended a redundant `:00`, producing a malformed, unparseable
string. The existing guard nulls out the individual invalid field, but
left a null-but-truthy boundary object, which in turn left
`findShiftLogTimes`'s search window completely unbounded.

**Found via sandbox testing, not a client-reported issue — no
production employee has actually shown this failure yet.** The fix
itself doesn't depend on which environment it was found in (it's about
Sprout's own field format, not something environment-specific), but
this hasn't been separately confirmed against a real production
employee's `workSchedule`. Worth a quick check before shipping: run
`/api/debug/employee-lookup?name=<any real production employee>` against
production credentials and confirm `mondayFrom` etc. also come back as
`"HH:MM:SS"` there, the same as sandbox. If it does, the fix applies
identically; if production somehow differs, that's worth knowing before,
not after, deploy.

Confirmed two real, silent failure modes by running the actual code
against admin/admin's exact sandbox data:
- An employee with a completely normal shift and zero punches today
  showed as **Late (Shift Ongoing)** regardless of whether they'd
  actually clocked in — not a display bug, a genuine misclassification.
- An employee with an unrelated punch from **over a month ago** still on
  file showed as **On Time today**, with that old punch's time displayed
  as if it were today's arrival — confidently wrong, no error, no warning.

Fixed by only appending `:00` when the value doesn't already carry
seconds. Verified: both `"09:00:00"` and `"09:00"` now parse to the
identical correct time; the stale-punch case is now correctly rejected
instead of misattributed; a genuine on-time arrival today still
classifies correctly (no regression).

**This should be treated as higher priority than items 2-5 below** — the
mechanism is confirmed and the fix is verified, even though real-world
production impact hasn't been confirmed yet (no client report on this;
found proactively in sandbox). It can silently produce wrong attendance
records in both directions (false Late, and false On Time with wrong
times) for any employee not currently under a schedule adjustment, so
it's worth shipping regardless of whether it's caused a visible issue
yet.

## What changed

| File | Change | Client item |
|---|---|---|
| `src/sprout.js` | `manilaTimeOnDay` — no longer appends a redundant `:00` to a weekly-schedule time that already carries seconds (Sprout's real format), which was silently breaking shift-boundary calculation for anyone on their plain default schedule | newly found, not from client feedback |
| `src/sprout.js` | `ATTENDANCE_THRESHOLDS_MS` — real Sprout-configured pre/post grace windows (6h pre / 8h post for Normal Shift) instead of a hard boundary, so an early clock-in before a night shift is correctly matched to it | 4 |
| `src/sprout.js` | `scheduledShiftStart`/`scheduledShiftEnd` always included on `late`-status entries | 2 |
| `src/sprout.js` | `leaveType`, `leaveIsHalfDay`, `leaveHalfDayPeriod` always included on `onLeave`-status entries | 5 |
| `public/index.html` | Shift-hours suffix rendered in the Late (Shift Ongoing) detail column | 2 |
| `public/index.html` | "On AM leave" / "On PM leave" phrasing + leave type shown in the leave detail | 5 |
| `public/index.html` | New shift-time filter dropdown on Late (Shift Ongoing) — appears only when more than one distinct shift is present in the current list | 3 |
| `src/auth-store.js` | Logs a loud `⚠️ ACCOUNT STORE APPEARS EMPTY` warning if a registration succeeds against a zero-account store — does NOT fix the account-wipe issue, only makes a recurrence visible in the log stream immediately | related to item 1, not a fix |

## Why item 2 and 5 needed a deploy at all

The backend already computed this data unconditionally — confirmed by
reading `sprout.js` directly. The client's screenshots showed neither the
shift-hours suffix nor the leave type/AM-PM distinction, which meant the
**live frontend was running an older `index.html`** that predates both
features. This deploy is what actually ships them.

## Item 4 — how this was verified, not just reasoned about

The exact real data from the client's screenshot (John Cyron Martinez,
Emp-ID 022-206: 9PM→9AM adjustment on 9/20, an 8:30 PM IN punch, no OUT
punch) was run through the real `classifyEmployeeForDay` function from
this build, isolated with a small test harness (not just read/reasoned
about). Result for the 9/20 report: `status: onTime`. Confirmed fixed
against the actual reported case, not a synthetic one.

One caveat worth keeping in mind if this resurfaces after deploy: Sprout
keys each schedule row by the day the shift *starts*. A graveyard
employee's *own* shift for "today" is a **different, later shift**
(starting tonight) than the one that ended this morning — checked
separately, that later shift correctly shows `late` / "not started yet"
since it hasn't happened yet. That's expected behavior, not a bug — but
if a *different* graveyard case comes back misclassified after this
deploy, check which calendar day's report is actually being viewed
before assuming this same fix should have caught it.

## Post-deploy checklist

- [ ] **Before deploying**: confirm production's `workSchedule` time
      format matches sandbox's (`"HH:MM:SS"`) via
      `/api/debug/employee-lookup?name=<real employee>` against
      production credentials — this fix assumes the same format applies
- [ ] **Highest priority, post-deploy**: pick 2-3 employees who are on
      their plain default weekly schedule (no active adjustment) and
      confirm their shift boundaries resolve correctly — e.g. check that
      someone with no punches today shows their actual scheduled hours
      in the Late detail (not blank/"Unknown shift" in the filter), and
      that nobody with a genuinely old punch on file is showing today's
      status based on it
- [ ] Confirm the container is actually serving the new `index.html` —
      not just that the deploy command succeeded (check for the shift
      filter's presence on any multi-shift Late category, or view page
      source for `shift-filter-select`)
- [ ] Item 2: pick any employee currently in Late (Shift Ongoing) and
      confirm the shift-hours suffix appears in their Detail cell
- [ ] Item 3: confirm the filter dropdown appears when 2+ shift times
      exist in Late (Shift Ongoing), and is absent when there's only one
- [ ] Item 4: re-check a **current, real** graveyard employee (not
      John's already-passed Sep 20 case) clocking in early for their
      shift, and confirm they classify correctly rather than showing
      "no log-in yet"
- [ ] Item 5: pick any employee in On Leave and confirm leave type is
      shown, and that a known half-day case shows "On AM leave" / "On PM
      leave" rather than plain "On leave"
- [ ] Confirm login/session still works normally post-deploy (unrelated
      to this build's changes, but any deploy is worth a basic smoke
      test on this given item 1 is still an open, active issue)

## Not covered by this deploy

- **Item 1** (login/repeated registration) — root cause is believed to
  be the Azure Files volume mount at `/app/data` not being durable
  across restarts/redeploys/scale events. **This deploy does NOT fix
  it.** The only change (`auth-store.js`'s log warning) makes a future
  recurrence visible in the log stream — it does not stop it. Needs
  someone with Azure access to run:
  `az containerapp show --name shift-board --resource-group shift-board-rg -o yaml | grep -A 20 "volumes:\|volumeMounts:"`
  to confirm whether the volume is actually mounted right now.
- **Item 6** (data changing after refresh) — still waiting on the
  client to confirm what category the three employees in question were
  under before the refresh (or whether they were missing from the board
  entirely). No fix attempted yet since the cause isn't identified.
