class Portus {
    constructor() {
        // auth / profiles
        this.profiles = [];              // every profile in ~/.aws, provider-tagged
        this.loginTargets = [];          // what the sign-in dialog offers, SSO grouped by session
        this.currentProfile = null;
        this.selectedProfile = null;
        this.selectedAuthProfile = null;
        this.isLoggedIn = false;         // the current profile's credentials work

        // data
        this.instances = [];
        this.selectedInstanceId = null;
        this.tunnels = [];

        // EKS view. Listed on first visit rather than with the instances: it is
        // two AWS calls per cluster, and most sessions never open the tab.
        this.clusters = [];
        this.clustersLoaded = false;
        this.clusterError = null;
        // Which instance to tunnel through, when the automatic choice was
        // overridden for a particular cluster
        this.hopOverrides = new Map();
        this.selectedClusterName = null;

        // Managed endpoints suggested in the port forwarding dialog, keyed by
        // profile and region — the same account holds different databases in
        // different regions, so the key has to carry both.
        this.endpointCache = new Map();

        // region
        this.regions = [];               // what this account has enabled
        this.currentRegion = null;       // what every request is made against
        this.regionCache = new Map();    // keyed by profile; enabling a region is rare
        this.regionComboOpen = false;
        this.regionMatches = [];
        this.regionIndex = 0;

        // view state
        this.view = 'instances';
        this.filters = { text: '', state: 'all', os: 'all' };

        // combobox
        this.comboOpen = false;
        this.comboMatches = [];
        this.comboIndex = 0;

        // session
        this.uptimeTicker = null;
        this.sessionWatcher = null;
        this.isRefreshingSession = false;
        this.lastRefreshAt = null;

        this.toastTimer = null;

        this.init();
    }

    async init() {
        // Real work still gates the splash. The floor only stops it flashing past
        // when startup is quick — no step is faked to fill the time, and a slow
        // start is never padded further.
        const splashShownAt = Date.now();
        const MIN_SPLASH_MS = 1800;

        this.applyStoredTheme();
        this.applyStoredRail();
        this.bindChrome();
        this.bindCombo();
        this.bindRegionCombo();
        this.bindFilters();
        this.bindTunnelEvents();
        window.electronAPI.onSsoVerification(({ code }) => this.showSsoVerification(code));
        window.electronAPI.onMfaRequired(request => this.showMfaPrompt(request));
        window.electronAPI.onMfaCancelled(({ id }) => this.dismissMfaPrompt(id));
        window.electronAPI.onRoleChoiceRequired(request => this.showRoleChoice(request));

        await this.applyAppVersion();
        this.checkRequiredTools();

        // Started here rather than awaited, so a slow or unreachable GitHub
        // cannot hold the splash open. Whatever it finds is shown once the app
        // is on screen.
        const updateCheck = this.resolveUpdate();

        await this.loadProfiles();

        this.updateConnection(false);

        const hint = document.getElementById('splashHint');
        if (hint) hint.textContent = 'Ready';

        const elapsed = Date.now() - splashShownAt;
        if (elapsed < MIN_SPLASH_MS) {
            await new Promise(resolve => setTimeout(resolve, MIN_SPLASH_MS - elapsed));
        }
        this.hideSplash();

        window.portus = this; // debugging aid only; nothing in the UI depends on it

        this.announceRelease(await updateCheck);
    }

    // The release check, answered from the last one when it is recent enough.
    //
    // It used to call GitHub on every launch. Nothing published between two
    // launches an hour apart is worth a network round trip each time, and on a
    // machine with no route out it is a request that can only fail. A day is
    // long enough to stay useful and short enough that nobody is left behind.
    async resolveUpdate() {
        const cached = this.readUpdateCache();
        if (cached) return cached;

        try {
            const result = await window.electronAPI.checkForUpdate();
            this.writeUpdateCache(result);
            return result || { available: false };
        } catch (error) {
            // A failed check is not cached: the next launch should try again
            // rather than inherit a day of silence from one bad moment.
            return { available: false };
        }
    }

    readUpdateCache() {
        try {
            const raw = localStorage.getItem('portus.updateCheck');
            if (!raw) return null;

            const cached = JSON.parse(raw);
            if (!cached || typeof cached.checkedAt !== 'number') return null;

            const age = Date.now() - cached.checkedAt;
            // A clock that moved backwards makes `age` negative, which would
            // otherwise pass as fresh forever
            if (age < 0 || age > 24 * 60 * 60 * 1000) return null;

            return cached.result || { available: false };
        } catch (error) {
            return null;   // unreadable or not JSON: check again
        }
    }

    writeUpdateCache(result) {
        try {
            localStorage.setItem('portus.updateCheck', JSON.stringify({
                checkedAt: Date.now(),
                result: result || { available: false }
            }));
        } catch (error) { /* no storage: check every launch, as before */ }
    }

    // Shown until it is dismissed, then not again for that version. Nothing is
    // downloaded: the link goes to the releases page and the user installs it
    // however they installed Portus in the first place.
    announceRelease(update) {
        if (!update || !update.available || !update.version) return;

        // Kept whether or not the dialog is shown, so the badge outlives the
        // dismissal and the notes stay reachable from it.
        this.pendingUpdate = update;
        this.renderUpdateBadge();

        if (this.releaseAlreadySeen(update.version)) return;

        this.showReleaseDialog(update);
    }

    // Split from announceRelease so the badge can bring it back after it has
    // been dismissed. Reopening deliberately does not re-check anything: it is
    // showing what the last check found, which is what the badge is about.
    showReleaseDialog(update) {
        const overlay = document.createElement('div');
        overlay.className = 'overlay';
        overlay.id = 'releaseOverlay';
        overlay.innerHTML = `
            <div class="dialog">
                <div class="dialog-head">
                    <h3>Portus ${this.escapeHtml(update.version)} is available</h3>
                    <button type="button" class="icon-btn" data-close><i class="fas fa-times"></i></button>
                </div>
                <div class="dialog-body">
                    <p class="dialog-note">
                        You are running ${this.escapeHtml(update.current || '')}. Portus does not update
                        itself — download the new version when it suits you.
                    </p>
                    <div class="release-notes" id="releaseNotes"></div>
                </div>
                <div class="dialog-foot">
                    <button type="button" class="btn" data-close>Not now</button>
                    <button type="button" class="btn btn-primary" id="releaseOpen">
                        <i class="fas fa-arrow-up-right-from-square"></i> View release
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        // textContent, not innerHTML: these notes arrive over the network, and
        // markup in them must render as the characters it is, not as markup.
        const notes = overlay.querySelector('#releaseNotes');
        notes.textContent = update.notes || 'No release notes were published for this version.';

        // Recorded on dismissal rather than on display. Closing it, opening the
        // release or clicking away are all acknowledgements; quitting before any
        // of those is not, and the whole point of this dialog is that it was read
        // at least once. Being told twice is a smaller failure than never.
        let onKey;
        const close = () => {
            if (onKey) document.removeEventListener('keydown', onKey);
            this.rememberSeenRelease(update.version);
            overlay.remove();
        };

        // Escape counts as dismissing it. The global handler in bindChrome removes
        // any overlay on Escape without going through here, so this listens too —
        // otherwise Escape would close the dialog and bring it back next launch.
        onKey = (e) => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);

        overlay.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        overlay.querySelector('#releaseOpen').addEventListener('click', async () => {
            await window.electronAPI.openReleasePage(update.url || update.releasesUrl);
            close();
        });

        setTimeout(() => overlay.querySelector('#releaseOpen').focus(), 50);
    }

    // Marks the version chip when a newer release exists.
    //
    // Dismissing the dialog used to be the end of it: the update was invisible
    // until a newer release came along, and there was nothing to click back to.
    // The badge is what survives the dismissal, which also makes a "remind me
    // later" button unnecessary — the reminder is simply still there.
    renderUpdateBadge() {
        const update = this.pendingUpdate;
        // The cached answer can outlive the version it was about. Comparing it
        // against what is actually running is what stops the badge surviving
        // the update it was telling you to install.
        const stale = !update
            || !update.version
            || !this.isNewerVersion(update.version, this.appVersion);

        document.querySelectorAll('.js-app-version').forEach(chip => {
            chip.classList.toggle('has-update', !stale);

            if (stale) {
                chip.removeAttribute('title');
                chip.removeAttribute('role');
                chip.removeAttribute('tabindex');
                return;
            }

            chip.title = `Portus ${update.version} is available — click for what changed`;
            chip.setAttribute('role', 'button');
            chip.setAttribute('tabindex', '0');
        });

        if (stale || this.updateBadgeBound) return;

        // Bound once. The chip is never replaced, so re-binding on every render
        // would stack handlers and open a dialog per launch-check.
        this.updateBadgeBound = true;
        document.querySelectorAll('.js-app-version').forEach(chip => {
            const reopen = () => {
                if (!this.pendingUpdate) return;
                if (document.querySelector('.overlay')) return;   // already open
                this.showReleaseDialog(this.pendingUpdate);
            };
            chip.addEventListener('click', reopen);
            chip.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reopen(); }
            });
        });
    }

    // Numeric compare, so 2.7.10 is newer than 2.7.9 rather than alphabetically
    // older. Anything unparseable is treated as not newer: a badge shown by
    // accident is worse than one missed, since it cannot be dismissed.
    isNewerVersion(latest, current) {
        if (!latest || !current) return false;

        const parts = (value) => String(value).replace(/^v/, '').split('.').map(Number);
        const a = parts(latest);
        const b = parts(current);

        if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;

        for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
            const left = a[i] || 0;
            const right = b[i] || 0;
            if (left !== right) return left > right;
        }
        return false;
    }

    releaseAlreadySeen(version) {
        try {
            return localStorage.getItem('portus.releaseSeen') === version;
        } catch (error) {
            return false;   // no storage: showing it again beats never showing it
        }
    }

    rememberSeenRelease(version) {
        try { localStorage.setItem('portus.releaseSeen', version); } catch (error) { /* ignore */ }
    }

    hideSplash() {
        const splash = document.getElementById('splash');
        if (!splash) return;
        splash.classList.add('hidden');
        setTimeout(() => splash.remove(), 400);
    }

    // ==========================================================================
    // THEME
    // ==========================================================================

    applyStoredTheme() {
        let theme = 'dark';
        try {
            const stored = localStorage.getItem('portus.theme');
            if (stored === 'light' || stored === 'dark') theme = stored;
        } catch (error) { /* storage unavailable; fall back to dark */ }
        this.setTheme(theme);
    }

    setTheme(theme) {
        document.documentElement.dataset.theme = theme;
        const icon = document.querySelector('#themeBtn i');
        if (icon) icon.className = theme === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
        try { localStorage.setItem('portus.theme', theme); } catch (error) { /* ignore */ }
    }

    toggleTheme() {
        this.setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    }

    // ==========================================================================
    // SIDEBAR RAIL
    // ==========================================================================

    applyStoredRail() {
        let collapsed = false;
        try { collapsed = localStorage.getItem('portus.rail') === '1'; } catch (error) { /* ignore */ }
        this.setRail(collapsed);
    }

    setRail(collapsed) {
        const body = document.querySelector('.body');
        const toggle = document.getElementById('railToggle');

        body.classList.toggle('rail', collapsed);

        if (toggle) {
            toggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
            toggle.dataset.label = collapsed ? 'Expand' : 'Collapse';
        }
        try { localStorage.setItem('portus.rail', collapsed ? '1' : '0'); } catch (error) { /* ignore */ }
    }

    toggleRail() {
        this.setRail(!document.querySelector('.body').classList.contains('rail'));
    }

    async applyAppVersion() {
        try {
            const version = await window.electronAPI.getAppVersion();
            if (!version) return;
            // Kept, so a cached update can be re-checked against what is
            // actually running rather than trusted from storage
            this.appVersion = version;
            document.querySelectorAll('.js-app-version').forEach(el => { el.textContent = `v${version}`; });
        } catch (error) { /* keep the placeholder in the markup */ }
    }

    // ==========================================================================
    // CHROME (top bar, nav, keyboard)
    // ==========================================================================

    bindChrome() {
        document.getElementById('themeBtn').addEventListener('click', () => this.toggleTheme());
        document.getElementById('railToggle').addEventListener('click', () => this.toggleRail());
        document.getElementById('loginBtn').addEventListener('click', () => this.openSsoDialog());
        document.getElementById('brandHome').addEventListener('click', () => this.showView('instances'));
        document.getElementById('refreshBtn').addEventListener('click', () => this.loadInstances());

        document.getElementById('eksRefresh').addEventListener('click', () => this.loadClusterView());
        document.getElementById('eksProfile').addEventListener('change', async () => {
            // Regions belong to the account. Carrying the last one over would
            // ask for clusters in a region those credentials may not even have
            // enabled, so the picker is rebuilt and lands on that profile's own.
            await this.renderEksRegions(document.getElementById('eksProfile').value);
            this.loadClusterView();
        });
        document.getElementById('eksRegion').addEventListener('change', () => this.loadClusterView());

        const search = document.getElementById('searchInput');
        search.addEventListener('input', () => {
            this.filters.text = search.value.trim().toLowerCase();
            this.renderInstances();
        });

        document.querySelectorAll('.nav-item[data-view]').forEach(item => {
            item.addEventListener('click', () => this.showView(item.dataset.view));
        });

        const bannerClose = document.getElementById('depBannerClose');
        bannerClose.addEventListener('click', () => {
            document.getElementById('depBanner').style.display = 'none';
        });

        document.querySelector('.toast-close').addEventListener('click', () => {
            document.getElementById('toast').classList.remove('show');
        });

        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                if (!search.disabled) search.focus();
                return;
            }
            if (e.key === 'Escape') {
                const overlay = document.querySelector('.overlay');
                if (overlay) { overlay.remove(); return; }
                if (this.comboOpen) { this.closeCombo(); return; }
                // Last, so Escape closes whatever is most on top: a dialog, then
                // an open combo, then whichever detail panel is open underneath.
                this.clearInstanceSelection();
                this.clearClusterSelection();
            }
        });

        // The detail panel is part of the layout rather than an overlay, so
        // nothing was dismissing it — opening it was easy and closing it meant
        // reloading the list. Clicking away from it is the obvious gesture.
        // Capture, deliberately. Selecting a row re-renders the table, so by the
        // time a bubbled click reached here the clicked row had been replaced
        // and no longer matched anything — the panel opened and shut in the same
        // click. In the capture phase the document is still as the user saw it.
        document.addEventListener('click', (e) => {
            if (!this.selectedInstanceId) return;
            // Inside the panel is not "away from" it
            if (e.target.closest('#detailPanel')) return;
            // Another row selects that instance rather than closing; its own
            // handler runs after this one and does the selecting.
            if (e.target.closest('#instanceTableWrap tbody tr')) return;
            // A dialog is in front of the panel, not outside it
            if (e.target.closest('.overlay')) return;

            this.clearInstanceSelection();
        }, true);

        // The cluster panel closes the same way, for the same reasons
        document.addEventListener('click', (e) => {
            if (!this.selectedClusterName) return;
            if (e.target.closest('#clusterDetail')) return;
            if (e.target.closest('#clusterTableWrap tbody tr')) return;
            if (e.target.closest('.overlay')) return;

            this.clearClusterSelection();
        }, true);
    }

    clearInstanceSelection() {
        if (!this.selectedInstanceId) return;
        this.selectedInstanceId = null;
        this.renderInstances();
        this.renderDetail(null);
    }

    // Segmented state / OS filters above the instance table
    bindFilters() {
        const bindSeg = (containerId, key, attr) => {
            const container = document.getElementById(containerId);
            if (!container) return;
            container.querySelectorAll('button').forEach(button => {
                button.addEventListener('click', () => {
                    container.querySelectorAll('button').forEach(b => b.classList.remove('on'));
                    button.classList.add('on');
                    this.filters[key] = button.dataset[attr];
                    this.renderInstances();
                });
            });
        };

        bindSeg('filterState', 'state', 'state');
        bindSeg('filterOs', 'os', 'os');
    }

    showView(view) {
        this.view = view;
        document.getElementById('viewInstances').style.display = view === 'instances' ? 'flex' : 'none';
        document.getElementById('viewEks').style.display = view === 'eks' ? 'flex' : 'none';
        document.getElementById('viewTunnels').style.display = view === 'tunnels' ? 'flex' : 'none';
        document.querySelectorAll('.nav-item[data-view]').forEach(item => {
            item.classList.toggle('active', item.dataset.view === view);
        });

        // Fetched when the tab is opened rather than on profile load: listing
        // clusters is two AWS calls per cluster, and most sessions never come
        // here at all.
        if (view === 'eks' && !this.clustersLoaded) this.loadClusterView();

        // the uptime column only needs redrawing while it is on screen
        this.syncUptimeTicker();
        if (view === 'tunnels') this.tickUptime();
    }

    // ==========================================================================
    // EXTERNAL TOOL PREFLIGHT
    // ==========================================================================

    async checkRequiredTools() {
        const banner = document.getElementById('depBanner');
        const list = document.getElementById('depBannerList');

        try {
            const result = await window.electronAPI.checkRequiredTools();
            if (!result || !result.success) return;

            const missing = (result.tools || []).filter(tool => !tool.found);
            if (!missing.length) return;

            list.innerHTML = missing.map(tool => `
                <li>
                    <span class="dep-name">${this.escapeHtml(tool.name)}</span>
                    <span class="dim">${this.escapeHtml(tool.purpose)}</span>
                    <code>${this.escapeHtml(tool.install)}</code>
                </li>
            `).join('');
            banner.style.display = 'flex';
        } catch (error) { /* a failed preflight must never block the app */ }
    }

    // ==========================================================================
    // PROFILES
    // ==========================================================================

    async loadProfiles() {
        try {
            const result = await window.electronAPI.getProfiles();
            this.profiles = (result && result.data) || [];

            // What the sign-in dialog offers is not one entry per profile:
            // Identity Center issues one token per portal session, so those are
            // grouped. Everything else here is still selectable — its credentials
            // just come from somewhere Portus does not drive.
            const targets = await window.electronAPI.getLoginTargets();
            this.loginTargets = (targets && targets.data) || [];

            if (result && !result.success) this.toast(result.error, 'error');

            this.renderComboOptions('');
            this.updateProfileControls();
        } catch (error) {
            this.toast('Failed to load AWS profiles: ' + error.message, 'error');
        }
    }

    // Re-read ~/.aws on demand and report what changed, so it is obvious whether
    // the edit that was just made actually landed.
    async reloadProfiles() {
        const before = new Set((this.profiles || []).map(p => p.name));

        this.setBusy(true);
        try {
            await this.loadProfiles();
        } finally {
            this.setBusy(false);
        }

        const after = (this.profiles || []).map(p => p.name);
        const added = after.filter(name => !before.has(name));
        const removed = [...before].filter(name => !after.includes(name));

        if (added.length) {
            this.toast(`Found ${added.length === 1 ? added[0] : `${added.length} new profiles`}`, 'success');
        } else if (removed.length) {
            this.toast(`${removed.length === 1 ? removed[0] : `${removed.length} profiles`} no longer in ~/.aws`, 'info');
        } else {
            this.toast(`No change — ${after.length} profile${after.length === 1 ? '' : 's'}`, 'info');
        }

        // a profile that vanished cannot stay selected
        if (this.currentProfile && !after.includes(this.currentProfile)) {
            this.currentProfile = null;
            this.selectedProfile = null;
            this.isLoggedIn = false;
            const label = document.getElementById('profileComboLabel');
            label.textContent = 'Select profile';
            label.classList.add('placeholder');

            this.currentRegion = null;
            this.regions = [];
            document.getElementById('statusRegion').textContent = '—';
            this.updateRegionControls();
            this.updateConnection(false);
        } else if (this.currentProfile) {
            // its provider may have been edited. The region is deliberately left
            // alone: re-reading ~/.aws is not choosing a profile, and resetting it
            // here would throw away a region the user switched to.
            this.selectedProfile = (this.profiles || []).find(p => p.name === this.currentProfile) || null;
            this.renderRegionLabel();
        }
    }

    // Having nothing to pick from is the only reason to disable the picker — a
    // sign-in is never a precondition. Likewise the sign-in button: with no
    // profile that has a login behind it, it is not broken, there is simply
    // nothing to sign into.
    updateProfileControls() {
        const btn = document.getElementById('loginBtn');
        const trigger = document.getElementById('profileComboTrigger');
        if (!btn || !trigger) return;

        trigger.disabled = (this.profiles || []).length === 0;

        // It is a sign-in control, so what matters is whether there is anything
        // to sign into — not whether the current profile happens to be working.
        const available = (this.loginTargets || []).length > 0;
        btn.disabled = !available;
        btn.title = available
            ? 'Sign in to a profile that supports it'
            : 'No profile in ~/.aws has a sign-in Portus can run';

        this.renderClusterSourceControls();
    }

    // The EKS tab lists clusters from whichever account is chosen here, which
    // defaults to the one in the sidebar. A cluster can live in a different
    // account from the instances that reach it.
    renderClusterSourceControls() {
        const picker = document.getElementById('eksProfile');
        if (!picker) return;

        const chosen = picker.value || this.currentProfile;

        picker.innerHTML = (this.profiles || []).map(profile => `
            <option value="${this.escapeHtml(profile.name)}"${profile.name === chosen ? ' selected' : ''}>${this.escapeHtml(profile.name)}</option>`).join('');
    }

    // Every region that account has enabled, starting on the one its profile
    // names. Cached per profile, and shared with the sidebar picker — the
    // answer is the same question asked of the same credentials.
    async regionsFor(profileName) {
        if (!profileName) return { regions: [], configured: null };

        const cached = this.regionCache.get(profileName);
        if (cached) return { regions: cached.data || [], configured: cached.configured || null };

        try {
            const result = await window.electronAPI.getRegions(profileName);
            const entry = {
                data: (result && result.data) || [],
                limited: !!(result && result.limited),
                configured: (result && result.configured) || null
            };
            this.regionCache.set(profileName, entry);
            return { regions: entry.data, configured: entry.configured };
        } catch (error) {
            // A region list that could not be read still leaves the tab usable
            return { regions: [], configured: null };
        }
    }

    // Fills the EKS region picker for the account it is pointed at.
    //
    // `preferred` keeps a region the user chose, but only if that account has
    // it: regions are per account, and carrying one across would ask for
    // clusters in a region the credentials may not have enabled.
    async renderEksRegions(profileName, preferred) {
        const select = document.getElementById('eksRegion');
        if (!select) return null;

        const { regions, configured } = await this.regionsFor(profileName);

        // The profile's own region is the default. Falling back to whatever the
        // account has, rather than to nothing, keeps the picker usable when a
        // profile names no region at all.
        const fallback = configured || (regions[0] && regions[0].name) || null;
        const keep = preferred && regions.some(region => region.name === preferred) ? preferred : null;
        const selected = keep || fallback;

        select.innerHTML = regions.length
            ? regions.map(region => `
                <option value="${this.escapeHtml(region.name)}"${region.name === selected ? ' selected' : ''}>${this.escapeHtml(this.regionLabel(region))}</option>`).join('')
            : '<option value="">no regions available</option>';

        return selected;
    }

    // "Frankfurt · eu-central-1" where the city is known, the code alone where
    // it is not — the same shape the sidebar picker uses.
    regionLabel(region) {
        if (!region || !region.name) return '';
        return region.label ? `${region.label} · ${region.name}` : region.name;
    }

    // ==========================================================================
    // REGION
    // ==========================================================================

    bindRegionCombo() {
        const combo = document.getElementById('regionCombo');
        const trigger = document.getElementById('regionComboTrigger');
        const search = document.getElementById('regionComboSearch');

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.regionComboOpen ? this.closeRegionCombo() : this.openRegionCombo();
        });

        search.addEventListener('input', () => this.renderRegionOptions(search.value));

        search.addEventListener('keydown', (e) => {
            const count = this.regionMatches.length;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (count) this.setRegionIndex((this.regionIndex + 1) % count);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (count) this.setRegionIndex((this.regionIndex - 1 + count) % count);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const match = this.regionMatches[this.regionIndex];
                if (match) this.chooseRegion(match.name);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.closeRegionCombo();
                trigger.focus();
            }
        });

        document.addEventListener('click', (e) => {
            if (this.regionComboOpen && !combo.contains(e.target)) this.closeRegionCombo();
        });
    }

    openRegionCombo() {
        const trigger = document.getElementById('regionComboTrigger');
        if (trigger.disabled) return;

        this.regionComboOpen = true;
        document.getElementById('regionCombo').classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');

        const search = document.getElementById('regionComboSearch');
        search.value = '';
        this.renderRegionOptions('');
        setTimeout(() => search.focus(), 0);
    }

    closeRegionCombo() {
        this.regionComboOpen = false;
        document.getElementById('regionCombo').classList.remove('open');
        document.getElementById('regionComboTrigger').setAttribute('aria-expanded', 'false');
    }

    renderRegionOptions(filter) {
        const list = document.getElementById('regionComboList');
        const count = document.getElementById('regionComboCount');
        const note = document.getElementById('regionComboNote');
        const all = this.regions || [];
        const term = (filter || '').trim().toLowerCase();

        // Searching by city as well as by code, since "Frankfurt" is what people
        // actually know and "eu-central-1" is what they have to type today.
        this.regionMatches = term
            ? all.filter(region => region.name.toLowerCase().includes(term)
                || (region.label || '').toLowerCase().includes(term))
            : all.slice();

        list.innerHTML = '';

        if (!all.length) {
            list.innerHTML = '<div class="combo-empty">Choose a profile first</div>';
            count.textContent = '';
            return;
        }
        if (!this.regionMatches.length) {
            list.innerHTML = `<div class="combo-empty">No region matches &ldquo;${this.escapeHtml(filter)}&rdquo;</div>`;
            count.textContent = `0 of ${all.length}`;
            return;
        }

        this.regionMatches.forEach((region, index) => {
            const option = document.createElement('div');
            option.className = 'combo-option';
            option.setAttribute('role', 'option');
            if (region.name === this.currentRegion) {
                option.classList.add('selected');
                option.setAttribute('aria-selected', 'true');
            }
            option.innerHTML = `
                <span class="opt-name">${region.label ? this.highlight(region.label, term) : this.highlight(region.name, term)}</span>
                ${region.label ? `<span class="opt-region mono">${this.highlight(region.name, term)}</span>` : ''}
                <i class="fas fa-check opt-check"></i>
            `;
            option.addEventListener('click', () => this.chooseRegion(region.name));
            option.addEventListener('mousemove', () => this.setRegionIndex(index));
            list.appendChild(option);
        });

        count.textContent = term ? `${this.regionMatches.length} of ${all.length}` : `${all.length} enabled`;
        note.textContent = this.regionsLimited ? 'Only the profile’s own region could be read' : '';

        const selected = this.regionMatches.findIndex(r => r.name === this.currentRegion);
        this.setRegionIndex(selected >= 0 ? selected : 0);
    }

    setRegionIndex(index) {
        const options = document.querySelectorAll('#regionComboList .combo-option');
        if (!options.length) return;
        this.regionIndex = index;
        options.forEach((el, i) => el.classList.toggle('active', i === index));
        if (options[index]) options[index].scrollIntoView({ block: 'nearest' });
    }

    // The picker shows the region in use; the label carries the city when there
    // is one, because "Frankfurt" identifies a place and "eu-central-1" does not.
    renderRegionLabel() {
        const label = document.getElementById('regionComboLabel');
        if (!label) return;

        if (!this.currentRegion) {
            label.textContent = '—';
            label.classList.add('placeholder');
            return;
        }

        const region = (this.regions || []).find(r => r.name === this.currentRegion);
        label.textContent = region && region.label ? `${region.label} · ${region.name}` : this.currentRegion;
        label.classList.remove('placeholder');

        const statusRegion = document.getElementById('statusRegion');
        if (statusRegion) statusRegion.textContent = this.currentRegion;
    }

    chooseRegion(name) {
        this.closeRegionCombo();
        if (!name || name === this.currentRegion) return;

        this.currentRegion = name;
        this.renderRegionLabel();

        // Endpoints belong to a region, so the suggestions for the old one would
        // be wrong here — and pointing a tunnel at a database in another region
        // is a failure that looks like a network problem.
        this.endpointCache.clear();
        this.forgetClusters();

        this.loadInstances();
    }

    // Endpoints are per account *and* per region: the same profile holds
    // different databases in eu-central-1 than in us-east-1, so a key of profile
    // alone would offer one region's hosts while connected to another.
    endpointCacheKey(profileName = this.currentProfile, region = this.currentRegion) {
        return `${profileName}|${region}`;
    }

    // Enabled regions for the current profile. The picker is usable immediately
    // with the profile's own region, and grows to the full list once it arrives.
    async loadRegions() {
        const profileName = this.currentProfile;
        if (!profileName) return;

        const cached = this.regionCache.get(profileName);
        if (cached) {
            this.regions = cached.data;
            this.regionsLimited = cached.limited;
            this.updateRegionControls();
            return;
        }

        try {
            const result = await window.electronAPI.getRegions(profileName);
            if (this.currentProfile !== profileName) return;   // switched while in flight

            this.regions = (result && result.data) || [];
            this.regionsLimited = !!(result && result.limited);
            // `configured` is the region the profile itself names. The EKS tab
            // starts there for whichever account it is pointed at, which is not
            // always the one in the sidebar.
            this.regionCache.set(profileName, {
                data: this.regions,
                limited: this.regionsLimited,
                configured: (result && result.configured) || null
            });
        } catch (error) {
            this.regions = this.currentRegion ? [{ name: this.currentRegion, label: null }] : [];
            this.regionsLimited = true;
        }

        this.updateRegionControls();
    }

    updateRegionControls() {
        const trigger = document.getElementById('regionComboTrigger');
        if (!trigger) return;

        trigger.disabled = !this.currentProfile || (this.regions || []).length === 0;
        trigger.title = this.regionsLimited
            ? 'Only this profile’s own region could be listed — ec2:DescribeRegions was not available'
            : 'Switch region';

        this.renderRegionLabel();
    }

    bindCombo() {
        const combo = document.getElementById('profileCombo');
        const trigger = document.getElementById('profileComboTrigger');
        const search = document.getElementById('profileComboSearch');

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.comboOpen ? this.closeCombo() : this.openCombo();
        });

        search.addEventListener('input', () => this.renderComboOptions(search.value));

        // ~/.aws is read once at startup, so a profile added while Portus is open
        // was invisible until it was restarted.
        document.getElementById('profileComboRefresh').addEventListener('mousedown', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await this.reloadProfiles();
            this.renderComboOptions(search.value);
        });

        search.addEventListener('keydown', (e) => {
            const count = this.comboMatches.length;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (count) this.setComboIndex((this.comboIndex + 1) % count);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (count) this.setComboIndex((this.comboIndex - 1 + count) % count);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const match = this.comboMatches[this.comboIndex];
                if (match) this.chooseProfile(match.name);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.closeCombo();
                trigger.focus();
            }
        });

        document.addEventListener('click', (e) => {
            if (this.comboOpen && !combo.contains(e.target)) this.closeCombo();
        });
    }

    openCombo() {
        const trigger = document.getElementById('profileComboTrigger');
        if (trigger.disabled) return;

        this.comboOpen = true;
        document.getElementById('profileCombo').classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');

        const search = document.getElementById('profileComboSearch');
        search.value = '';
        this.renderComboOptions('');
        setTimeout(() => search.focus(), 0);
    }

    closeCombo() {
        this.comboOpen = false;
        document.getElementById('profileCombo').classList.remove('open');
        document.getElementById('profileComboTrigger').setAttribute('aria-expanded', 'false');
    }

    renderComboOptions(filter) {
        const list = document.getElementById('profileComboList');
        const foot = document.getElementById('profileComboCount');
        const all = this.profiles || [];
        const term = (filter || '').trim().toLowerCase();

        this.comboMatches = term
            ? all.filter(p => p.name.toLowerCase().includes(term)
                || (p.region || '').toLowerCase().includes(term)
                || (p.providerLabel || '').toLowerCase().includes(term))
            : all.slice();

        list.innerHTML = '';

        if (!all.length) {
            list.innerHTML = '<div class="combo-empty">No profiles found in ~/.aws</div>';
            foot.textContent = '';
            return;
        }
        if (!this.comboMatches.length) {
            list.innerHTML = `<div class="combo-empty">No profiles match &ldquo;${this.escapeHtml(filter)}&rdquo;</div>`;
            foot.textContent = `0 of ${all.length}`;
            return;
        }

        this.comboMatches.forEach((profile, index) => {
            const option = document.createElement('div');
            option.className = 'combo-option';
            option.setAttribute('role', 'option');
            if (profile.name === this.currentProfile) {
                option.classList.add('selected');
                option.setAttribute('aria-selected', 'true');
            }
            option.innerHTML = `
                <span class="opt-name">${this.highlight(profile.name, term)}</span>
                <span class="opt-provider">${this.escapeHtml(profile.providerLabel || '')}</span>
                <span class="opt-region mono">${this.escapeHtml(profile.region || '')}</span>
                <i class="fas fa-check opt-check"></i>
            `;
            option.addEventListener('click', () => this.chooseProfile(profile.name));
            option.addEventListener('mousemove', () => this.setComboIndex(index));
            list.appendChild(option);
        });

        foot.textContent = term
            ? `${this.comboMatches.length} of ${all.length} profiles`
            : `${all.length} profiles`;

        const selected = this.comboMatches.findIndex(p => p.name === this.currentProfile);
        this.setComboIndex(selected >= 0 ? selected : 0);
    }

    setComboIndex(index) {
        const options = document.querySelectorAll('#profileComboList .combo-option');
        if (!options.length) return;
        this.comboIndex = index;
        options.forEach((el, i) => el.classList.toggle('active', i === index));
        if (options[index]) options[index].scrollIntoView({ block: 'nearest' });
    }

    // No sign-in is demanded up front. Most credential types — access keys, an
    // assumed role, credential_process, an Identity Center token the CLI already
    // holds — are simply valid, and requiring an Azure login before any of them
    // could be selected locked out everyone who does not use Azure. If the
    // credentials turn out to be missing or expired, loadInstances says so and
    // offers the sign-in, which is the only point at which it is needed.
    chooseProfile(name) {
        this.closeCombo();

        this.currentProfile = name;
        this.selectedProfile = (this.profiles || []).find(p => p.name === name) || null;

        const label = document.getElementById('profileComboLabel');
        label.textContent = name;
        label.classList.remove('placeholder');

        // Selecting a profile starts from the region its config names. Carrying a
        // region across profiles would silently point one account's request at a
        // region chosen for another.
        this.currentRegion = (this.selectedProfile && this.selectedProfile.region) || null;
        this.regions = this.currentRegion ? [{ name: this.currentRegion, label: null }] : [];
        this.regionsLimited = false;
        this.endpointCache.clear();
        this.forgetClusters();
        this.updateRegionControls();

        // Not awaited: the instance list is what the user is waiting for, and the
        // picker is already usable with the profile's own region.
        this.loadRegions();
        this.loadInstances();
    }

    // ==========================================================================
    // SSO
    // ==========================================================================

    // Every row says how many profiles that one sign-in makes usable: the profiles
    // it signs in directly, plus any that assume a role from those via
    // source_profile, since one login covers the whole chain.
    describeLoginTarget(target) {
        const count = target.profileCount || 1;
        const label = target.providerLabel || '';

        return `${label} · ${count} profile${count === 1 ? '' : 's'}`;
    }

    openSsoDialog() {
        const loginable = this.loginTargets || [];

        if (!loginable.length) {
            this.toast((this.profiles || []).length
                ? 'None of your profiles have a sign-in Portus can run — pick one and it will use the credentials you already have'
                : 'No profiles found in ~/.aws', 'info');
            return;
        }

        const overlay = document.createElement('div');
        overlay.className = 'overlay';
        overlay.innerHTML = `
            <div class="dialog">
                <div class="dialog-head">
                    <h3>Sign in</h3>
                    <div class="head-actions">
                        <button type="button" class="link-btn" id="signInRefresh"
                                title="Re-read ~/.aws/config and ~/.aws/credentials">
                            <i class="fas fa-rotate"></i> Refresh
                        </button>
                        <button type="button" class="icon-btn" data-close><i class="fas fa-times"></i></button>
                    </div>
                </div>
                <div class="dialog-body">
                    <p class="dialog-note">
                        Profiles whose sign-in Portus can start. Every other profile can be
                        selected directly — its credentials are resolved by the AWS CLI.
                    </p>
                    <div class="profile-list" id="signInList"></div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        // Redrawn in place rather than reopened, so a refresh does not throw away
        // the dialog the user is looking at.
        const renderList = () => {
            const list = overlay.querySelector('#signInList');
            const targets = this.loginTargets || [];

            if (!targets.length) {
                list.innerHTML = '<div class="combo-empty">No profile in ~/.aws has a sign-in Portus can run</div>';
                return;
            }

            list.innerHTML = targets.map(target => `
                <div class="profile-item" tabindex="0" data-profile="${this.escapeHtml(target.profileName)}">
                    <i class="fas fa-key dim"></i>
                    <div class="pi-body">
                        <div class="pi-name">${this.escapeHtml(target.label)}</div>
                        <div class="pi-meta mono">${this.escapeHtml(this.describeLoginTarget(target))}</div>
                    </div>
                    <i class="fas fa-chevron-right dim"></i>
                </div>
            `).join('');

            list.querySelectorAll('.profile-item').forEach(item => {
                const go = () => { close(); this.authenticate(item.dataset.profile); };
                item.addEventListener('click', go);
                item.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
                });
            });
        };

        overlay.querySelector('#signInRefresh').addEventListener('click', async () => {
            await this.reloadProfiles();
            if (!overlay.isConnected) return;   // closed while reading
            renderList();
        });

        renderList();

        setTimeout(() => {
            const first = overlay.querySelector('.profile-item');
            if (first) first.focus();
        }, 50);
    }

    // Identity Center asks the user to confirm a pairing code in the browser. It
    // is only useful if they can see it here to compare, so it stays on screen
    // until the sign-in finishes one way or the other.
    showSsoVerification(code) {
        this.dismissSsoVerification();

        const overlay = document.createElement('div');
        overlay.className = 'overlay';
        overlay.id = 'ssoVerifyOverlay';
        overlay.innerHTML = `
            <div class="dialog">
                <div class="dialog-head"><h3>Confirm the sign-in</h3></div>
                <div class="dialog-body">
                    <p class="dialog-note">
                        Your browser is opening the AWS access portal. Check that it shows
                        this code, then approve the request.
                    </p>
                    <div class="verify-code mono">${this.escapeHtml(code)}</div>
                    <div class="hint">
                        <i class="fas fa-circle-info"></i>
                        <span>If no browser opened, run <span class="mono">aws sso login</span>
                              in a terminal — this window closes on its own when you are done.</span>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
    }

    dismissSsoVerification() {
        const existing = document.getElementById('ssoVerifyOverlay');
        if (existing) existing.remove();
    }

    // A profile with mfa_serial cannot produce credentials until the code is
    // entered, and the AWS call that triggered this is waiting on the answer.
    // Cancelling is a real outcome, so the dialog always sends one back.
    showMfaPrompt({ id, profileName }) {
        this.dismissMfaPrompt();

        const overlay = document.createElement('div');
        overlay.className = 'overlay';
        overlay.id = 'mfaOverlay';
        overlay.dataset.requestId = id;
        overlay.innerHTML = `
            <div class="dialog">
                <div class="dialog-head"><h3>Multi-factor authentication</h3></div>
                <div class="dialog-body">
                    <p class="dialog-note">
                        <strong>${this.escapeHtml(profileName)}</strong> needs a code from your
                        authenticator before AWS will issue credentials for it.
                    </p>
                    <div class="field">
                        <label class="field-label" for="mfaCode">Code</label>
                        <input class="input mono mfa-input" id="mfaCode" inputmode="numeric"
                               autocomplete="one-time-code" maxlength="6" placeholder="000000"
                               spellcheck="false">
                    </div>
                    <div class="hint">
                        <i class="fas fa-circle-info"></i>
                        <span>Entered once — the credentials it produces are reused until they expire.</span>
                    </div>
                </div>
                <div class="dialog-foot">
                    <button type="button" class="btn" data-cancel>Cancel</button>
                    <button type="button" class="btn btn-primary" id="mfaSubmit" disabled>Continue</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const input = overlay.querySelector('#mfaCode');
        const submit = overlay.querySelector('#mfaSubmit');

        let answered = false;
        const answer = async (code) => {
            if (answered) return;
            answered = true;
            overlay.remove();
            await window.electronAPI.submitMfaCode(id, code);
        };

        // Six digits, nothing else — a pasted code often arrives with a space
        input.addEventListener('input', () => {
            input.value = input.value.replace(/\D/g, '').slice(0, 6);
            submit.disabled = input.value.length !== 6;
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && input.value.length === 6) { e.preventDefault(); answer(input.value); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); answer(null); }
        });

        submit.addEventListener('click', () => answer(input.value));
        overlay.querySelector('[data-cancel]').addEventListener('click', () => answer(null));

        setTimeout(() => input.focus(), 50);
    }

    dismissMfaPrompt(id) {
        const existing = document.getElementById('mfaOverlay');
        if (!existing) return;
        if (id && existing.dataset.requestId !== id) return;
        existing.remove();
    }

    // arn:aws:iam::123456789012:role/some/path/Admin -> { name: 'Admin', account: '123456789012' }
    describeRoleArn(roleArn) {
        const parts = String(roleArn).split(':');
        const path = parts.slice(5).join(':');

        return {
            name: path.replace(/^role\//, '').split('/').pop() || roleArn,
            account: parts[4] || ''
        };
    }

    // An Azure assertion can grant several roles. Which one to assume is a real
    // decision — it is the account and the permissions the session will have —
    // so it is asked rather than guessed, and the sign-in waits on the answer.
    // Cancelling is an outcome the main process needs, so one is always sent.
    showRoleChoice({ id, profileName, roles }) {
        const existing = document.getElementById('roleChoiceOverlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'overlay';
        overlay.id = 'roleChoiceOverlay';
        overlay.dataset.requestId = id;
        overlay.innerHTML = `
            <div class="dialog">
                <div class="dialog-head"><h3>Choose a role</h3></div>
                <div class="dialog-body">
                    <p class="dialog-note">
                        Microsoft signed <strong>${this.escapeHtml(profileName)}</strong> in for more
                        than one AWS role. Pick the one this session should use.
                    </p>
                    <div class="profile-list" id="roleChoiceList">
                        ${(roles || []).map(roleArn => {
                            const { name, account } = this.describeRoleArn(roleArn);
                            return `
                                <div class="profile-item" tabindex="0" data-role="${this.escapeHtml(roleArn)}">
                                    <i class="fas fa-user-shield dim"></i>
                                    <div class="pi-body">
                                        <div class="pi-name">${this.escapeHtml(name)}</div>
                                        <div class="pi-meta mono">${this.escapeHtml(account)}</div>
                                    </div>
                                    <i class="fas fa-chevron-right dim"></i>
                                </div>
                            `;
                        }).join('')}
                    </div>
                    <div class="hint">
                        <i class="fas fa-circle-info"></i>
                        <span>Set <span class="mono">azure_default_role_arn</span> on the profile to
                              skip this and let renewals happen without asking.</span>
                    </div>
                </div>
                <div class="dialog-foot">
                    <button type="button" class="btn" data-cancel>Cancel</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        let answered = false;
        const answer = async (roleArn) => {
            if (answered) return;
            answered = true;
            overlay.remove();
            await window.electronAPI.submitRoleChoice(id, roleArn);
        };

        overlay.querySelectorAll('.profile-item').forEach(item => {
            const go = () => answer(item.dataset.role);
            item.addEventListener('click', go);
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
            });
        });

        overlay.querySelector('[data-cancel]').addEventListener('click', () => answer(null));
        // Clicking outside is not treated as a choice, but Escape is a cancel
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); answer(null); }
        });

        setTimeout(() => {
            const first = overlay.querySelector('.profile-item');
            if (first) first.focus();
        }, 50);
    }

    async authenticate(profileName) {
        this.selectedAuthProfile = profileName;
        const btn = document.getElementById('loginBtn');
        const original = btn.innerHTML;

        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Signing in…</span>';
        this.setBusy(true);
        this.toast(`Authenticating with ${profileName}…`, 'info');

        try {
            const result = await window.electronAPI.signIn(profileName);
            this.isLoggedIn = true;
            this.updateConnection(true, profileName);
            this.startSessionWatcher();
            this.toast(`Signed in with ${(result && result.providerLabel) || 'AWS'}`, 'success');

            // Signing in does not pick a profile; if one is already selected its
            // credentials have just changed, so reload against them.
            if (this.currentProfile) this.loadInstances();
        } catch (error) {
            this.isLoggedIn = false;
            this.selectedAuthProfile = null;
            this.updateConnection(false);
            btn.innerHTML = original;
            this.toast(`Authentication failed: ${error.error || error.message}`, 'error');
        } finally {
            this.dismissSsoVerification();
            this.setBusy(false);
            btn.disabled = false;
        }
    }

    updateConnection(connected, profileName = '') {
        const dot = document.getElementById('statusDot');
        const text = document.getElementById('statusText');
        const sso = document.getElementById('statusSso');
        const btn = document.getElementById('loginBtn');
        const search = document.getElementById('searchInput');
        const refresh = document.getElementById('refreshBtn');

        const provider = this.selectedProfile && this.selectedProfile.providerLabel;
        const shown = profileName || this.currentProfile || this.selectedAuthProfile || '';

        dot.className = `dot ${connected ? 'ok' : 'off'}`;
        text.textContent = connected ? 'Connected' : 'Not connected';
        sso.textContent = connected && shown
            ? (provider ? `${provider} · ${shown}` : shown)
            : 'No profile selected';

        btn.classList.toggle('connected', connected);
        btn.innerHTML = connected
            ? '<i class="fas fa-check"></i> <span>Signed in</span>'
            : '<i class="fas fa-right-to-bracket"></i> <span>Sign in</span>';

        // The picker is never gated on a sign-in. Whether a profile works is
        // decided by the first API call, not by whether an interactive login has
        // happened, because most credential types never have one.
        this.updateProfileControls();
        search.disabled = !this.currentProfile;
        refresh.disabled = !this.currentProfile;

        if (!connected) {
            document.getElementById('sessionMeter').style.display = 'none';
            document.getElementById('statusRenew').style.display = 'none';
            document.getElementById('statusRenewSep').style.display = 'none';
        }
    }

    // ==========================================================================
    // INSTANCES
    // ==========================================================================

    async loadInstances() {
        if (!this.currentProfile) return;

        // Deliberately not switching view. Choosing a profile reloads the
        // instance list, but it is not a request to go and look at it — being
        // thrown back to Instances from EKS or Tunnels every time the account
        // changed was the opposite of helpful.
        this.renderDetail(null);
        this.renderSkeleton();
        this.setBusy(true);
        document.getElementById('refreshBtn').disabled = true;

        try {
            const result = await window.electronAPI.getEc2Instances(this.currentProfile, this.currentRegion);

            if (result && result.success) {
                // A successful call is the proof that the profile works, whatever
                // its credentials came from. Nothing else marks the app connected.
                this.isLoggedIn = true;
                this.updateConnection(true, this.currentProfile);
                this.startSessionWatcher();

                this.instances = result.data || [];
                this.selectedInstanceId = null;
                this.renderInstances();

                if (result.ssmLookupFailed) {
                    this.toast(`Loaded ${this.instances.length} instances — SSM status unavailable, connect buttons left enabled`, 'warning');
                }
                return;
            }

            if (result && result.sessionExpired) {
                this.handleSessionExpired(result.error);
                return;
            }
            throw new Error(result?.error || 'No data returned');
        } catch (error) {
            const message = error.message || error.error || 'Unknown error';
            this.isLoggedIn = false;
            this.instances = [];
            this.renderInstances();
            this.updateConnection(false);
            this.setInstanceEmpty(message, 'fa-triangle-exclamation');
            this.toast(`Failed to load instances: ${message}`, 'error');
        } finally {
            this.setBusy(false);
            document.getElementById('refreshBtn').disabled = !this.currentProfile;
        }
    }

    matchesFilters(item) {
        const { text, state, os } = this.filters;

        if (state === 'running' && item.state !== 'running') return false;
        if (state === 'stopped' && item.state === 'running') return false;

        const isWindows = (item.platform || '').toLowerCase().includes('windows');
        if (os === 'windows' && !isWindows) return false;
        if (os === 'linux' && isWindows) return false;

        if (!text) return true;
        return [item.instanceName, item.instanceId, item.privateIp, item.publicIp, item.instanceType, item.platform]
            .filter(Boolean)
            .some(value => String(value).toLowerCase().includes(text));
    }

    renderInstances() {
        const wrap = document.getElementById('instanceTableWrap');
        const visible = this.instances.filter(item => this.matchesFilters(item));

        // The hop a cluster is reached through comes from this list, and the
        // two are loaded by separate calls — listing instances also waits on
        // the SSM inventory, so it lands second. Without this the cluster table
        // keeps offering whatever was loaded when it was drawn, which after a
        // profile switch means an instance in the account you just left.
        if (this.clustersLoaded) this.renderClusters();

        const reachable = this.instances.filter(i => i.state === 'running' &&
            (i.ssmStatus === 'online' || i.ssmStatus === 'unknown')).length;

        document.getElementById('navInstanceCount').textContent = this.instances.length;
        document.getElementById('instanceCount').textContent = this.instances.length
            ? `${visible.length} of ${this.instances.length} · ${reachable} reachable`
            : '';

        if (!this.instances.length) {
            this.setInstanceEmpty(
                this.currentProfile ? 'No instances found in this profile and region.'
                                    : 'Choose a profile to list instances.',
                'fa-server'
            );
            this.renderDetail(null);
            return;
        }
        if (!visible.length) {
            this.setInstanceEmpty('No instances match the current filters.', 'fa-filter');
            this.renderDetail(null);
            return;
        }

        const table = document.createElement('table');
        table.innerHTML = `
            <thead><tr>
                <th>Name</th><th>Instance ID</th><th>Type</th><th>State</th>
                <th>SSM</th><th>Private IP</th><th>OS</th>
                <th>Actions</th>
            </tr></thead>
        `;
        const tbody = document.createElement('tbody');
        visible.forEach(item => tbody.appendChild(this.buildRow(item)));
        table.appendChild(tbody);

        wrap.innerHTML = '';
        wrap.appendChild(table);

        // The panel only exists while a row is selected and still visible under
        // the current filters; otherwise the column is collapsed entirely.
        const stillVisible = this.selectedInstanceId &&
            visible.some(i => i.instanceId === this.selectedInstanceId);

        if (!stillVisible) {
            this.selectedInstanceId = null;
            this.renderDetail(null);
        }
    }

    // Reference-counted so overlapping requests do not switch the bar off early
    setBusy(on) {
        this.busyCount = Math.max(0, (this.busyCount || 0) + (on ? 1 : -1));
        document.getElementById('topProgress').hidden = this.busyCount === 0;
    }

    // Placeholder rows matching the real column layout, so nothing shifts when
    // the data arrives.
    renderSkeleton(rows = 6) {
        const widths = ['70%', '90%', '55%', '60%', '65%', '75%', '45%', '80%'];
        const table = document.createElement('table');
        table.innerHTML = `
            <thead><tr>
                <th>Name</th><th>Instance ID</th><th>Type</th><th>State</th>
                <th>SSM</th><th>Private IP</th><th>OS</th><th>Actions</th>
            </tr></thead>
        `;
        const tbody = document.createElement('tbody');
        for (let r = 0; r < rows; r++) {
            const tr = document.createElement('tr');
            tr.className = 'skeleton';
            tr.innerHTML = widths.map((w, i) =>
                `<td><span class="sk" style="width:${w};animation-delay:${(r * 8 + i * 40)}ms"></span></td>`
            ).join('');
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);

        const wrap = document.getElementById('instanceTableWrap');
        wrap.innerHTML = '';
        wrap.appendChild(table);
    }

    setInstanceEmpty(message, icon) {
        document.getElementById('instanceTableWrap').innerHTML = `
            <div class="empty">
                <i class="fas ${icon}"></i>
                <p>${this.escapeHtml(message)}</p>
            </div>
        `;
    }

    buildRow(item) {
        const row = document.createElement('tr');
        const running = item.state === 'running';
        const isWindows = (item.platform || '').toLowerCase().includes('windows');
        const ssmStatus = item.ssmStatus || 'unknown';
        const connectable = running && (ssmStatus === 'online' || ssmStatus === 'unknown');
        const blocked = this.escapeHtml(this.ssmBlockReason(ssmStatus));

        if (item.instanceId === this.selectedInstanceId) row.classList.add('selected');

        let actions;
        if (!running) {
            actions = '<button class="act" disabled title="Instance is not running">Stopped</button>';
        } else if (connectable) {
            actions = `
                <button class="act primary" data-action="ssm">SSM</button>
                ${isWindows ? '<button class="act" data-action="rdp">RDP</button>' : ''}
                <button class="act" data-action="port">Port</button>
            `;
        } else {
            // No agent of its own is not the same as unreachable: if something
            // managed is running in the same VPC, it can carry the traffic. The
            // SSM column still reports the real status, so nothing is hidden.
            const reachableVia = item.privateIp && this.hopCandidatesFor(item).length;

            actions = reachableVia
                ? `<button class="act" data-action="via"
                           title="${blocked} Portus can still reach it through a managed instance in the same VPC.">Access via…</button>`
                : `<button class="act" disabled title="${blocked}">No SSM</button>`;
        }

        row.innerHTML = `
            <td class="name-cell">${this.copyableCell(item.instanceName)}</td>
            <td class="mono">${this.copyableCell(item.instanceId)}</td>
            <td class="muted">${this.escapeHtml(item.instanceType || '')}</td>
            <td>${this.stateCell(item.state)}</td>
            <td>${this.ssmCell(item)}</td>
            <td class="mono">${this.copyableCell(item.privateIp)}</td>
            <td class="muted">${isWindows ? 'Windows' : 'Linux'}</td>
            <td class="actions"><div class="row-actions">${actions}</div></td>
        `;

        row.addEventListener('click', () => this.selectInstance(item.instanceId));
        row.querySelectorAll('button[data-action]').forEach(button => {
            button.addEventListener('click', (e) => {
                e.stopPropagation();
                this.runAction(button.dataset.action, item);
            });
        });

        // Copying is not selecting: without this the row opens the detail panel
        // underneath, which is not what someone reaching for an ID wanted.
        row.querySelectorAll('button[data-copy]').forEach(button => {
            button.addEventListener('click', (e) => {
                e.stopPropagation();
                this.copy(button.dataset.copy);
            });
        });

        return row;
    }

    // A name, an ID or an address is nearly always on its way somewhere else —
    // a ticket, a terminal, a colleague. Values the row does not have stay plain
    // text, since there is nothing to copy.
    copyableCell(value) {
        if (!value) return '—';

        const safe = this.escapeHtml(value);
        return `<button type="button" class="copy-cell" data-copy="${safe}"
                        title="Copy ${safe}" aria-label="Copy ${safe}">${safe}<i
                        class="fas fa-copy" aria-hidden="true"></i></button>`;
    }

    stateCell(state) {
        const dot = state === 'running' ? 'ok' : state === 'stopped' ? 'bad' : 'warn';
        const label = state ? state.charAt(0).toUpperCase() + state.slice(1) : '—';
        return `<span class="state"><span class="dot ${dot}"></span>${this.escapeHtml(label)}</span>`;
    }

    ssmCell(item) {
        if (item.state !== 'running') return '<span class="dim">—</span>';

        const map = {
            online:          { dot: 'ok',   label: 'Online' },
            connection_lost: { dot: 'warn', label: 'Connection lost' },
            inactive:        { dot: 'warn', label: 'Inactive' },
            unmanaged:       { dot: 'off',  label: 'Not managed' },
            unknown:         { dot: 'off',  label: 'Unknown' }
        };
        const meta = map[item.ssmStatus || 'unknown'] || map.unknown;

        const details = [];
        if (item.ssmLastPing) details.push(`Last ping ${new Date(item.ssmLastPing).toLocaleString()}`);
        if (item.ssmAgentVersion) details.push(`Agent ${item.ssmAgentVersion}`);
        if (item.ssmStatus === 'unmanaged') details.push('Not registered with Systems Manager');
        if (item.ssmStatus === 'unknown') details.push('ssm:DescribeInstanceInformation permission may be missing');

        return `<span class="state" title="${this.escapeHtml(details.join(' · ') || meta.label)}">
                    <span class="dot ${meta.dot}"></span>${meta.label}
                </span>`;
    }

    ssmBlockReason(status) {
        switch (status) {
            case 'unmanaged':
                return 'Not registered with Systems Manager. Check the SSM agent and the instance IAM role.';
            case 'connection_lost':
                return 'The SSM agent is registered but not responding.';
            case 'inactive':
                return 'The SSM agent is inactive on this instance.';
            default:
                return 'Systems Manager cannot reach this instance.';
        }
    }

    runAction(action, item) {
        const name = item.instanceName || item.instanceId;
        if (action === 'ssm') this.connectSsm(item.instanceId, name);
        if (action === 'rdp') this.connectRdp(item.instanceId, name);
        if (action === 'port') this.openPortDialog(item.instanceId, name);
        if (action === 'via') this.openHopDialog(item);
    }

    // ==========================================================================
    // DETAIL PANEL
    // ==========================================================================

    selectInstance(instanceId) {
        this.selectedInstanceId = instanceId;
        this.renderInstances();
        this.renderDetail(this.instances.find(i => i.instanceId === instanceId) || null);
    }

    renderDetail(item) {
        const panel = document.getElementById('detailPanel');
        const split = document.getElementById('instancesSplit');

        if (!item) {
            panel.style.display = 'none';
            split.classList.add('no-detail');
            return;
        }

        panel.style.display = 'flex';
        split.classList.remove('no-detail');

        document.getElementById('detailTitle').textContent = item.instanceName || item.instanceId;
        document.getElementById('detailId').textContent = item.instanceId;

        const running = item.state === 'running';
        const isWindows = (item.platform || '').toLowerCase().includes('windows');
        const connectable = running && (item.ssmStatus === 'online' || item.ssmStatus === 'unknown');

        const rows = (pairs) => pairs.map(([k, v]) =>
            `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`).join('');

        document.getElementById('detailBody').innerHTML = `
            <div class="detail-group">Status</div>
            <dl>${rows([
                ['State', this.stateCell(item.state)],
                ['SSM agent', this.ssmCell(item)],
                ['Last ping', item.ssmLastPing
                    ? `<span class="muted">${this.escapeHtml(new Date(item.ssmLastPing).toLocaleString())}</span>`
                    : '<span class="dim">—</span>'],
                ['Agent', item.ssmAgentVersion
                    ? `<span class="mono">${this.escapeHtml(item.ssmAgentVersion)}</span>`
                    : '<span class="dim">—</span>']
            ])}</dl>

            <div class="detail-group">Placement</div>
            <dl>${rows([
                ['Type', this.escapeHtml(item.instanceType || '—')],
                ['Zone', `<span class="mono">${this.escapeHtml(item.availabilityZone || '—')}</span>`],
                ['VPC', `<span class="mono">${this.escapeHtml(item.vpcId || '—')}</span>`],
                ['Private IP', `<span class="mono">${this.escapeHtml(item.privateIp || '—')}</span>`],
                ['Public IP', item.publicIp
                    ? `<span class="mono">${this.escapeHtml(item.publicIp)}</span>`
                    : '<span class="dim">none</span>'],
                ['Platform', this.escapeHtml(item.platform || '—')],
                // The name the instance was launched with. Portus never uses a
                // key to connect; this is here because it identifies the
                // instance's origin, not because anything needs it.
                ['Key pair', item.keyName
                    ? `<span class="mono">${this.escapeHtml(item.keyName)}</span>`
                    : '<span class="dim">none</span>']
            ])}</dl>

            ${item.tags && item.tags.length ? `
                <div class="detail-group">Tags</div>
                <div>${item.tags.map(tag =>
                    `<span class="tag">${this.escapeHtml(tag.key)}: ${this.escapeHtml(tag.value)}</span>`).join('')}
                </div>` : ''}
        `;

        const actions = document.getElementById('detailActions');
        actions.innerHTML = connectable
            ? `<button class="btn btn-primary btn-sm" data-action="ssm"><i class="fas fa-terminal"></i> SSM</button>
               ${isWindows ? '<button class="btn btn-sm" data-action="rdp"><i class="fas fa-desktop"></i> RDP</button>' : ''}
               <button class="btn btn-sm" data-action="port"><i class="fas fa-right-left"></i> Port</button>`
            : `<button class="btn btn-sm" disabled>${running ? 'Not reachable via SSM' : 'Instance stopped'}</button>`;

        actions.querySelectorAll('button[data-action]').forEach(button => {
            button.addEventListener('click', () => this.runAction(button.dataset.action, item));
        });
    }

    // ==========================================================================
    // CONNECT ACTIONS
    // ==========================================================================

    async connectSsm(instanceId, name) {
        this.toast(`Opening SSM session to ${name}…`, 'info');
        try {
            const result = await window.electronAPI.connectSSM(this.currentProfile, instanceId, this.currentRegion);
            if (result && result.success) this.toast(`SSM session started for ${name}`, 'success');
            else throw new Error(result?.error || 'Failed to start SSM session');
        } catch (error) {
            this.toast(`${name}: ${error.error || error.message}`, 'error');
        }
    }

    // Which of the loaded instances could carry traffic to this one.
    //
    // Same subnet first, since nothing has to route between them, then the rest
    // of the VPC. Instances in another VPC are left out entirely: without peering
    // they cannot reach the address, and offering one would only buy a tunnel
    // that times out two minutes later.
    hopCandidatesFor(item) {
        if (!item.vpcId) return [];

        return this.instances
            .filter(candidate =>
                candidate.instanceId !== item.instanceId &&
                candidate.state === 'running' &&
                (candidate.ssmStatus === 'online' || candidate.ssmStatus === 'unknown') &&
                candidate.vpcId === item.vpcId)
            .map(candidate => ({
                ...candidate,
                sameSubnet: !!(item.subnetId && candidate.subnetId === item.subnetId)
            }))
            .sort((a, b) => (Number(b.sameSubnet) - Number(a.sameSubnet))
                || String(a.instanceName || a.instanceId)
                    .localeCompare(String(b.instanceName || b.instanceId)));
    }

    // Reaching an instance that has no SSM agent, through one that has.
    //
    // Nothing new happens underneath: the tunnel is the same
    // StartPortForwardingSessionToRemoteHost a database forward already uses,
    // with this instance's private address as the far end. The only real
    // question is which managed instance carries it, so that is what the dialog
    // asks — preselected, because the answer is usually obvious.
    openHopDialog(item) {
        const name = item.instanceName || item.instanceId;
        const isWindows = (item.platform || '').toLowerCase().includes('windows');
        const hops = this.hopCandidatesFor(item);

        if (!hops.length) {
            this.toast(`No SSM-managed instance is running in ${item.vpcId || 'this VPC'} to reach ${name} through`, 'warning');
            return;
        }
        if (!item.privateIp) {
            this.toast(`${name} has no private IP address to connect to`, 'warning');
            return;
        }

        const defaultPort = isWindows ? 3389 : 22;

        const overlay = document.createElement('div');
        overlay.className = 'overlay';
        overlay.innerHTML = `
            <div class="dialog port-dialog">
                <div class="dialog-head">
                    <h3>Access ${this.escapeHtml(name)}</h3>
                    <button type="button" class="icon-btn" data-close><i class="fas fa-times"></i></button>
                </div>
                <div class="dialog-body">
                    <p class="dialog-note">
                        ${this.escapeHtml(name)} is not registered with Systems Manager, so Portus
                        reaches it through an instance that is — nothing is installed on
                        ${this.escapeHtml(name)} itself.
                    </p>

                    <div class="field">
                        <label class="field-label">Through</label>
                        <select class="input" id="hopPick">
                            ${hops.map((hop, index) => `
                                <option value="${this.escapeHtml(hop.instanceId)}"${index === 0 ? ' selected' : ''}>
                                    ${this.escapeHtml(hop.instanceName || hop.instanceId)} · ${this.escapeHtml(hop.instanceId)}${hop.sameSubnet ? ' · same subnet' : ''}
                                </option>`).join('')}
                        </select>
                    </div>

                    <div class="field">
                        <label class="field-label">Connect to</label>
                        <div class="seg" id="hopMode">
                            ${isWindows ? '<button type="button" class="on" data-mode="rdp">Remote Desktop</button>' : ''}
                            <button type="button"${isWindows ? '' : ' class="on"'} data-mode="port">Forward a port</button>
                        </div>
                    </div>

                    <div class="field" id="hopPortField"${isWindows ? ' style="display:none;"' : ''}>
                        <label class="field-label">Port on ${this.escapeHtml(name)}</label>
                        <input class="input mono" id="hopPort" value="${defaultPort}" spellcheck="false" autocomplete="off">
                        <p class="dialog-note" id="hopPortHint"></p>
                    </div>
                </div>
                <div class="dialog-foot">
                    <button type="button" class="btn" data-close>Cancel</button>
                    <button type="button" class="btn btn-primary" id="hopStart">
                        <i class="fas fa-right-left"></i> Connect
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        const portField = overlay.querySelector('#hopPortField');
        const portInput = overlay.querySelector('#hopPort');
        const hint = overlay.querySelector('#hopPortHint');
        const start = overlay.querySelector('#hopStart');
        const mode = () => overlay.querySelector('#hopMode button.on').dataset.mode;

        // A forwarded port is only useful if you know what to point at it, and on
        // Linux that is nearly always ssh — which Portus deliberately does not run
        // for you, since it would mean handling your keys.
        const describePort = () => {
            const port = portInput.value.trim();
            hint.textContent = port === '22'
                ? 'Portus opens the tunnel; connect with your own ssh client once it is up.'
                : '';
        };

        overlay.querySelectorAll('#hopMode button').forEach(button => {
            button.addEventListener('click', () => {
                overlay.querySelectorAll('#hopMode button').forEach(b => b.classList.remove('on'));
                button.classList.add('on');
                portField.style.display = button.dataset.mode === 'port' ? '' : 'none';
            });
        });

        portInput.addEventListener('input', describePort);
        describePort();

        start.addEventListener('click', async () => {
            const hopId = overlay.querySelector('#hopPick').value;
            const hop = hops.find(candidate => candidate.instanceId === hopId);
            if (!hop) { this.toast('Pick an instance to connect through', 'warning'); return; }

            const viaName = hop.instanceName || hop.instanceId;

            start.disabled = true;
            start.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Connecting…';

            let result;
            if (mode() === 'rdp') {
                result = await this.connectRdp(item.instanceId, name, {
                    via: { instanceId: hop.instanceId, instanceName: viaName, targetHost: item.privateIp }
                });
            } else {
                const port = portInput.value.trim();
                if (!port) {
                    this.toast('Enter the port to reach on ' + name, 'warning');
                    start.disabled = false;
                    start.innerHTML = '<i class="fas fa-right-left"></i> Connect';
                    portInput.focus();
                    return;
                }

                // The tunnel runs on the hop and the far end is the target's own
                // address, which is exactly the shape a database forward has.
                result = await this.startPortForward(hop.instanceId, viaName, {
                    remoteHost: item.privateIp,
                    remotePort: port,
                    localPort: '',
                    region: this.currentRegion,
                    target: { instanceId: item.instanceId, instanceName: name }
                });
            }

            if (result && result.success) {
                close();
            } else {
                start.disabled = false;
                start.innerHTML = '<i class="fas fa-right-left"></i> Connect';
            }
        });
    }

    async connectRdp(instanceId, name, options) {
        this.toast(`Establishing RDP tunnel to ${name}…`, 'info');
        try {
            const result = await window.electronAPI.connectRDPSSM(
                this.currentProfile, instanceId, name, this.currentRegion, options);
            if (result && result.success) {
                this.toast(result.reused
                    ? `${name} is already tunnelled on port ${result.port}`
                    : `RDP tunnel open for ${name} on port ${result.port}`,
                    result.reused ? 'info' : 'success');
            } else {
                throw new Error(result?.error || 'Failed to establish RDP tunnel');
            }
            // Returned so a caller that opened a dialog knows whether to close it
            return result;
        } catch (error) {
            this.toast(`${name}: ${error.error || error.message}`, 'error');
            return { success: false };
        }
    }

    openPortDialog(instanceId, name) {
        const presets = [
            { label: 'Oracle', port: 1521, service: 'oracle' },
            { label: 'SQL Server', port: 1433, service: 'sqlserver' },
            { label: 'PostgreSQL', port: 5432, service: 'postgresql' },
            { label: 'MySQL', port: 3306, service: 'mysql' },
            { label: 'Redis', port: 6379, service: 'redis' },
            // Labelled EKS because that is what it finds. The key stays
            // 'kubernetes' — it is what endpoint discovery tags clusters with,
            // and renaming it would mean renaming the engine mapping too.
            { label: 'EKS', port: 443, service: 'kubernetes' }
        ];

        const overlay = document.createElement('div');
        overlay.className = 'overlay';
        overlay.innerHTML = `
            <div class="dialog wide port-dialog">
                <div class="dialog-head">
                    <h3>Forward a port</h3>
                    <button type="button" class="icon-btn" data-close><i class="fas fa-times"></i></button>
                </div>
                <div class="dialog-body">
                    <p class="dialog-note">
                        Tunnelling through <strong>${this.escapeHtml(name)}</strong>
                        · <span class="mono">${this.escapeHtml(instanceId)}</span>
                    </p>

                    <div class="field">
                        <label class="field-label">Target</label>
                        <div class="seg" id="pfTarget">
                            <button type="button" class="on" data-target="local">This instance</button>
                            <button type="button" data-target="remote">A host reachable from it</button>
                        </div>
                    </div>

                    <div class="field">
                        <label class="field-label">Service</label>
                        <div class="chips" id="pfChips">
                            ${presets.map(p => `<button type="button" class="chip" data-port="${p.port}" data-service="${p.service}">${p.label}</button>`).join('')}
                        </div>
                    </div>

                    <div class="field" id="pfClusterField" style="display:none;">
                        <label class="field-label">Look in account</label>
                        <div class="cluster-source">
                            <select class="input" id="pfClusterProfile">
                                ${(this.profiles || []).map(p => `
                                    <option value="${this.escapeHtml(p.name)}"${p.name === this.currentProfile ? ' selected' : ''}>${this.escapeHtml(p.name)}</option>`).join('')}
                            </select>
                            <input class="input mono" id="pfClusterRegion" spellcheck="false" autocomplete="off"
                                   value="${this.escapeHtml(this.currentRegion || '')}"
                                   placeholder="the profile's own region">
                        </div>
                        <p class="dialog-note" id="pfClusterNote"></p>
                    </div>

                    <div class="field" id="pfHostField" style="display:none;">
                        <label class="field-label">Remote host</label>
                        <div class="host-combo" id="pfHostCombo">
                            <input class="input mono" id="pfHost" spellcheck="false" autocomplete="off"
                                   role="combobox" aria-expanded="false" aria-autocomplete="list"
                                   placeholder="Pick a discovered endpoint, or type any host">
                            <button type="button" class="host-combo-toggle" id="pfHostBrowse"
                                    tabindex="-1" aria-label="Browse discovered endpoints">
                                <i class="fas fa-chevron-down"></i>
                            </button>
                            <div class="combo-panel host-panel" id="pfHostPanel">
                                <div class="combo-list" id="pfHostList" role="listbox"></div>
                                <div class="combo-foot">
                                    <button type="button" class="link-btn" id="pfHostRefresh" tabindex="-1">
                                        <i class="fas fa-rotate"></i> Refresh
                                    </button>
                                    <span id="pfHostFoot"></span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="field-row">
                        <div class="field">
                            <label class="field-label">Remote port</label>
                            <input class="input mono" id="pfRemote" inputmode="numeric" placeholder="e.g. 1521">
                        </div>
                        <div class="field">
                            <label class="field-label">Local port</label>
                            <input class="input mono" id="pfLocal" inputmode="numeric" placeholder="Auto">
                        </div>
                    </div>

                    <div class="hint">
                        <i class="fas fa-shield-halved"></i>
                        <span>Traffic leaves through the SSM agent. No inbound security-group rule,
                              no public IP, and the session is recorded in CloudTrail.</span>
                    </div>
                </div>
                <div class="dialog-foot">
                    <button type="button" class="btn" data-close>Cancel</button>
                    <button type="button" class="btn btn-primary" id="pfStart">
                        <i class="fas fa-right-left"></i> Start forwarding
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        const hostField = overlay.querySelector('#pfHostField');
        const host = overlay.querySelector('#pfHost');
        const remote = overlay.querySelector('#pfRemote');
        const local = overlay.querySelector('#pfLocal');
        const start = overlay.querySelector('#pfStart');

        const combo = overlay.querySelector('#pfHostCombo');
        const panel = overlay.querySelector('#pfHostPanel');
        const list = overlay.querySelector('#pfHostList');
        const foot = overlay.querySelector('#pfHostFoot');

        // Endpoint discovery state, local to this dialog. The fetched list is
        // cached on the instance so reopening the dialog does not re-query AWS.
        let loadState = 'idle';       // idle | loading | ready | error
        let loadError = '';
        // Set when a discovered EKS cluster is picked, cleared the moment the host
        // is edited by hand: a typed host is not the cluster we described.
        let chosenKubernetes = null;

        // Set only when the thing being reached was found in a different account
        // or region from the instance opening the tunnel; null means this one,
        // and the single account case behaves exactly as before.
        //
        // What it is used for differs by service, and the difference is worth
        // keeping straight. For a database or a cache it is discovery alone:
        // the tunnel needs a host and a port, and once it is up nothing refers
        // to that account again. For a cluster it outlives discovery — the
        // kubeconfig is written from it and every `aws eks get-token` signs
        // with it.
        let clusterSource = null;
        let endpoints = [];
        let matches = [];
        let activeIndex = -1;
        let panelOpen = false;

        const activeService = () => {
            const chip = overlay.querySelector('.chip.on');
            return chip ? chip.dataset.service : null;
        };

        const openPanel = () => {
            panelOpen = true;
            combo.classList.add('open');
            host.setAttribute('aria-expanded', 'true');
            renderList();
            ensureEndpoints();
        };

        const closePanel = () => {
            panelOpen = false;
            activeIndex = -1;
            combo.classList.remove('open');
            host.setAttribute('aria-expanded', 'false');
        };

        // Fetched on demand rather than on dialog open: forwarding a port on the
        // instance itself never needs this, and it costs four AWS calls.
        const ensureEndpoints = async () => {
            if (loadState === 'loading' || loadState === 'ready') return;

            const cached = clusterSource ? null : this.endpointCache.get(this.endpointCacheKey());
            if (cached) {
                endpoints = cached;
                loadState = 'ready';
                renderList();
                return;
            }

            loadState = 'loading';
            renderList();

            // Another account is listed with that account's credentials. For a
            // cluster that means EKS alone — asking for databases in an account
            // someone picked to find a cluster in is a column of AccessDenied
            // warnings about things they were not looking for.
            const result = clusterSource
                ? (activeService() === 'kubernetes'
                    ? await this.loadClusters(clusterSource.profileName, clusterSource.region)
                    : await this.loadEndpoints(clusterSource.profileName, clusterSource.region))
                : await this.loadEndpoints();
            if (!overlay.isConnected) return;   // dialog closed while in flight

            if (result.success) {
                endpoints = result.data;
                loadState = 'ready';

                // Pin the region the listing actually used, so the kubeconfig is
                // written against the same one the cluster was found in rather
                // than resolving it a second time and possibly differently.
                if (clusterSource && result.region) clusterSource.region = result.region;
            } else {
                loadError = result.error || 'Could not list endpoints';
                loadState = 'error';
            }
            renderList();
        };

        const renderList = () => {
            const term = host.value.trim().toLowerCase();
            const service = activeService();

            // 'idle' only lasts until ensureEndpoints runs; showing the empty
            // state for that frame would read as "nothing found"
            if (loadState === 'idle' || loadState === 'loading') {
                list.innerHTML = '<div class="combo-empty"><i class="fas fa-spinner fa-spin"></i> Discovering endpoints…</div>';
                foot.textContent = '';
                return;
            }

            if (loadState === 'error') {
                list.innerHTML = `<div class="combo-empty">${this.escapeHtml(loadError)}</div>`;
                foot.textContent = 'Type the host manually';
                return;
            }

            matches = endpoints.filter(e => {
                if (service && e.service !== service) return false;
                if (!term) return true;
                return e.name.toLowerCase().includes(term) || e.host.toLowerCase().includes(term);
            });

            if (!endpoints.length) {
                list.innerHTML = clusterSource
                    ? `<div class="combo-empty">No clusters found in ${this.escapeHtml(clusterSource.profileName)}</div>`
                    : '<div class="combo-empty">No databases or caches found in this region</div>';
                foot.textContent = 'Type the host manually';
                return;
            }

            if (!matches.length) {
                list.innerHTML = '<div class="combo-empty">Nothing matches — the typed host will be used as-is</div>';
                foot.textContent = `0 of ${endpoints.length} endpoints`;
                return;
            }

            list.innerHTML = '';
            matches.forEach((endpoint, index) => {
                const option = document.createElement('div');
                option.className = 'combo-option endpoint-option';
                option.setAttribute('role', 'option');
                option.innerHTML = `
                    <div class="opt-main">
                        <span class="opt-name">${this.escapeHtml(endpoint.name)}</span>
                        <span class="opt-host mono">${this.escapeHtml(endpoint.host)}</span>
                    </div>
                    <span class="opt-kind">${this.escapeHtml(endpoint.kind)}</span>
                    <span class="opt-port mono">${this.escapeHtml(endpoint.port ?? '')}</span>
                `;
                option.addEventListener('mousedown', (e) => {
                    e.preventDefault();          // keep focus in the input
                    selectEndpoint(endpoint);
                });
                option.addEventListener('mousemove', () => setActive(index));
                list.appendChild(option);
            });

            foot.textContent = service || term
                ? `${matches.length} of ${endpoints.length} endpoints`
                : `${endpoints.length} endpoints`;

            setActive(matches.length ? 0 : -1);
        };

        const setActive = (index) => {
            const options = list.querySelectorAll('.combo-option');
            options.forEach(o => o.classList.remove('active'));
            activeIndex = index;
            if (index >= 0 && options[index]) {
                options[index].classList.add('active');
                options[index].scrollIntoView({ block: 'nearest' });
            }
        };

        const selectEndpoint = (endpoint) => {
            host.value = endpoint.host;

            // The cluster carries the account it was listed from, so the
            // kubeconfig is written and tokened against that one rather than
            // against whichever profile happens to own the instance.
            chosenKubernetes = endpoint.kubernetes
                ? { ...endpoint.kubernetes, ...(clusterSource || {}) }
                : null;

            // The port the API reported wins over the service preset — a database
            // on a non-standard port is otherwise silently wrong.
            if (endpoint.port) {
                remote.value = String(endpoint.port);
                syncChips();
            }

            // Encrypted Redis presents a certificate for its real hostname, which
            // will not match the localhost the client connects to. A cluster has
            // the same mismatch and no such problem: the generated kubeconfig
            // sets tls-server-name, so verification stays on and stays correct.
            if (endpoint.tls && !endpoint.kubernetes) {
                this.toast(`${endpoint.name} has encryption in transit — your client must skip hostname verification`, 'info');
            }

            closePanel();
            local.focus();
        };

        const syncChips = () => {
            overlay.querySelectorAll('.chip').forEach(chip =>
                chip.classList.toggle('on', chip.dataset.port === remote.value.trim()));
        };

        overlay.querySelectorAll('#pfTarget button').forEach(btn => {
            btn.addEventListener('click', () => {
                overlay.querySelectorAll('#pfTarget button').forEach(b => b.classList.remove('on'));
                btn.classList.add('on');
                const isRemote = btn.dataset.target === 'remote';
                hostField.style.display = isRemote ? 'block' : 'none';
                // Only a remote target can be in another account — forwarding a
                // port on the instance itself has no endpoint to look up.
                clusterField.style.display = isRemote ? 'block' : 'none';
                renderAccountNote();
                // openPanel explicitly rather than relying on the focus handler:
                // focus() is a no-op when the window itself is not focused, and
                // the panel would then render its contents but stay closed
                if (isRemote) { host.focus(); openPanel(); }
                else closePanel();
            });
        });

        overlay.querySelector('#pfHostBrowse').addEventListener('mousedown', (e) => {
            e.preventDefault();
            if (panelOpen) { closePanel(); return; }
            host.focus();
            openPanel();
        });

        // A database created since the list was cached would otherwise need an
        // app restart to show up
        overlay.querySelector('#pfHostRefresh').addEventListener('mousedown', (e) => {
            e.preventDefault();
            this.endpointCache.delete(this.endpointCacheKey());
            endpoints = [];
            loadState = 'idle';
            if (!panelOpen) openPanel(); else { renderList(); ensureEndpoints(); }
        });

        host.addEventListener('focus', () => openPanel());
        host.addEventListener('input', () => {
            // Typing means the host is no longer the cluster that was picked, so
            // no kubeconfig should be written for whatever it is now.
            chosenKubernetes = null;
            if (!panelOpen) openPanel(); else renderList();
        });
        host.addEventListener('blur', () => closePanel());

        host.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && panelOpen) { e.stopPropagation(); closePanel(); return; }
            if (!panelOpen || !matches.length) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((activeIndex + 1) % matches.length);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((activeIndex - 1 + matches.length) % matches.length);
            } else if (e.key === 'Enter' && activeIndex >= 0) {
                e.preventDefault();
                selectEndpoint(matches[activeIndex]);
            }
        });

        // The account row applies to anything reachable through the instance,
        // and only changes behaviour when it names something other than this
        // account.
        const clusterField = overlay.querySelector('#pfClusterField');
        const clusterProfile = overlay.querySelector('#pfClusterProfile');
        const clusterRegion = overlay.querySelector('#pfClusterRegion');
        const clusterNote = overlay.querySelector('#pfClusterNote');

        // What the chosen account is actually used for is not the same for a
        // cluster as for a database, and saying so is the difference between a
        // field people understand and one they guess at.
        const renderAccountNote = () => {
            clusterNote.textContent = activeService() === 'kubernetes'
                ? 'The cluster can be in a different account from the instance reaching it. The tunnel stays on this instance; the kubeconfig and eks get-token use the account chosen here.'
                : 'Lists endpoints from another account, for something this instance can reach over peering. Only used to find the address — the tunnel itself is unchanged.';
        };

        const syncClusterSource = () => {
            const name = clusterProfile.value;
            const regionValue = clusterRegion.value.trim();
            const isOtherAccount = name !== this.currentProfile
                || (regionValue && regionValue !== this.currentRegion);

            clusterSource = isOtherAccount
                ? { profileName: name, region: regionValue || null }
                : null;

            // The list came from somewhere else, so it has to be fetched again
            endpoints = [];
            chosenKubernetes = null;
            loadState = 'idle';
            ensureEndpoints();
        };

        clusterProfile.addEventListener('change', () => {
            // The region box starts on this instance's region, which is the
            // wrong default the moment the account changes — a cluster in
            // eu-west-1 would be looked for in eu-central-1 and simply not
            // found. Blank means "that profile's own region", which is the
            // right guess, and it stays editable.
            clusterRegion.value = clusterProfile.value === this.currentProfile
                ? (this.currentRegion || '')
                : '';
            syncClusterSource();
        });
        clusterRegion.addEventListener('change', syncClusterSource);

        overlay.querySelectorAll('.chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const wasOn = chip.classList.contains('on');
                overlay.querySelectorAll('.chip').forEach(c => c.classList.remove('on'));
                if (!wasOn) {
                    chip.classList.add('on');
                    remote.value = chip.dataset.port;
                }

                renderAccountNote();

                // Clusters and databases are listed by different calls, so a
                // list fetched from another account for one service cannot be
                // filtered into the other. Switching service refetches.
                if (clusterSource) {
                    endpoints = [];
                    chosenKubernetes = null;
                    loadState = 'idle';
                    ensureEndpoints();
                    return;
                }

                renderList();   // the chip is also the endpoint filter
            });
        });
        remote.addEventListener('input', () => {
            syncChips();
            renderList();
        });

        start.addEventListener('click', async () => {
            const isRemote = overlay.querySelector('#pfTarget button.on').dataset.target === 'remote';
            const remoteHost = isRemote ? host.value.trim() : '';

            if (isRemote && !remoteHost) { this.toast('Enter the remote host', 'warning'); host.focus(); return; }
            if (!remote.value.trim()) { this.toast('Enter the remote port', 'warning'); remote.focus(); return; }

            start.disabled = true;
            start.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting…';

            const result = await this.startPortForward(instanceId, name, {
                remoteHost, remotePort: remote.value.trim(), localPort: local.value.trim(),
                region: this.currentRegion,
                ...(chosenKubernetes ? { kubernetes: chosenKubernetes } : {})
            });

            if (result && result.success) {
                close();
            } else {
                start.disabled = false;
                start.innerHTML = '<i class="fas fa-right-left"></i> Start forwarding';
            }
        });

        setTimeout(() => remote.focus(), 50);
    }

    // Managed database and cache endpoints in the profile's region. Failure is
    // returned rather than thrown: the dialog degrades to a plain text field,
    // which is exactly how it worked before this existed.
    // Clusters belonging to another account, listed with that account's own
    // credentials. Not cached: it is asked for only when someone opens the
    // picker and changes the account, and a stale list there is worse than a
    // second call.
    async loadClusters(profileName, region) {
        if (!profileName) return { success: false, error: 'No profile selected for the cluster' };

        this.setBusy(true);
        try {
            const result = await window.electronAPI.listClusters(profileName, region || undefined);

            if (result && result.success) {
                if (result.warnings && result.warnings.length) {
                    this.toast(`Some clusters could not be listed: ${result.warnings.join('; ')}`, 'warning');
                }
                return { success: true, data: result.data || [], region: result.region || null };
            }
            return { success: false, error: result?.error || `Could not list clusters in ${profileName}` };
        } catch (error) {
            return { success: false, error: error.message || 'Could not list clusters' };
        } finally {
            this.setBusy(false);
        }
    }

    // Defaults to the selected profile and region. Another account is passed
    // explicitly, for a database or cache that lives there — the instance can
    // reach it over peering, but only that account can say what its endpoint is.
    async loadEndpoints(profileName = this.currentProfile, region = this.currentRegion) {
        if (!profileName) return { success: false, error: 'No profile selected' };

        const isCurrent = profileName === this.currentProfile;

        this.setBusy(true);
        try {
            const result = await window.electronAPI.getEndpoints(profileName, region);

            if (result && result.success) {
                // A silent re-auth says something about the session being used
                // for the UI. Another account's listing says nothing about it.
                if (result.reauthenticated && isCurrent) {
                    this.isLoggedIn = true;
                    this.updateConnection(true, this.selectedAuthProfile);
                    this.startSessionWatcher();
                }

                const data = result.data || [];
                // Keyed by what was actually asked, not by what is selected.
                // Keying another account's endpoints under the current profile
                // would hand them back as this account's the next time the
                // dialog opened.
                this.endpointCache.set(this.endpointCacheKey(profileName, result.region || region), data);

                // A permission gap on one service still leaves the others usable,
                // so this is a note rather than a failure.
                if (result.warnings && result.warnings.length) {
                    this.toast(`Some endpoints could not be listed: ${result.warnings.join('; ')}`, 'warning');
                }
                return { success: true, data, region: result.region || null };
            }

            // Only the session the UI runs on can expire out from under it.
            // Another account failing says nothing about this one.
            if (result && result.sessionExpired && isCurrent) {
                this.handleSessionExpired(result.error);
                return { success: false, error: result.error };
            }
            return { success: false, error: result?.error || 'Could not list endpoints' };
        } catch (error) {
            return { success: false, error: error.message || 'Could not list endpoints' };
        } finally {
            this.setBusy(false);
        }
    }

    async startPortForward(instanceId, name, options) {
        try {
            const result = await window.electronAPI.startPortForward(
                this.currentProfile, instanceId, name, options);

            if (result && result.success) {
                this.toast(result.reused
                    ? `Already forwarding on localhost:${result.port}`
                    : `Forwarding localhost:${result.port} → ${options.remoteHost || name}:${options.remotePort}`,
                    result.reused ? 'info' : 'success');
            } else {
                this.toast(result?.error || 'Could not start port forwarding', 'error');
            }
            return result;
        } catch (error) {
            this.toast(`Port forwarding failed: ${error.message}`, 'error');
            return { success: false };
        }
    }

    // ==========================================================================
    // TUNNELS
    // ==========================================================================

    bindTunnelEvents() {
        window.electronAPI.onTunnelsChanged(tunnels => this.renderTunnels(tunnels));
        window.electronAPI.listTunnels().then(t => this.renderTunnels(t)).catch(() => {});
    }

    // Uptime is shown to the second, so it has to be redrawn every second or the
    // column reads as frozen. Only the text of each cell is rewritten: rebuilding
    // the table on a timer would drop a click landing mid-redraw, which is what
    // the old 30-second full re-render did between its long stale gaps.
    syncUptimeTicker() {
        const wanted = this.view === 'tunnels' && this.tunnels.length > 0;

        if (wanted && !this.uptimeTicker) {
            this.uptimeTicker = setInterval(() => this.tickUptime(), 1000);
        } else if (!wanted && this.uptimeTicker) {
            clearInterval(this.uptimeTicker);
            this.uptimeTicker = null;
        }
    }

    tickUptime() {
        if (this.view !== 'tunnels' || !this.tunnels.length) { this.syncUptimeTicker(); return; }

        document.querySelectorAll('#tunnelTableWrap [data-started-at]').forEach(cell => {
            cell.textContent = this.uptime(Number(cell.dataset.startedAt));
        });
    }

    // ==========================================================================
    // EKS
    // ==========================================================================

    // Which instances could carry traffic to this cluster.
    //
    // The same rule the Access via… picker uses, pointed at a cluster's VPC
    // instead of an instance's: an instance has to be in that VPC to reach a
    // private API endpoint at all, and one in the same subnet needs nothing
    // routed between them.
    hopsForCluster(cluster) {
        if (!cluster) return [];

        const managed = this.instances.filter(candidate =>
            candidate.state === 'running' &&
            (candidate.ssmStatus === 'online' || candidate.ssmStatus === 'unknown'));

        const inVpc = cluster.vpcId
            ? managed.filter(candidate => candidate.vpcId === cluster.vpcId)
            : [];

        // Being in the cluster's VPC is proof of reachability, so when anything
        // is, those are the only candidates worth offering.
        //
        // When nothing is, that is not the same as no route. A cluster in
        // another account is reached over peering or a transit gateway, so the
        // instance carrying it is in a different VPC by definition — and that
        // is the case this tab exists to make easy. Every managed instance is
        // offered instead: Portus cannot prove any of them reach it, and
        // refusing to try would be wrong more often than guessing.
        const candidates = inVpc.length ? inVpc : managed;
        const verified = inVpc.length > 0;

        return candidates
            .map(candidate => ({
                ...candidate,
                verified,
                // A node of this cluster is the safest hop there is: in the
                // right VPC by definition, and already talking to the API.
                isClusterNode: (candidate.tags || []).some(tag =>
                    tag.key === 'eks:cluster-name' && tag.value === cluster.name)
            }))
            .sort((a, b) => (Number(b.isClusterNode) - Number(a.isClusterNode))
                || String(a.instanceName || a.instanceId)
                    .localeCompare(String(b.instanceName || b.instanceId)));
    }

    // The hop a Connect would use: whatever was chosen for this cluster, or the
    // best candidate.
    hopForCluster(cluster) {
        const candidates = this.hopsForCluster(cluster);
        if (!candidates.length) return null;

        const chosen = this.hopOverrides.get(cluster.name);
        return candidates.find(candidate => candidate.instanceId === chosen) || candidates[0];
    }

    // The instances that are nodes of this cluster.
    //
    // Matched on the tag EKS puts on managed node groups. It is the only signal
    // available without talking to the Kubernetes API, and it is not complete:
    // self-managed nodes often carry nothing, and other provisioners use their
    // own tags. So this is "nodes Portus can see", never a count to rely on.
    nodesForCluster(cluster) {
        if (!cluster) return [];

        return this.instances
            .filter(item => (item.tags || []).some(tag =>
                tag.key === 'eks:cluster-name' && tag.value === cluster.name))
            .sort((a, b) => String(a.instanceName || a.instanceId)
                .localeCompare(String(b.instanceName || b.instanceId)));
    }

    // Nodes live in the cluster's account. When the tab is pointed somewhere
    // other than the sidebar, the instance list is the wrong account's and
    // there is nothing honest to show.
    nodesAreVisible() {
        return this.clusterSource().profileName === this.currentProfile;
    }

    // An open tunnel to this cluster, if there is one
    tunnelForCluster(cluster) {
        return (this.tunnels || []).find(tunnel =>
            tunnel.kubernetes && tunnel.kubernetes.clusterName === cluster.name) || null;
    }

    // A different account or region means a different set of clusters, and the
    // hop candidates are drawn from an instance list that is also about to be
    // replaced. Listed again when the tab is next opened rather than eagerly —
    // most sessions never go there.
    forgetClusters() {
        this.clusters = [];
        this.clustersLoaded = false;
        this.clusterError = null;
        this.clusterRegion = null;
        this.hopOverrides.clear();
        this.selectedClusterName = null;
        this.renderClusterDetail(null);

        const picker = document.getElementById('eksProfile');
        const region = document.getElementById('eksRegion');
        if (picker) picker.value = this.currentProfile || '';
        // Emptied rather than refilled: the account just changed, and the
        // regions are fetched again when the tab is next drawn. Leaving the old
        // account's list in place would offer regions these credentials may not
        // have enabled.
        if (region) region.innerHTML = '';

        this.renderClusters();
        if (this.view === 'eks') this.loadClusterView();
    }

    clusterSource() {
        const profileName = (document.getElementById('eksProfile') || {}).value || this.currentProfile;
        const region = ((document.getElementById('eksRegion') || {}).value || '').trim();
        return { profileName, region: region || null };
    }

    async loadClusterView() {
        if (!this.currentProfile) return;

        const select = document.getElementById('eksRegion');
        // Filled on the first visit, and whenever the account changed while the
        // tab was not on screen. Keeps whatever region is already chosen.
        if (select && !select.options.length) {
            await this.renderEksRegions(this.clusterSource().profileName, select.value || null);
        }

        const { profileName, region } = this.clusterSource();
        this.clustersLoaded = true;
        this.clusterError = null;
        this.renderClusters('loading');

        const result = await this.loadClusters(profileName, region);

        if (result.success) {
            this.clusters = result.data || [];
            // Pin what the listing actually used, so Connect writes the
            // kubeconfig against the same region the cluster was found in
            this.clusterRegion = result.region || region || null;
        } else {
            this.clusters = [];
            this.clusterError = result.error;
        }

        this.renderClusters();
    }

    renderClusters(state) {
        const wrap = document.getElementById('clusterTableWrap');
        const count = document.getElementById('clusterCount');
        if (!wrap) return;

        document.getElementById('navClusterCount').textContent = this.clusters.length;
        count.textContent = this.clusters.length ? `${this.clusters.length} clusters` : '';

        if (state === 'loading') {
            wrap.innerHTML = '<div class="empty"><i class="fas fa-spinner fa-spin"></i><p>Listing clusters…</p></div>';
            return;
        }

        if (this.clusterError) {
            wrap.innerHTML = `<div class="empty"><i class="fas fa-triangle-exclamation"></i><p>${this.escapeHtml(this.clusterError)}</p></div>`;
            return;
        }

        if (!this.clusters.length) {
            wrap.innerHTML = `
                <div class="empty">
                    <i class="fas fa-dharmachakra"></i>
                    <p>No clusters in this account and region.</p>
                </div>`;
            return;
        }

        const table = document.createElement('table');
        table.innerHTML = `
            <thead><tr>
                <th>Name</th><th>Version</th><th>Support</th><th>Status</th>
                <th>Endpoint</th><th>Through</th><th>Actions</th>
            </tr></thead>
        `;
        const tbody = document.createElement('tbody');

        this.clusters.forEach(cluster => tbody.appendChild(this.buildClusterRow(cluster)));
        table.appendChild(tbody);

        wrap.innerHTML = '';
        wrap.appendChild(table);
    }

    buildClusterRow(cluster) {
        const row = document.createElement('tr');
        const tunnel = this.tunnelForCluster(cluster);
        const hops = this.hopsForCluster(cluster);
        const hop = this.hopForCluster(cluster);
        const active = (cluster.status || '').toUpperCase() === 'ACTIVE';

        // A cluster reachable from the internet does not need any of this, and
        // offering a tunnel anyway would be answering a question nobody asked.
        const publicOnly = cluster.endpointPublicAccess && !cluster.endpointPrivateAccess;

        let endpoint;
        if (publicOnly) endpoint = '<span class="muted">Public</span>';
        else if (cluster.endpointPublicAccess) endpoint = '<span class="muted">Public + private</span>';
        else endpoint = '<span class="mono">Private</span>';

        let through;
        if (publicOnly) {
            through = '<span class="dim">not needed</span>';
        } else if (!cluster.vpcId) {
            through = '<span class="dim">unknown VPC</span>';
        } else if (!hops.length) {
            through = '<span class="dim">no managed instance to reach it</span>';
        } else {
            // Unverified means nothing sits in the cluster's VPC, so these are
            // candidates rather than known routes — true of a cluster reached
            // across an account boundary. Saying so beats a confident-looking
            // pick that times out.
            const note = hop.verified ? '' :
                '<span class="dim" title="Nothing is in the cluster\'s VPC, so reachability cannot be checked — this is usually right for a peered or cross-account cluster"> · unverified</span>';

            through = `
                <select class="input input-sm" data-hop>
                    ${hops.map(candidate => `
                        <option value="${this.escapeHtml(candidate.instanceId)}"${candidate.instanceId === hop.instanceId ? ' selected' : ''}>
                            ${this.escapeHtml(candidate.instanceName || candidate.instanceId)}${candidate.isClusterNode ? ' · node' : ''}
                        </option>`).join('')}
                </select>${note}`;
        }

        let actions;
        if (tunnel) {
            actions = `
                <button class="act primary" data-kubectl>kubectl</button>
                <button class="act" data-disconnect>Disconnect</button>`;
        } else if (publicOnly) {
            actions = '<button class="act" disabled title="This cluster answers on the public internet — point kubectl at it directly">No tunnel needed</button>';
        } else if (!hops.length) {
            actions = '<button class="act" disabled title="No running SSM-managed instance to reach it through">No route</button>';
        } else if (!active) {
            actions = `<button class="act" disabled title="The cluster is ${this.escapeHtml(cluster.status || 'not active')}">Unavailable</button>`;
        } else {
            actions = '<button class="act primary" data-connect>Connect</button>';
        }

        row.innerHTML = `
            <td class="name-cell">${this.copyableCell(cluster.name)}</td>
            <td class="muted">${this.escapeHtml(cluster.engineVersion || '—')}</td>
            <td>${this.clusterSupportCell(cluster)}</td>
            <td>${this.clusterStateCell(cluster.status)}</td>
            <td>${endpoint}</td>
            <td>${through}</td>
            <td class="actions"><div class="row-actions">${actions}</div></td>
        `;

        if (cluster.name === this.selectedClusterName) row.classList.add('selected');
        row.addEventListener('click', () => this.selectCluster(cluster.name));

        const hopPicker = row.querySelector('[data-hop]');
        if (hopPicker) {
            hopPicker.addEventListener('change', () => {
                this.hopOverrides.set(cluster.name, hopPicker.value);
            });
            // Choosing a hop is not choosing the row; without this the panel
            // opens underneath every time the dropdown is touched.
            hopPicker.addEventListener('click', (e) => e.stopPropagation());
        }

        // Acting on a row is not selecting it, the same as the instance list
        const connect = row.querySelector('[data-connect]');
        if (connect) {
            connect.addEventListener('click', (e) => {
                e.stopPropagation();
                this.connectCluster(cluster, connect);
            });
        }

        const kubectl = row.querySelector('[data-kubectl]');
        if (kubectl) {
            kubectl.addEventListener('click', async (e) => {
                e.stopPropagation();
                const open = this.tunnelForCluster(cluster);
                if (open) await this.openKubectl(open.id);
            });
        }

        const disconnect = row.querySelector('[data-disconnect]');
        if (disconnect) {
            disconnect.addEventListener('click', async (e) => {
                e.stopPropagation();
                const open = this.tunnelForCluster(cluster);
                if (open) await this.closeTunnel(open.id, cluster.name);
            });
        }

        row.querySelectorAll('button[data-copy]').forEach(button => {
            button.addEventListener('click', (e) => {
                e.stopPropagation();
                this.copy(button.dataset.copy);
            });
        });

        return row;
    }

    selectCluster(name) {
        this.selectedClusterName = name;
        this.renderClusters();
        this.renderClusterDetail(this.clusters.find(cluster => cluster.name === name) || null);
    }

    clearClusterSelection() {
        if (!this.selectedClusterName) return;
        this.selectedClusterName = null;
        this.renderClusters();
        this.renderClusterDetail(null);
    }

    renderClusterDetail(cluster) {
        const panel = document.getElementById('clusterDetail');
        const split = document.getElementById('clustersSplit');
        if (!panel || !split) return;

        if (!cluster) {
            panel.style.display = 'none';
            split.classList.add('no-detail');
            return;
        }

        panel.style.display = 'flex';
        split.classList.remove('no-detail');

        document.getElementById('clusterDetailTitle').textContent = cluster.name;
        document.getElementById('clusterDetailHost').textContent = cluster.host || '';

        const rows = (pairs) => pairs.map(([k, v]) =>
            `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`).join('');

        const access = cluster.endpointPublicAccess && cluster.endpointPrivateAccess
            ? 'Public and private'
            : (cluster.endpointPublicAccess ? 'Public' : 'Private');

        const nodes = this.nodesForCluster(cluster);
        const visible = this.nodesAreVisible();

        let nodeSection;
        if (!visible) {
            nodeSection = `<p class="dialog-note">Nodes live in ${this.escapeHtml(this.clusterSource().profileName)},
                and the instance list belongs to ${this.escapeHtml(this.currentProfile || 'this account')}.
                Switch the account in the sidebar to see them.</p>`;
        } else if (!nodes.length) {
            // Saying "none" here would be a claim Portus cannot make
            nodeSection = `<p class="dialog-note">No instance carries this cluster's
                <span class="mono">eks:cluster-name</span> tag. Managed node groups are tagged;
                self-managed nodes and some provisioners are not, so the cluster may still have nodes.</p>`;
        } else {
            nodeSection = `<div class="node-list">${nodes.map(node => `
                <div class="node" data-node="${this.escapeHtml(node.instanceId)}">
                    <div class="node-main">
                        <span class="node-name">${this.escapeHtml(node.instanceName || node.instanceId)}</span>
                        <span class="node-meta mono">${this.escapeHtml(node.privateIp || '—')}</span>
                    </div>
                    <div class="node-side">
                        ${this.ssmCell(node)}
                        <div class="row-actions">${this.nodeActions(node)}</div>
                    </div>
                </div>`).join('')}</div>`;
        }

        document.getElementById('clusterDetailBody').innerHTML = `
            <div class="detail-group">Cluster</div>
            <dl>${rows([
                ['Status', this.clusterStateCell(cluster.status)],
                ['Version', this.escapeHtml(cluster.engineVersion || '—')],
                ['Support', this.clusterSupportCell(cluster)],
                ['Endpoint', this.escapeHtml(access)],
                ['VPC', `<span class="mono">${this.escapeHtml(cluster.vpcId || '—')}</span>`],
                ['Port', `<span class="mono">${this.escapeHtml(String(cluster.port || 443))}</span>`]
            ])}</dl>

            ${this.supportDetail(cluster)}

            <div class="detail-group">Nodes${visible && nodes.length ? ` · ${nodes.length} tagged` : ''}</div>
            ${nodeSection}
        `;

        // The node rows offer the same actions an instance row does, against
        // the same instance — it is in the list, just filtered to this cluster.
        document.getElementById('clusterDetailBody')
            .querySelectorAll('button[data-action]').forEach(button => {
                button.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const node = this.instances.find(item => item.instanceId === button.dataset.node);
                    if (node) this.runAction(button.dataset.action, node);
                });
            });
    }

    // The same rules the instance row uses, so a node offers what that instance
    // would offer anywhere else.
    nodeActions(node) {
        const running = node.state === 'running';
        const isWindows = (node.platform || '').toLowerCase().includes('windows');
        const connectable = running && (node.ssmStatus === 'online' || node.ssmStatus === 'unknown');
        const id = this.escapeHtml(node.instanceId);

        if (!running) return '<button class="act" disabled title="Instance is not running">Stopped</button>';

        if (connectable) {
            return `
                <button class="act primary" data-action="ssm" data-node="${id}">SSM</button>
                ${isWindows ? `<button class="act" data-action="rdp" data-node="${id}">RDP</button>` : ''}
                <button class="act" data-action="port" data-node="${id}">Port</button>`;
        }

        const blocked = this.escapeHtml(this.ssmBlockReason(node.ssmStatus));
        return node.privateIp && this.hopCandidatesFor(node).length
            ? `<button class="act" data-action="via" data-node="${id}" title="${blocked}">Access via…</button>`
            : `<button class="act" disabled title="${blocked}">No SSM</button>`;
    }

    // Where this cluster's version stands, and how long that lasts.
    //
    // The window that matters is the one it is in: a version in standard
    // support is counted down to the end of standard support, one already in
    // extended support to the end of that. Past both, there is nothing to count.
    clusterSupportCell(cluster) {
        const support = cluster.support;
        if (!support || !support.status) return '<span class="dim">—</span>';

        const status = String(support.status).toUpperCase();

        if (status === 'UNSUPPORTED') {
            return '<span class="state"><span class="dot bad"></span>Unsupported</span>';
        }

        const extended = status === 'EXTENDED_SUPPORT';
        const ends = extended ? support.extendedSupportEnds : support.standardSupportEnds;
        const label = extended ? 'Extended' : 'Standard';
        const dot = extended ? 'warn' : 'ok';

        const until = ends
            ? `<span class="muted"> · ${this.escapeHtml(this.supportDate(ends))}</span>`
            : '';

        return `<span class="state"><span class="dot ${dot}"></span>${label}</span>${until}`;
    }

    // The panel has room for both dates and for what happens at the end of
    // standard support, which the column does not.
    supportDetail(cluster) {
        const support = cluster.support;
        if (!support || !support.status) {
            return `<p class="dialog-note">How long this version is supported could not be read.
                It needs <span class="mono">eks:DescribeClusterVersions</span>.</p>`;
        }

        const rows = [];
        if (support.standardSupportEnds) {
            rows.push(['Standard support ends', this.escapeHtml(this.supportDate(support.standardSupportEnds))]);
        }
        if (support.extendedSupportEnds) {
            rows.push(['Extended support ends', this.escapeHtml(this.supportDate(support.extendedSupportEnds))]);
        }

        // A choice the cluster carries, not a state it is in: EXTENDED keeps it
        // on the old version and charges for it, STANDARD lets AWS upgrade it.
        if (cluster.supportPolicy) {
            rows.push(['At end of standard', cluster.supportPolicy === 'EXTENDED'
                ? 'Enters extended support'
                : 'Upgraded automatically']);
        }

        if (!rows.length) return '';

        return `
            <div class="detail-group">Support period</div>
            <dl>${rows.map(([k, v]) => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
    }

    // Short and unambiguous across locales: a day, a short month, a year.
    supportDate(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    clusterStateCell(status) {
        const value = (status || '').toUpperCase();
        const dot = value === 'ACTIVE' ? 'ok' : (value === 'FAILED' ? 'bad' : 'warn');
        const label = value ? value.charAt(0) + value.slice(1).toLowerCase() : '—';
        return `<span class="state"><span class="dot ${dot}"></span>${this.escapeHtml(label)}</span>`;
    }

    // One click: pick the hop, open the tunnel, write the kubeconfig.
    //
    // The same call the port dialog makes — the cluster's account and region
    // travel with it, so a cluster in another account is described and tokened
    // with its own profile while the tunnel runs on the instance's.
    async connectCluster(cluster, button) {
        const hop = this.hopForCluster(cluster);
        if (!hop) {
            this.toast(`Nothing managed is running in ${cluster.vpcId || "the cluster's VPC"} to reach ${cluster.name} through`, 'warning');
            return;
        }

        const hopName = hop.instanceName || hop.instanceId;

        button.disabled = true;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Connecting…';

        const source = this.clusterSource();
        const result = await this.startPortForward(hop.instanceId, hopName, {
            remoteHost: cluster.host,
            remotePort: String(cluster.port || 443),
            localPort: '',
            region: this.currentRegion,
            kubernetes: {
                clusterName: cluster.name,
                profileName: source.profileName,
                region: this.clusterRegion || source.region || undefined
            }
        });

        if (result && result.success) {
            this.toast(`${cluster.name} is reachable on localhost:${result.port}, through ${hopName}`, 'success');
        } else {
            button.disabled = false;
            button.innerHTML = 'Connect';
        }

        await this.refreshTunnels();
        this.renderClusters();
    }

    // Shared by the tunnel row and the cluster row, which offer the same two
    // actions against the same tunnel.
    async openKubectl(tunnelId) {
        const result = await window.electronAPI.openKubectlTerminal(tunnelId);
        this.toast(result && result.success
            ? result.message
            : (result && result.error) || 'Could not open a kubectl terminal',
            result && result.success ? 'success' : 'error');
        return result;
    }

    async closeTunnel(tunnelId, label) {
        await window.electronAPI.closeTunnel(tunnelId);
        this.toast(`Disconnected ${label || 'the tunnel'}`, 'info');
    }

    async refreshTunnels() {
        try {
            this.renderTunnels(await window.electronAPI.listTunnels());
        } catch (error) { /* the push from the main process will correct it */ }
    }

    renderTunnels(tunnels) {
        this.tunnels = tunnels || [];
        const wrap = document.getElementById('tunnelTableWrap');

        // A tunnel opening or closing changes what the cluster rows offer —
        // Connect becomes kubectl, and back again when it is torn down.
        if (this.clustersLoaded) this.renderClusters();

        document.getElementById('navTunnelCount').textContent = this.tunnels.length;
        document.getElementById('statusTunnels').textContent = this.tunnels.length;
        document.getElementById('tunnelCount').textContent = this.tunnels.length
            ? `${this.tunnels.length} open` : '';

        if (!this.tunnels.length) {
            wrap.innerHTML = `
                <div class="empty">
                    <i class="fas fa-plug"></i>
                    <p>No tunnels are open. Use <strong>RDP</strong> or <strong>Port</strong> on an instance.</p>
                </div>`;
            this.syncUptimeTicker();
            return;
        }

        const table = document.createElement('table');
        table.innerHTML = `
            <thead><tr>
                <th>Type</th><th>Instance</th><th>Local address</th>
                <th>Target</th><th>Uptime</th><th>Actions</th>
            </tr></thead>
        `;
        const tbody = document.createElement('tbody');

        this.tunnels.forEach(tunnel => {
            const kind = tunnel.kind === 'port' ? 'Port' : 'RDP';
            const target = tunnel.remoteHost
                ? `${tunnel.remoteHost}:${tunnel.remotePort}`
                : `this instance:${tunnel.remotePort || 3389}`;

            // On a two-hop tunnel the instance column would otherwise name the hop
            // as though it were the destination, which reads as the wrong machine.
            const instanceLabel = tunnel.target
                ? `${tunnel.target.instanceName || tunnel.target.instanceId} via ${tunnel.instanceName || tunnel.instanceId}`
                : (tunnel.instanceName || tunnel.instanceId);

            // kept on the cell so the ticker can redraw it without the tunnel list
            const startedAt = new Date(tunnel.startedAt).getTime();

            const row = document.createElement('tr');
            row.innerHTML = `
                <td><span class="state"><span class="dot ok"></span>${kind}</span></td>
                <td class="name-cell">${this.escapeHtml(instanceLabel)}</td>
                <td class="mono">localhost:${tunnel.port}</td>
                <td class="mono muted">${this.escapeHtml(target)}</td>
                <td class="muted num" data-started-at="${startedAt}">${this.uptime(startedAt)}</td>
                <td class="actions"><div class="row-actions">
                    ${tunnel.kubernetes ? '<button class="act primary" data-kubectl>kubectl</button>' : ''}
                    <button class="act" data-copy>Copy</button>
                    <button class="act" data-close>Disconnect</button>
                </div></td>
            `;
            row.querySelector('[data-copy]').addEventListener('click', (e) => {
                e.stopPropagation();
                this.copy(`localhost:${tunnel.port}`);
            });

            // Opens a shell with KUBECONFIG already pointing at the generated
            // file, so kubectl works without anyone editing ~/.kube/config
            const kubectl = row.querySelector('[data-kubectl]');
            if (kubectl) {
                kubectl.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await this.openKubectl(tunnel.id);
                });
            }
            row.querySelector('[data-close]').addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.closeTunnel(tunnel.id, tunnel.instanceName || tunnel.instanceId);
            });
            tbody.appendChild(row);
        });

        table.appendChild(tbody);
        wrap.innerHTML = '';
        wrap.appendChild(table);

        this.syncUptimeTicker();
    }

    uptime(startedAt) {
        const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m`;
        return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    }

    async copy(text) {
        try {
            await navigator.clipboard.writeText(text);
            this.toast(`Copied ${text}`, 'info');
        } catch (error) {
            this.toast('Could not copy to clipboard', 'error');
        }
    }

    // ==========================================================================
    // SESSION
    // ==========================================================================

    startSessionWatcher() {
        this.stopSessionWatcher();
        this.sessionWatcher = setInterval(() => this.checkSession(), 60000);
        this.checkSession();
    }

    stopSessionWatcher() {
        if (this.sessionWatcher) clearInterval(this.sessionWatcher);
        this.sessionWatcher = null;
    }

    async checkSession() {
        if (!this.isLoggedIn || this.isRefreshingSession) return;

        try {
            const status = await window.electronAPI.getSessionStatus(this.currentProfile);
            if (!status || !status.success || status.expiresInMs === null) return;

            this.renderSession(status.expiresInMs);

            // Renew inside the last 3 minutes, at most once every 5
            const COOLDOWN = 5 * 60 * 1000;
            if (this.lastRefreshAt && Date.now() - this.lastRefreshAt < COOLDOWN) return;
            if (status.expiresInMs > 3 * 60 * 1000) return;

            // A login that needs a browser is not something to start on a timer.
            // Say the session is about to lapse and leave the choice to the user.
            if (this.selectedProfile && this.selectedProfile.interactiveLogin) {
                this.lastRefreshAt = Date.now();
                this.toast('This session expires shortly — sign in again to keep working', 'warning');
                return;
            }

            this.isRefreshingSession = true;
            this.lastRefreshAt = Date.now();
            const result = await window.electronAPI.refreshSession();

            if (result && result.success) {
                this.updateConnection(true, result.ssoProfile || this.selectedAuthProfile);
            } else {
                this.handleSessionExpired(result && result.error);
            }
        } catch (error) {
            // Non-fatal: the reactive retry in loadInstances still covers expiry
        } finally {
            this.isRefreshingSession = false;
        }
    }

    renderSession(remainingMs) {
        const meter = document.getElementById('sessionMeter');
        const fill = document.getElementById('sessionFill');
        const minutes = Math.max(0, Math.round(remainingMs / 60000));

        meter.style.display = 'block';
        document.getElementById('sessionRemaining').textContent = `${minutes} min left`;

        const pct = Math.max(0, Math.min(100, (remainingMs / (60 * 60 * 1000)) * 100));
        fill.style.width = `${pct}%`;
        fill.classList.toggle('low', minutes <= 10);

        document.getElementById('statusRenew').style.display = '';
        document.getElementById('statusRenewSep').style.display = '';
        document.getElementById('statusRenewValue').textContent = `${minutes}m`;
    }

    handleSessionExpired(message) {
        this.isLoggedIn = false;
        this.stopSessionWatcher();
        this.updateConnection(false);

        // Telling someone to sign in again is only useful advice when there is a
        // sign-in to run. Expired access keys are replaced in ~/.aws, not here.
        const canSignIn = this.selectedProfile && this.selectedProfile.canLogin;
        this.toast(message || (canSignIn
            ? 'Your AWS session expired. Sign in again.'
            : 'The credentials for this profile are no longer valid. Refresh them and try again.'), 'warning');
    }

    // ==========================================================================
    // UTILITIES
    // ==========================================================================

    toast(message, type = 'info') {
        const el = document.getElementById('toast');
        const icon = el.querySelector('.toast-icon');
        const text = el.querySelector('.toast-message');

        if (this.toastTimer) clearTimeout(this.toastTimer);
        el.className = 'toast';
        el.classList.add(type);

        const icons = {
            success: 'fas fa-circle-check',
            error: 'fas fa-circle-exclamation',
            warning: 'fas fa-triangle-exclamation',
            info: 'fas fa-circle-info'
        };
        icon.className = `toast-icon ${icons[type] || icons.info}`;
        text.textContent = message;

        requestAnimationFrame(() => el.classList.add('show'));
        this.toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
    }

    // textContent escapes & < > but leaves quotes alone, which is fine in a text
    // node and unsafe in an attribute. Quotes are escaped too so the result is
    // safe in either position.
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Escape first, then wrap the match, so nothing user-supplied becomes markup
    highlight(text, term) {
        const safe = this.escapeHtml(text);
        if (!term) return safe;
        const safeTerm = this.escapeHtml(term);
        const index = safe.toLowerCase().indexOf(safeTerm.toLowerCase());
        if (index === -1) return safe;
        return safe.slice(0, index) +
            '<mark>' + safe.slice(index, index + safeTerm.length) + '</mark>' +
            safe.slice(index + safeTerm.length);
    }
}

// Guard against the script running after the event has already fired
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new Portus());
} else {
    new Portus();
}
