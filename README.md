<p align="center">
  <img src="src/assets/portus.png" alt="Portus logo" width="120">
</p>

<h1 align="center">Portus</h1>

<p align="center"><strong>Secure SSM &amp; RDP-over-SSM access for AWS instances.</strong></p>

Portus is a cross-platform desktop app (Electron) that lets you authenticate to AWS
with Azure AD SSO, browse your EC2 instances, and open a **Systems Manager (SSM)
shell** or a **RDP-over-SSM tunnel** to any instance — with no inbound ports, no
bastion hosts, and no manual CLI commands.

> Open source, released under the MIT License.

---

## Table of Contents

1. [Download](#download)
2. [Features](#features)
3. [How it works](#how-it-works)
4. [Prerequisites](#prerequisites)
5. [AWS profile configuration](#aws-profile-configuration)
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

- **Azure AD SSO login** via `aws-azure-login`
- **EC2 instance browser** — live list per profile/region, searchable
- **SSM readiness at a glance** — per-instance agent status (Online / Connection lost / Not managed), so you never click Connect on an instance that can't accept a session
- **One-click SSM shell** — opens `aws ssm start-session` in a new terminal window
- **RDP over SSM** — auto port-forward tunnel + launches your RDP client (Windows-only instances)
- **Port forwarding over SSM** — tunnel any TCP port to `localhost`, either on the instance itself or on a host it can reach (an RDS endpoint, for example), so you can use your own database or web client without a bastion or an inbound rule
- **Active tunnel management** — see every open tunnel with its local port and uptime, disconnect from the UI, and have them torn down automatically when the app exits
- **Startup preflight** — missing external tools (AWS CLI, Session Manager plugin, aws-azure-login) are reported up front with install instructions, instead of failing later mid-connect
- Smart buttons: SSM on any running instance, RDP only on running Windows instances
- Cross-platform: Windows, macOS, Linux

---

## How it works

```
1. SSO Connect      → pick an Azure AD profile → runs aws-azure-login
2. Select Profile   → choose an operational AWS profile (loads its EC2 instances)
3. Connect          → click SSM (shell) or RDP (tunnel) on an instance row
```

Under the hood the app shells out to the **AWS CLI** (`aws ssm start-session`) and the
**Session Manager plugin**, so those must be installed (see prerequisites).

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

These are external tools Portus calls at runtime. The app will show an error toast if
one is missing.

| Tool | Why | Install |
|------|-----|---------|
| **AWS CLI v2** | Runs `aws ssm start-session` for SSM & RDP | <https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html> |
| **AWS Session Manager plugin** | Required by `aws ssm start-session` | <https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html> |
| **aws-azure-login** | Azure AD SSO authentication | `npm install -g aws-azure-login` |
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
| `ssm:StartSession` | Opening SSM shells and RDP tunnels |

`ssm:DescribeInstanceInformation` is optional — without it the SSM Agent column
shows *Unknown* and the connect buttons stay enabled, so nothing is blocked.

---

## AWS profile configuration

Portus reads your standard AWS config at `~/.aws/config` (and `~/.aws/credentials`).
It splits profiles into two groups:

- **SSO profiles** — contain `azure_*` fields → shown in the "SSO Connect" dialog
- **Operational profiles** — everything else → shown in the top-bar profile dropdown

Example `~/.aws/config`:

```ini
# --- Azure AD SSO profile (used for "SSO Connect") ---
[profile my-sso]
azure_tenant_id = 00000000-0000-0000-0000-000000000000
azure_app_id_uri = https://signin.aws.amazon.com/saml
azure_default_username = you@company.com
azure_default_role_arn = arn:aws:iam::123456789012:role/YourRole
region = me-central-1

# --- Operational profile (used to list instances & connect) ---
[profile my-account]
region = me-central-1
# credentials populated by aws-azure-login after SSO, or static keys, etc.
```

> Tip: `aws-azure-login --profile my-sso` should work from your terminal before you
> rely on it in the app.

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
```

The window opens on a welcome screen. Click **SSO Connect**, authenticate, pick an
operational profile, and your instances load automatically.

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
  npm version 1.4.0 --no-git-tag-version   # or edit package.json by hand
  git commit -am "Release v1.4.0"
  git tag -a v1.4.0 -m "Portus v1.4.0"
  git push origin main --follow-tags
  ```

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
│   ├── renderer.js      # UI logic (AWSManager class): login, instances, connect
│   ├── index.html       # App markup
│   ├── styles.css        # Glassmorphism theme (graphite + steel blue)
│   └── assets/
│       └── portus.png   # In-app logo
├── build/
│   ├── portus.png       # Source icon (macOS/Linux; electron-builder generates sizes)
│   └── portus.ico       # Multi-size Windows icon (16–256 px)
├── .github/workflows/
│   └── release.yml      # Builds Windows/macOS/Linux on a v* tag, attaches to a draft release
├── package.json         # Scripts + electron-builder config
└── README.md
```

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
| RDP client doesn't launch | Windows: ensure `mstsc` available · macOS: install Microsoft Remote Desktop · Linux: install `remmina`/`xfreerdp`/`rdesktop` |
| No profiles in the SSO dialog | No `azure_*` profiles found in `~/.aws/config` |
| No operational profiles in dropdown | Add a non-Azure profile to `~/.aws/config` |
| App icon not updating (Windows) | Stale icon cache — run `ie4uinit.exe -show` or reinstall to a new path |

---

## Tech stack

- **Electron 37** (electron-builder 24 for packaging)
- **AWS SDK v3** — `@aws-sdk/client-ec2`, `@aws-sdk/credential-providers`
- `fs-extra`, `ini` (read `~/.aws` config)
- External CLIs at runtime: **AWS CLI v2**, **Session Manager plugin**, **aws-azure-login**

---

Released under the [MIT License](LICENSE).
