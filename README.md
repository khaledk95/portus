<p align="center">
  <img src="src/assets/portus.png" alt="Portus logo" width="120">
</p>

<h1 align="center">Portus</h1>

<p align="center"><strong>Secure SSM &amp; RDP-over-SSM access for AWS instances.</strong></p>

Portus is a cross-platform desktop app (Electron) that browses your EC2 instances and
opens a **Systems Manager (SSM) shell**, an **RDP-over-SSM tunnel**, or a **port
forward to any TCP service** — with no inbound ports, no bastion hosts, and no manual
CLI commands.

It works with however you already authenticate to AWS — IAM Identity Center, Azure AD,
`credential_process`, assume-role or static keys — because it reads the same
`~/.aws` config the AWS CLI does.

> Open source, released under the MIT License.

---

## Table of Contents

1. [Download](#download)
2. [Features](#features)
3. [How it works](#how-it-works)
4. [Prerequisites](#prerequisites)
5. [Authentication and AWS profiles](#authentication-and-aws-profiles)
6. [Installing a release](#installing-a-release)
7. [Running from source](#running-from-source)
8. [Building installers](#building-installers)
9. [Project structure](#project-structure)
10. [Branding / icons](#branding--icons)
11. [Troubleshooting](#troubleshooting)
12. [Tech stack](#tech-stack)

---

## Download

Grab the latest installer for your platform from the
[**Releases page**](https://github.com/khaledk95/portus/releases).

| Platform | File | Notes |
|----------|------|-------|
| Windows | `Portus-<version>-x64.exe` | Installer (choose location, adds shortcuts) |
| Windows | `Portus-Portable-<version>-x64.exe` | Single file, no install |
| macOS | `Portus-<version>-x64.dmg` | Intel |
| macOS | `Portus-<version>-arm64.dmg` | Apple Silicon |
| Linux | `Portus-<version>-x86_64.AppImage` | Runs anywhere, no install |
| Linux | `Portus-<version>-amd64.deb` | Debian / Ubuntu |
| Linux | `Portus-<version>-x86_64.rpm` | Fedora / RHEL |
| Linux | `Portus-<version>-x64.tar.gz` | Plain archive |

Ignore the `.blockmap` and `latest*.yml` files — build metadata, not downloads.

Portus still needs the [external tools](#prerequisites) below — the app checks
for them on startup and tells you what is missing.

> Releases are **unsigned**, so the OS will warn on first launch. See
> [Installing a release](#installing-a-release) for how to get past it.

---

## Features

- **Works with however you authenticate to AWS** — IAM Identity Center, Azure AD, `credential_process`, assume-role, static keys or environment credentials. Every profile in `~/.aws` is listed and selectable with no sign-in required first
- **Sign in from the app** for IAM Identity Center (`aws sso login`, with the browser pairing code shown so you can confirm it) and Azure AD (`aws-azure-login`) — the session countdown reads from whichever store that provider uses
- **EC2 instance browser** — live list per profile/region, searchable
- **SSM readiness at a glance** — per-instance agent status (Online / Connection lost / Not managed), so you never click Connect on an instance that can't accept a session
- **One-click SSM shell** — opens `aws ssm start-session` in a new terminal window
- **RDP over SSM** — auto port-forward tunnel + launches your RDP client (Windows-only instances)
- **Port forwarding over SSM** — tunnel any TCP port to `localhost`, either on the instance itself or on a host it can reach (an RDS endpoint, for example), so you can use your own database or web client without a bastion or an inbound rule
- **Endpoint discovery** — RDS, Aurora (writer endpoint) and ElastiCache endpoints in the profile's region are listed in the port-forward dialog, with the real port filled in, so nothing has to be copied out of the AWS console — any other host can still be typed
- **Active tunnel management** — see every open tunnel with its local port and uptime, disconnect from the UI, and have them torn down automatically when the app exits
- **Startup preflight** — missing external tools are reported up front with install instructions rather than failing later mid-connect, and provider-specific ones are only demanded when a profile actually uses them
- **Session renewal** — Azure AD sessions are refreshed before they expire and an expired one is renewed and retried transparently, so you are not thrown back to the login screen mid-task. IAM Identity Center needs a browser approval, so it is never renewed on a timer — you get a warning shortly before it lapses and sign in when you are ready
- **Light and dark themes**, a collapsible sidebar, an instance detail panel, state/OS filters and `Ctrl K` search — the session countdown and open tunnel count stay visible in the status bar
- Smart buttons: connect actions are only offered when Systems Manager can actually reach the instance, and RDP only on running Windows instances
- Cross-platform: Windows, macOS, Linux

---

## How it works

```
1. Select Profile   → pick any profile from ~/.aws (loads its EC2 instances)
2. Sign in          → only if those credentials are missing or expired
                      (IAM Identity Center or Azure AD)
3. Connect          → per instance row, choose:
                        SSM   → shell in a new terminal
                        RDP   → tunnel + your RDP client (Windows instances)
                        Port  → forward any TCP port to localhost
```

Under the hood the app shells out to the **AWS CLI** (`aws ssm start-session`) and the
**Session Manager plugin**, so those must be installed (see prerequisites).

**Port forwarding** can target either the instance itself or a host the instance can
reach — which is how you get to an **RDS endpoint**, since RDS cannot run an SSM agent:

| Target | SSM document | Reaches |
|--------|--------------|---------|
| This instance | `AWS-StartPortForwardingSession` | A port on the EC2 instance |
| A reachable host | `AWS-StartPortForwardingSessionToRemoteHost` | RDS, ElastiCache, an internal load balancer… |

For a reachable host, Portus lists the managed database and cache endpoints in the
profile's region so the hostname does not have to be copied out of the console. Pick
one, or type any other host — the field accepts both.

| Service | Listed |
|---------|--------|
| Oracle | RDS instances |
| SQL Server | RDS instances |
| PostgreSQL | RDS instances, and the **writer endpoint** of Aurora PostgreSQL clusters |
| MySQL | RDS instances, and the **writer endpoint** of Aurora MySQL clusters |
| Redis | ElastiCache primary / configuration endpoints, and standalone nodes |

The port comes from the endpoint itself rather than the service preset, so a database
on a non-standard port connects without being corrected by hand.

Every endpoint in the region is listed. Being listed does not mean the instance can
reach it — the database's security group and route table still decide that.

Open tunnels get their own **Tunnels** view in the sidebar, listing each one with its
local address and a live uptime, where you can copy the address or disconnect. The
open count also shows in the status bar. They are closed automatically when Portus
exits.

---

## Prerequisites

### Build / development machine

| Requirement | Version | Why | Install |
|-------------|---------|-----|---------|
| **Node.js** | 18 LTS or newer | Run & build the app | <https://nodejs.org> |
| **npm** | comes with Node | Dependency management | (bundled with Node) |
| **Git** | any recent | Clone the repo | <https://git-scm.com> |
| **Python** (macOS builds only) | 3.11 | Some native build deps (`dmg-license`) | <https://python.org> |

### Runtime (needed on any machine that *uses* the app)

These are external tools Portus calls at runtime. The app checks for them on startup
and shows a banner naming anything missing, with its install command.

| Tool | Why | Install |
|------|-----|---------|
| **AWS CLI v2** | Runs `aws ssm start-session` for SSM & RDP | <https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html> |
| **AWS Session Manager plugin** | Required by `aws ssm start-session` | <https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html> |
| **aws-azure-login** | Only for Azure AD profiles — not checked unless you have one | `npm install -g aws-azure-login` |
| **RDP client** | Needed only for RDP-over-SSM | Windows: `mstsc` (built-in) · macOS: [Microsoft Remote Desktop](https://apps.apple.com/app/microsoft-remote-desktop/id1295203466) · Linux: `remmina`, `xfreerdp`, or `rdesktop` |

### AWS-side requirements (per target instance)

- Instance has the **SSM Agent** installed and running
- Instance has an **IAM role** with SSM permissions (`AmazonSSMManagedInstanceCore`)
- Instance can reach SSM endpoints (NAT/VPC endpoints)
- For **RDP**: the instance is **Windows** and running

### IAM permissions your own credentials need

| Action | Used for |
|--------|----------|
| `ec2:DescribeInstances` | Listing instances |
| `ssm:DescribeInstanceInformation` | The **SSM Agent** column (connection readiness) |
| `ssm:StartSession` | SSM shells, RDP tunnels and port forwards |
| `ssm:TerminateSession` / `ssm:ResumeSession` | Closing your own sessions cleanly |
| `rds:DescribeDBInstances` / `rds:DescribeDBClusters` | Suggesting database endpoints in **Forward a port** |
| `elasticache:DescribeReplicationGroups` / `elasticache:DescribeCacheClusters` | Suggesting Redis endpoints in **Forward a port** |

If your policy restricts `ssm:StartSession` by resource, it must also allow the
documents used for tunnelling, otherwise RDP and port forwarding are denied while
plain shells still work:

```
arn:aws:ssm:<region>::document/AWS-StartPortForwardingSession
arn:aws:ssm:<region>::document/AWS-StartPortForwardingSessionToRemoteHost
```

`ssm:DescribeInstanceInformation` is optional — without it the SSM Agent column
shows *Unknown* and the connect buttons stay enabled, so nothing is blocked.

The `rds:*` and `elasticache:*` actions are optional too. They only populate the
endpoint suggestions in **Forward a port**; without them the list is empty or
partial and the host is typed by hand, exactly as before.

---

## Authentication and AWS profiles

Portus reads your standard AWS config at `~/.aws/config` (and `~/.aws/credentials`).
Every profile is listed, tagged with the credential provider it uses, and can be
selected. **No sign-in is required first** — if the AWS CLI can use a profile, so
can Portus, because it hands the profile name to the same SDK the CLI uses.

| Provider | Recognised by | Sign-in button |
|----------|---------------|----------------|
| **Identity Center** | `sso_session` or `sso_start_url` | yes — runs `aws sso login --sso-session <name>`, your browser opens and Portus shows the pairing code to confirm |
| **Azure AD** | any `azure_*` field | yes, runs `aws-azure-login` |
| **Credential process** | `credential_process` | none needed |
| **Assume role** | `role_arn` | none needed — with `mfa_serial`, Portus asks for the code when it needs one |
| **Access keys** | `aws_access_key_id` | none needed, they do not expire |

Environment credentials (`AWS_ACCESS_KEY_ID`, an EC2 instance role) work too.

The sidebar dropdown lists every profile. The **Sign in** dialog lists only what
Portus can actually start a login for, and lists it by the right unit: an Identity
Center token belongs to the portal session, so all the profiles sharing an
`[sso-session]` appear as **one** row that signs you into all of them at once.
Azure AD, and older Identity Center profiles with an inline `sso_start_url`, stay
one row per profile because that is genuinely how they log in.

Each row says how many profiles that one sign-in makes usable — the profiles it
signs in directly, plus any that reach them through `source_profile`. So an Azure
AD profile that three other profiles assume a role from reads *4 profiles*:

```ini
[profile azure-corp]          # the sign-in
azure_tenant_id = ...

[profile prod]                # usable after signing in to azure-corp
role_arn = arn:aws:iam::111111111111:role/Admin
source_profile = azure-corp
```

Both the dropdown and the Sign in dialog have a **Refresh** that re-reads
`~/.aws/config` and `~/.aws/credentials`, so a profile added or edited while
Portus is running shows up without restarting it. If the profile you had selected
disappears, the selection is cleared; if its region changed, the status bar
follows.

Example `~/.aws/config`:

```ini
# --- IAM Identity Center ---
[sso-session mycompany]
sso_start_url = https://mycompany.awsapps.com/start
sso_region = me-central-1

[profile idc-prod]
sso_session = mycompany
sso_account_id = 123456789012
sso_role_name = Developer
region = me-central-1

# --- Azure AD (signs in from the app) ---
[profile my-sso]
azure_tenant_id = 00000000-0000-0000-0000-000000000000
azure_app_id_uri = https://signin.aws.amazon.com/saml
azure_default_username = you@company.com
azure_default_role_arn = arn:aws:iam::123456789012:role/YourRole
region = me-central-1

# --- Assume role from a base profile ---
[profile my-account]
role_arn = arn:aws:iam::123456789012:role/YourRole
source_profile = my-sso
region = me-central-1

# --- Credentials from an external helper (1Password, Vault, aws-vault…) ---
[profile vault]
credential_process = /usr/local/bin/aws-vault export --format=json prod
region = me-central-1
```

**Access keys** go in `~/.aws/credentials`, and note the section header has no
`profile ` prefix there — that mismatch is the usual reason a profile shows up
half-configured:

```ini
# ~/.aws/credentials          note: [name], not [profile name]
[my-keys]
aws_access_key_id = AKIA...
aws_secret_access_key = ...
region = me-central-1
```

`aws configure --profile my-keys` writes this for you and gets the syntax right.
Portus merges both files per profile, so the region can live in either.

**Environment credentials** need no configuration at all: if `AWS_ACCESS_KEY_ID`
and `AWS_SECRET_ACCESS_KEY` are exported, or Portus is running on an EC2 instance
with an instance role, the SDK picks them up for the `default` profile.

**Assume role with MFA** works too. A profile with `mfa_serial` cannot produce
credentials until a six-digit code is entered, so Portus asks for one when a call
needs it:

```ini
[profile prod]
role_arn   = arn:aws:iam::123456789012:role/Admin
source_profile = keys
mfa_serial = arn:aws:iam::123456789012:mfa/you
region = me-central-1
```

The code is asked for once. The credentials it produces are reused until they
expire, and are handed to the AWS CLI directly so a tunnel never stops to ask
again on a prompt you cannot see.

> Tip: whatever the provider, the profile should already work from your terminal —
> `aws sts get-caller-identity --profile <name>` — before you rely on it in the app.

---

## Installing a release

Releases are built without a code-signing certificate, so each OS shows a
warning the first time. The steps below are how you get past it.

**Windows** — SmartScreen shows *"Windows protected your PC"*.
Click **More info** → **Run anyway**.

**macOS** — Gatekeeper says the app *"cannot be opened because the developer
cannot be verified"*. Right-click the app in Finder and choose **Open**, or
allow it under *System Settings → Privacy & Security*. If it is quarantined:

```bash
xattr -dr com.apple.quarantine /Applications/Portus.app
```

**Linux** — make the AppImage executable, or install the package:

```bash
chmod +x Portus-*.AppImage && ./Portus-*.AppImage
# or
sudo dpkg -i Portus-*-amd64.deb
# or
sudo rpm -i Portus-*-x86_64.rpm
```

Signing would remove these prompts but needs a paid certificate per platform.

---

## Running from source

```bash
# 1. Clone
git clone https://github.com/khaledk95/portus.git
cd portus

# 2. Install dependencies (runs electron-builder install-app-deps via postinstall)
npm install
```

No `.env` or extra config files are required.

```bash
# Normal launch
npm start

# Launch with DevTools open
npm run dev

# Run the test suite
npm test
```

Pick a profile from the sidebar and its instances load automatically. If those
credentials are missing or expired, Portus says so — click **Sign in** and pick the
Identity Center session or Azure AD profile that provides them.

---

## Building installers

All builds output to the `dist/` folder (git-ignored).

| Command | Output |
|---------|--------|
| `npm run build:win64` | Windows x64 — NSIS installer + portable `.exe` |
| `npm run build:win32` | Windows 32-bit (ia32) |
| `npm run build:win` | Windows (all configured arches) |
| `npm run build:mac` | macOS `.dmg` (x64 + arm64) |
| `npm run build:mac-intel` | macOS Intel only |
| `npm run build:mac-silicon` | macOS Apple Silicon only |
| `npm run build:linux` | Linux AppImage / deb / rpm / tar.gz |
| `npm run build:all` | All platforms (mac builds require macOS) |
| `npm run pack` | Unpacked dir only (fast, for testing) |
| `npm run dist` | Build without publishing |

**Notes**
- Build each OS on its own platform. macOS `.dmg` and `.icns` generation require
  running on macOS; Windows `.exe` targets require Windows.
- **Releasing is automatic.** Bump the version, tag it, push the tag:

  ```bash
  npm version 2.3.0 --no-git-tag-version   # or edit package.json by hand
  git commit -am "Release v2.3.0"
  git tag -a v2.3.0 -m "Portus v2.3.0"
  git push origin main --follow-tags
  ```

  `build.buildVersion` in `package.json` has to match too.

  The workflow builds on all three runners, uploads into a draft, and publishes
  the release only once every platform has finished — so nobody can download a
  release that is missing an OS. The tag must match the version in
  `package.json`.
- Builds are **unsigned** — see [Installing a release](#installing-a-release).

---

## Project structure

```
.
├── src/
│   ├── main.js          # Electron main process — IPC handlers, AWS SDK, CLI spawns
│   ├── preload.js       # contextBridge — exposes the safe electronAPI to the renderer
│   ├── renderer.js      # UI logic (Portus class): profiles, instances, tunnels
│   ├── index.html       # App markup
│   ├── styles.css       # Theme tokens (light + dark) and all component styles
│   └── assets/
│       └── portus.png   # In-app logo
├── build/
│   ├── portus.png       # Source icon (macOS/Linux; electron-builder generates sizes)
│   └── portus.ico       # Multi-size Windows icon (16–256 px)
├── tests/
│   ├── helpers/
│   │   ├── harness.js   # Loads the real main.js with electron/fs/AWS stubbed out
│   │   └── assert.js    # Pass/fail counter, deliberately not a framework
│   ├── providers.test.js  # Credential providers, sign-in routing, session expiry
│   ├── endpoints.test.js  # RDS / Aurora / ElastiCache discovery
│   ├── injection.test.js  # Nothing hostile reaches a shell command
│   ├── mfa.test.js        # mfa_serial prompting, caching and cancellation
│   └── run.js           # Runs every suite, one process each
├── .github/workflows/
│   ├── ci.yml           # Runs the tests on every push and pull request
│   └── release.yml      # Tests, then builds all three platforms on a v* tag
├── package.json         # Scripts + electron-builder config
└── README.md
```

**Tests** exercise the shipped `main.js` rather than a copy of it: the harness
replaces electron, `fs-extra`, `child_process` and the AWS SDK clients, then calls
the same IPC handlers the renderer calls. Each suite runs in its own process,
because those replacements are process-wide.

```bash
npm test
```

A tag that fails its tests never reaches the build step, so no release can be cut
from a broken commit.

**Architecture:** standard Electron 3-process model. The renderer never touches Node
or AWS directly — it calls `window.electronAPI.*`, which forwards over IPC to handlers
in `main.js`. `contextIsolation` is on and `nodeIntegration` is off.

---

## Branding / icons

- In-app logo: `src/assets/portus.png`
- App/installer icons: `build/portus.png` (mac/linux) and `build/portus.ico` (Windows, multi-size)

To change the icon, replace those files (keep `portus.ico` multi-size: 16/24/32/48/64/128/256).
If a Windows icon still looks stale after rebuilding, clear the Windows icon cache:

```powershell
ie4uinit.exe -show
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `aws-azure-login command not found` | `npm install -g aws-azure-login`, then restart the app |
| SSM session window opens then closes / errors | AWS CLI v2 and/or **Session Manager plugin** not installed, or instance has no SSM agent/IAM role |
| `AWS CLI not found` | Install AWS CLI v2 and ensure it's on your `PATH` |
| RDP button missing on an instance | RDP only appears for **running Windows** instances |
| Connect buttons show *No SSM* and are disabled | The instance is not registered with Systems Manager — check the SSM agent is running and the instance IAM role includes `AmazonSSMManagedInstanceCore`. Hover the button for the exact reason |
| SSM Agent column shows *Unknown* | Your credentials lack `ssm:DescribeInstanceInformation`. Harmless — the buttons stay enabled |
| `Local port ... is already in use` | Something else holds that port. Leave **Local port** blank to have one picked automatically |
| Port forward to an RDS endpoint fails | Use **A host reachable from it** (not *This instance*), and check the instance's security group is allowed to reach the database |
| Endpoint list is empty or missing a database | Your credentials lack the `rds:*` / `elasticache:*` describe actions, or the database is in another region. Type the host manually — nothing is blocked |
| Redis connects but the TLS handshake fails | The cluster has encryption in transit, and its certificate names the real host, not `localhost`. Point your client at the real SNI name or disable hostname verification |
| RDP client doesn't launch | Windows: ensure `mstsc` available · macOS: install Microsoft Remote Desktop · Linux: install `remmina`/`xfreerdp`/`rdesktop` |
| Sign-in button disabled | No profile in `~/.aws` has a login Portus can run. Pick a profile directly instead — its credentials are used as-is |
| `aws sso login` sign-in times out | The browser approval was not completed within 3 minutes. If no browser opened, run `aws sso login --profile <name>` in a terminal once |
| Session countdown missing on an Identity Center profile | The cached token in `~/.aws/sso/cache` has no entry for that portal yet — sign in once and it appears |
| Asked for an MFA code again sooner than expected | The credentials from the last code expired. Role sessions are an hour by default; raise `duration_seconds` on the profile if that is too often |
| No profiles in the dropdown | Nothing readable in `~/.aws/config` or `~/.aws/credentials` |
| A profile you just added is missing | Click **Refresh** in the dropdown (or in the Sign in dialog) — `~/.aws` is otherwise only read at startup |
| App icon not updating (Windows) | Stale icon cache — run `ie4uinit.exe -show` or reinstall to a new path |

---

## Tech stack

- **Electron 37** (electron-builder 24 for packaging)
- **AWS SDK v3** — `@aws-sdk/client-ec2`, `@aws-sdk/client-ssm`, `@aws-sdk/client-rds`,
  `@aws-sdk/client-elasticache`, `@aws-sdk/credential-providers`
- `fs-extra`, `ini` (read `~/.aws` config)
- External CLIs at runtime: **AWS CLI v2** and the **Session Manager plugin** always;
  **aws-azure-login** only if you have an Azure AD profile

---

Released under the [MIT License](LICENSE).
