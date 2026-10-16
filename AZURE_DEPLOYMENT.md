# Deploying Shift Board (No-Login Version) to Azure

This is the simplified deployment guide for `shift-board-no-auth` — the
version with no Keycloak, no login page, and Sprout credentials entered
through an in-app "Sprout settings" panel instead of a login system.

**This is meant for whoever has Azure access — not something the CSM
needs to run.** Once this is deployed, using the dashboard afterward is
just opening a URL and typing in credentials — nothing to install.

**Before deploying:** re-read the "What this means, plainly" section in
this repo's `README.md`. This version has **no access control** — anyone
who has the URL can view attendance data and change the Sprout
credentials being used. Confirm that's genuinely acceptable for this
deployment before going further (e.g. behind a private network, or an
access gate elsewhere like sproutmarkup.com's own login).

## Architecture

Much simpler than the Keycloak version — one container, no database:

```
Browser ───HTTPS───▶  Container App: shift-board
                       (Express: serves index.html,
                        /api/shift-board, /api/settings —
                        all open, no auth)
                              │
                              │ server-to-server (no CORS issue)
                              ▼
                       Sprout HR API
```

## Step 1 — Resource group and container registry

```bash
az group create --name shift-board-rg --location southeastasia

az acr create --resource-group shift-board-rg \
  --name shiftboardacr --sku Basic
```

## Step 2 — Build and push the image

```bash
az acr login --name shiftboardacr

docker build -t shiftboardacr.azurecr.io/shift-board-no-auth:latest .
docker push shiftboardacr.azurecr.io/shift-board-no-auth:latest
```

## Step 3 — Container Apps environment

```bash
az extension add --name containerapp --upgrade

az containerapp env create \
  --name shift-board-env \
  --resource-group shift-board-rg \
  --location southeastasia
```

## Step 4 — Persistent storage for saved settings

> **Note:** admin logins no longer depend on this volume — they come from
> environment variables (see Step 5). This step now only matters for Sprout
> credentials saved through the dashboard's Credentials panel, and only if
> you do *not* set all four `SPROUT_*` variables at deploy time.

**This step matters — don't skip it.** Credentials saved through the
"Sprout settings" panel live in a file at `/app/data/sprout-config.json`
inside the container. Without persistent storage attached, that file is
lost every time the container restarts or redeploys, and whoever's using
the dashboard would have to re-enter credentials repeatedly.

```bash
az storage account create \
  --resource-group shift-board-rg \
  --name shiftboardstorage \
  --sku Standard_LRS

az storage share-rm create \
  --resource-group shift-board-rg \
  --storage-account shiftboardstorage \
  --name shift-board-data \
  --quota 1

STORAGE_KEY=$(az storage account keys list \
  --resource-group shift-board-rg \
  --account-name shiftboardstorage \
  --query "[0].value" -o tsv)

az containerapp env storage set \
  --resource-group shift-board-rg \
  --name shift-board-env \
  --storage-name shift-board-data \
  --azure-file-account-name shiftboardstorage \
  --azure-file-account-key "$STORAGE_KEY" \
  --azure-file-share-name shift-board-data \
  --access-mode ReadWrite
```

## Step 5 — Deploy the app

```bash
az containerapp create \
  --name shift-board \
  --resource-group shift-board-rg \
  --environment shift-board-env \
  --image shiftboardacr.azurecr.io/shift-board-no-auth:latest \
  --target-port 3000 \
  --ingress external \
  --min-replicas 0 --max-replicas 2 \
  --registry-server shiftboardacr.azurecr.io
```

**Notice there are no `SPROUT_*` environment variables here at all** —
that's intentional — but as of this update, it's now a **choice**, not
the only option. See below.

**Recommended for this deployment — bake in the Sprout credentials here,
since this build is for one specific client.** Add all four alongside
`SPROUT_BASE` in the same `--env-vars` flag:
```
--env-vars SPROUT_BASE=<real production URL> SPROUT_CLIENT_ID=<...> SPROUT_CLIENT_SECRET=<...> SPROUT_SUBSCRIPTION_KEY=<...> SPROUT_USER_ID=<...>
```
When all four are set this way, the app detects it at startup and
**automatically hides the Credentials panel from the dashboard entirely**
— the person using it never sees a settings screen, never has to enter
anything, and can't accidentally (or otherwise) overwrite these values
later, since the save endpoint itself refuses changes once locked. This
is the safer default for a single-client build like this one.

If you only set some of the four (or none), the dashboard falls back to
its original behavior — the Credentials panel stays visible and editable
after deployment, same as before. This is only worth doing if you
genuinely expect these values to need changing without a redeploy.

**⚠️ Also required — admin logins and a session secret, or nobody can log in:**

Admin credentials are no longer self-registered. Each admin is a numbered
pair of environment variables, created by whoever deploys (the app never
creates or stores accounts):

```
ADMIN_1_ID=<system id>        ADMIN_1_PASSWORD=<password>
ADMIN_2_ID=<system id>        ADMIN_2_PASSWORD=<password>
SESSION_SECRET=<a long random string>
```

Because the passwords are plaintext values, set them as Container App
**secrets** and reference them, rather than as plain env values (plain
values are readable by anyone who can view the app's configuration):

```bash
az containerapp secret set \
  --name shift-board --resource-group shift-board-rg \
  --secrets admin1-password=<password> admin2-password=<password> session-secret=<random>

az containerapp update \
  --name shift-board --resource-group shift-board-rg \
  --set-env-vars ADMIN_1_ID=<system id> ADMIN_1_PASSWORD=secretref:admin1-password \
                 ADMIN_2_ID=<system id> ADMIN_2_PASSWORD=secretref:admin2-password \
                 SESSION_SECRET=secretref:session-secret
```

*(Same honesty standard as the rest of this guide: the `secretref:` syntax
is Azure's documented pattern but hasn't been run against this specific
app — if a command is rejected, check it against the current
`az containerapp secret` docs.)*

- `ADMIN_<n>_ID` / `ADMIN_<n>_PASSWORD` — add one pair per admin. Without
  at least one pair, nobody can log in. **`ADMIN_ALLOWLIST` is no longer
  read** — remove it from the Container App.
- `SESSION_SECRET` — without this, a random key is generated fresh each
  time the container starts, which means **everyone gets logged out on
  every restart or redeploy**. Generate one once (e.g.
  `openssl rand -hex 32`) and keep the same value.
- To change a password or revoke an admin, edit/remove the pair and let a
  new revision start. Removing a pair ends that admin's active session on
  the next request.

**Order matters when moving from the previous (self-registration) build:
set the `ADMIN_<n>_*` variables and `SESSION_SECRET` *before* deploying
this build.** Deploying first leaves nobody able to log in until they are
set, and there is no way to register your way back in.

See `README.md`'s "Authentication" section for the full picture.

## Step 6 — Mount the storage to the container

The Container App needs to know to actually use the storage from Step 4
at the path the app expects (`/app/data`).

**Flagging this clearly: the exact YAML structure below has not been
tested against a live Azure deployment in this session** (same honesty
standard as the rest of this repo — see the caveats already in
`README.md` and `sprout.js`). The general approach (add a `volumes`
entry, add a matching `volumeMounts` entry on the container) is correct
per Azure's documented pattern, but exact field names can shift between
API versions. If `az containerapp update --yaml` rejects this file,
check the error message against the current `az containerapp` docs for
the volume/volumeMounts schema, and adjust field names accordingly —
don't assume the deployment is broken, it may just need small syntax
fixes.

```bash
az containerapp show --name shift-board --resource-group shift-board-rg \
  -o yaml > shift-board-config.yaml
```

Open `shift-board-config.yaml`, and under `properties.template`, add:

```yaml
volumes:
  - name: data-volume
    storageType: AzureFile
    storageName: shift-board-data
containers:
  - name: shift-board
    # ... existing config stays ...
    volumeMounts:
      - volumeName: data-volume
        mountPath: /app/data
```

Then apply it:

```bash
az containerapp update \
  --name shift-board \
  --resource-group shift-board-rg \
  --yaml shift-board-config.yaml
```

## Step 7 — Custom domain (optional but recommended)

```bash
az containerapp hostname add \
  --hostname shiftboard.yourcompany.com \
  --name shift-board \
  --resource-group shift-board-rg
```

Follow the CNAME/TXT instructions Azure gives you, then bind a managed
certificate (Container App → Custom domains → Add certificate).

## Once it's live

1. Open the Container App's URL (or your custom domain)
2. Click **"Sprout settings"** in the toolbar
3. Enter the real Sprout credentials, click **Save Settings**
4. Paste the same URL + `/api/shift-board` into the "Shift Board API
   URL" box and click **Save & Connect**

From here on, using it is just opening that URL — nothing to install,
same as any other website.

## What to actually test before calling this "done"

- [ ] The Container App URL loads the dashboard (not a blank page or
      Azure's default "container starting" placeholder)
- [ ] `/health` responds with `{"ok":true,...}`
- [ ] "Sprout settings" loads status without a "Failed to fetch" error
      (confirms the frontend can actually reach the backend, not just
      that the container is running)
- [ ] Saving credentials through the panel succeeds
- [ ] The dashboard then actually loads live attendance data — this
      confirms the server can reach Sprout's API from Azure (server-to-
      server, so CORS doesn't apply here, but network/firewall rules
      inside Azure could still block it — worth confirming directly)
- [ ] **Confirm `SPROUT_BASE` is actually pointed at production**, not
      the sandbox default. Check a few real, known employees on the
      dashboard and confirm their attendance matches what you'd expect
      from actual records — don't just check that *some* data loads,
      since sandbox data loads too and looks equally plausible at a
      glance
- [ ] **Restart the container app** (`az containerapp revision restart`)
      and confirm the saved Sprout credentials are still there afterward
      — this is the real test that Step 4/6's persistent storage is
      actually working, not just that saving worked once
- [ ] **Confirm at least one `ADMIN_<n>_ID` / `ADMIN_<n>_PASSWORD` pair
      and `SESSION_SECRET` are set** — the startup log prints
      `Admin credentials configured: N` (a count only); without any pair
      nobody can log in, and without `SESSION_SECRET` everyone gets logged
      out on every restart
- [ ] Log in with a configured System ID and password, log out, and log
      back in
- [ ] Confirm a wrong password and an unconfigured System ID both fail
      with the same generic message
- [ ] **Restart the container app and log in again with the same
      password** — this is the real test that accounts survive a restart
      (they now come from the environment, so no persistent volume is
      involved for logins)
- [ ] Confirm there is no "Register" link anywhere on the login screen
