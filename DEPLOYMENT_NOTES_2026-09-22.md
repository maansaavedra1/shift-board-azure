# Deployment notes — Tuesday, Sep 22, 2026

Covers items 2, 3, 4, 5 from Firstmac's latest feedback batch. Items 1 (login/
repeated registration) and 6 (data changing after refresh) are **not** in
this build — see the client email thread for why each is still open.

## What changed

| File | Change | Client item |
|---|---|---|
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
