# Branch builds of Bulwark Lite, and keeping Stalwart up to date

`.github/workflows/lite-branch-release.yml` builds Bulwark Lite from any ref and
publishes it as a release on your own repository. It exists so a branch can be
installed on a Stalwart before it is merged upstream; `static-lite.yml` keeps
building `main` and pull requests as before.

## What a run publishes

Every run builds both Lite targets from one commit and publishes **two** releases:

| Release | Assets | Use it for |
|---|---|---|
| `<tag>` (e.g. `lite-v1.11.0-pgp.1`) | `bulwark-lite-stalwart.zip`, `bulwark-lite-<tag>.zip`, `SHA256SUMS` | Pinning a build that never changes |
| `lite-latest` (rolling) | `bulwark-lite-stalwart.zip`, `bulwark-lite-static.zip`, `SHA256SUMS` | A url that follows every new build |

The rolling tag is force-moved to each new build and its assets keep fixed names,
so its download urls never change. Set `rolling_tag` to something else to use a
different name, or to empty to publish only the pinned release.

## Running it

Push a tag. This works from any branch, and is the only option while the
workflow file is not on the default branch:

```sh
git tag -s lite-v1.11.0-pgp.1 -m "Bulwark Lite branch build"
git push github lite-v1.11.0-pgp.1
```

Once the file is on the default branch, **Actions > Release Lite (branch build) >
Run workflow** also appears, where you pick the branch and pass a tag, an app
name, a locale subset and so on. GitHub only lists `workflow_dispatch` workflows
that exist on the default branch; the tag trigger has no such restriction because
it reads the workflow from the tagged commit.

## Pointing Stalwart at the rolling build

```
https://github.com/<owner>/<repo>/releases/download/lite-latest/bulwark-lite-stalwart.zip
```

Use that as the Application's `resourceUrl`. **Do not use `releases/latest/...`**:
these are prereleases, and `releases/latest` only ever resolves to the newest
release that is *not* a prerelease, so it would miss every build this workflow
publishes (or, worse, silently keep serving an unrelated older release).

```sh
stalwart-cli update Application <id> \
  --field resourceUrl='https://github.com/<owner>/<repo>/releases/download/lite-latest/bulwark-lite-stalwart.zip'
```

## Making Stalwart actually refetch

A stable url is only half of it. Stalwart caches the downloaded bundle and will
happily serve the old one for months. From its source
(`crates/common/src/manager/application.rs`):

- Unpacking first looks for the cached bundle in the blob store and **only
  downloads when it is missing**. The cache entry is stored with an expiry of
  `autoUpdateFrequency`.
- **Startup** (and an internal config reload) unpacks *without* clearing the
  cache, so it re-downloads only once that expiry has passed.
- The **`UpdateApps` action** deletes the cached bundle first, so it **always
  re-downloads**, whatever the expiry says.

`autoUpdateFrequency` defaults to **90 days** for an Application you create.
(The 30 days in Stalwart's source applies only to the web-admin Application it
seeds for itself.) So, for a branch build you actually want to track, do both:

**1. Shorten the cache** so a restart is enough to pick up a new build:

```sh
stalwart-cli update Application <id> --field autoUpdateFrequency=1d
```

**2. Run `UpdateApps` on a schedule**, which refetches immediately and does not
depend on the expiry at all:

```sh
stalwart-cli create Action/UpdateApps
```

As a daily systemd timer on the mail server:

```ini
# /etc/systemd/system/bulwark-lite-update.service
[Unit]
Description=Refetch Stalwart web applications

[Service]
Type=oneshot
ExecStart=/usr/local/bin/stalwart-cli create Action/UpdateApps
```

```ini
# /etc/systemd/system/bulwark-lite-update.timer
[Unit]
Description=Refetch Stalwart web applications daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
systemctl enable --now bulwark-lite-update.timer
```

The equivalent over JMAP, as an administrator:

```json
{
  "using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
  "methodCalls": [["x:Action/set", { "create": { "u": { "@type": "UpdateApps" } } }, "0"]]
}
```

Keep the trigger on the server. GitHub could call the JMAP endpoint after each
release, but that means storing administrator credentials as repository secrets
and exposing the endpoint to the runners — a large amount of trust for the sake
of a delay measured in hours.

A failed download leaves the previous bundle online, so a broken build or a
GitHub outage does not take the webmail down. Open tabs move to the new build on
their next full page load; a newly opened tab gets it immediately.

## Rolling back

The pinned release for each build is immutable, so point `resourceUrl` at a
specific `lite-v…` tag and run `UpdateApps`. To move the rolling tag back to an
older build instead, re-run the workflow from that commit.
