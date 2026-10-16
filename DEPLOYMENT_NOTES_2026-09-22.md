# Deployment notes — Tuesday, Sep 22, 2026

> **This copy also includes the env-var login change (item 1).** Read the
> "Item 1 — login now comes from environment variables" section below
> *before* deploying: the operator must set the new variables first, or
> nobody can log in.

Covers items 1, 2, 3, 4, 5 from Firstmac's latest feedback batch, plus one
newly-found bug (not from their feedback list, found while investigating
the shift filter — see below, and read this one first). Item 6 (data
changing after refresh) is **not** in this build — see the client email
thread for why it is still open.

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
| `src/auth-store.js` | Rewritten: admin credentials read from indexed env vars (`ADMIN_<n>_ID` / `ADMIN_<n>_PASSWORD`); no signup, no accounts file, no bcrypt. Supersedes the earlier log-warning-only patch | 1 |
| `src/server.js` | `POST /api/auth/register` and `POST /api/auth/reset-account` removed; startup log reports a credential count only | 1 |
| `public/index.html` | Register form, "Reset an admin account" panel, and their JS removed | 1 |
| `package.json` | `bcryptjs` dependency dropped | 1 |
| `.env.example`, `docker-compose.yml`, `README.md`, `AZURE_DEPLOYMENT.md` | Document the new variables and the secretref/deploy-order guidance | 1 |

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
- [ ] **Item 1:** confirm the startup log says `Admin credentials
      configured: N` with the expected N, log in with a configured admin,
      **restart the Container App, and log in again** with the same
      password (no re-registration). Confirm a wrong password and an
      unconfigured System ID fail with the same generic message, and that
      there is no Register link on the login screen

## Item 1 — login now comes from environment variables

**Root cause it removes:** accounts were stored in `data/admin-accounts.json`
on container-local storage, so every restart/redeploy/scale-to-zero wiped
them and admins were forced to re-register. Credentials now come from the
Container App's environment, which survives all of those. **No Azure
volume is needed for logins**, so the volume-mount handoff is no longer
on the critical path for Tuesday (it still matters for Sprout credentials
saved through the dashboard, unless all four `SPROUT_*` vars are set).

**Operator must do this BEFORE deploying — the order matters:**
1. Create the variables (use Container App *secrets* + `secretref:` for the
   passwords — commands in `AZURE_DEPLOYMENT.md` Step 5):
   `ADMIN_1_ID` / `ADMIN_1_PASSWORD`, one pair per admin, plus
   `SESSION_SECRET` (a fixed value; generate once).
2. Then deploy. `ADMIN_ALLOWLIST` is no longer read and can be removed.

If this build goes out first, nobody can log in and there is no way to
register back in (signup is gone).

**What changes for Firstmac's admins:** they log in with the System ID and
the password the operator set for them. There is no "Register" screen and
no "Reset an admin account"; a password change is an operator edit.

**Verified locally (real server, throwaway test values):** correct login
works; wrong password and unknown ID both return the same generic error;
pairs with a missing password or a `.` in the ID are skipped with a
warning; gaps in numbering work; a pair with both values empty is ignored
silently; register/reset return 404 with a valid session; nothing is
written to disk; a session cookie stops working after its pair is removed
and the app restarted; the app starts and rejects logins cleanly when
nothing is configured.

**Not verified:** behaviour on the real Container App (secretref wiring,
whether the platform restarts cleanly with the new variables) — that is
what the post-deploy checklist is for.

**Security tradeoff, stated plainly:** passwords are plaintext in the
environment, by design of this change. Use secrets, restrict who can view
the Container App configuration, and keep the values out of source control
and logs.

## Data refresh after a restart (item 6) — what changed

**Cause (confirmed from the client's two recordings):** after a start-up the
schedule/leave cache is empty for ~3 minutes. During that time everyone is
judged against their default schedule, then re-judged as each person's data
arrives, so the counts move (Late 13 → 10 → 4, On Leave 6 → 9 → 14) while the
total stays 356. Once loaded, the On Leave list matched Sprout's exactly.

**Changes (no extra Sprout calls for the first two):**
1. `src/sprout.js` — the background sync now checks people with **no clock-in
   yet today** first (they are the ones most likely to be on leave, on a rest
   day, or on an adjusted shift). The "who has punched" hint is remembered from
   the attendance logs a dashboard load already fetches; if it is missing or
   older than 15 minutes the sync falls back to roster order. Same number of
   calls, different order.
2. `public/index.html` — while the first sync is incomplete the cards are
   dimmed with a dashed border and a **PRELIMINARY** note shows progress
   ("60 of 359 employees checked"), so the numbers no longer look final.
3. `public/index.html` — while preliminary, the board **re-checks on its own**
   every 15 seconds (single-day view only), stops as soon as the sync finishes,
   and gives up after 6 minutes (then asks the person to press Refresh).
   In the Today view this is ONE short "Updating" line ("Getting everyone's latest
   leave and schedule updates (50 of 355 employees done). Numbers may shift a
   little — this page updates by itself, no need to refresh. Export will be ready
   when done."); the blue banner and the small toolbar status are kept quiet there
   so the same message isn't shown three times. A
   real sync error still shows the banner. (Refreshing does not make it faster
   and adds calls.) The multi-day views do not re-check by
   themselves, so their banner asks the person to press Refresh in a few minutes
   instead of promising automatic updates.
   Sections the person has expanded and their shift filter are kept across the
   automatic re-checks. **Cost:** each re-check is a normal Today load
   (~18 Sprout calls); typically ~8-12 re-checks per cold start (roughly
   150-220 calls), at most 24 (~430) per open tab if the sync never finishes.
   Count this if the call limit turns out to apply to the board.

**Verified:** the real sweep against a mocked Sprout (no-punch people fetched
first, nobody skipped or duplicated, same call count, old hint falls back to
roster order); the real page in a simulated browser and in headless Chrome
(preliminary marking, progress, automatic re-check, expanded sections kept,
stops when finished, gives up after the window, manual Refresh unaffected).
Each guard was mutation-checked: removing it fails the specific test.

**Not verified:** the real Sprout API, and the real server under load. Sprout's
actual response times decide how much faster the counts settle; the ordering
only changes who is checked first.

**Not changed:** the ~3 minute total sync time, and the sweep still starts on
every restart. Setting minimum replicas to 1 is held until the API-call-limit
question is answered.

## Late list wording, Export lock, and late tolerance

1. **"Late (Shift Ongoing)" no longer implies a shift is underway when it has
   not started.** Someone on a 9PM–9AM shift seen at 5PM now reads
   "Shift starts 9:00PM · ends 9:00AM" (on screen and in the Excel export)
   instead of "No log-in yet, shift still ongoing". They stay in the same
   category, so no counts change; people whose shift has started and who have
   not clocked in still read "No log-in yet, shift still ongoing · Shift: …".
   (`shiftNotStarted` flag in `src/sprout.js`, wording in `public/index.html`.)
   A separate category for these people remains an option if wording is not
   enough — it would change the Late count, so it was not done.
2. **Export to Excel is disabled while the numbers are preliminary** (Today and
   multi-day views), with a tooltip and a line in the PRELIMINARY note
   explaining it unlocks when loading finishes. A safety check inside the export
   itself blocks it too. In the multi-day views the button re-enables after the
   person presses Refresh once loading has finished (those views do not
   re-check by themselves).
3. **Late tolerance: no change.** Firstmac has no grace period, so the board
   flagging any minute of lateness matches their policy. One difference is
   still unexplained: in the 7 Oct recordings the board listed Marie Suzanne
   Salazar as 11 minutes late while Sprout's Daily Attendance dashboard showed
   only one late employee. Worth checking her record in Sprout.

**Verified:** classification against the real code with shifts set relative to
now (not started / underway / ended); the page in a simulated browser; the
Excel wording by running the real function lifted from the page. Each guard
was mutation-checked.

## Not covered by this deploy

- **Item 6** (data changing after refresh) — still waiting on the
  client to confirm what category the three employees in question were
  under before the refresh (or whether they were missing from the board
  entirely). No fix attempted yet since the cause isn't identified.
