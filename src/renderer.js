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

        // Managed endpoints suggested in the port forwarding dialog, keyed by
        // profile. Databases do not come and go between dialog openings, so this
        // is only cleared when the profile changes or the user asks to refresh.
        this.endpointCache = new Map();

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
        this.bindFilters();
        this.bindTunnelEvents();
        window.electronAPI.onSsoVerification(({ code }) => this.showSsoVerification(code));

        await this.applyAppVersion();
        this.checkRequiredTools();
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
                if (overlay) overlay.remove();
                if (this.comboOpen) this.closeCombo();
            }
        });
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
        document.getElementById('viewTunnels').style.display = view === 'tunnels' ? 'flex' : 'none';
        document.querySelectorAll('.nav-item[data-view]').forEach(item => {
            item.classList.toggle('active', item.dataset.view === view);
        });

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
            document.getElementById('statusRegion').textContent = '—';
            this.updateConnection(false);
        } else if (this.currentProfile) {
            // its region or provider may have been edited
            this.selectedProfile = (this.profiles || []).find(p => p.name === this.currentProfile) || null;
            document.getElementById('statusRegion').textContent =
                (this.selectedProfile && this.selectedProfile.region) || '—';
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
        document.getElementById('statusRegion').textContent =
            (this.selectedProfile && this.selectedProfile.region) || '—';

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

        this.showView('instances');
        this.renderDetail(null);
        this.renderSkeleton();
        this.setBusy(true);
        document.getElementById('refreshBtn').disabled = true;

        try {
            const result = await window.electronAPI.getEc2Instances(this.currentProfile);

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
            actions = `<button class="act" disabled title="${blocked}">No SSM</button>`;
        }

        row.innerHTML = `
            <td class="name-cell">${this.escapeHtml(item.instanceName || '—')}</td>
            <td class="mono">${this.escapeHtml(item.instanceId)}</td>
            <td class="muted">${this.escapeHtml(item.instanceType || '')}</td>
            <td>${this.stateCell(item.state)}</td>
            <td>${this.ssmCell(item)}</td>
            <td class="mono">${this.escapeHtml(item.privateIp || '—')}</td>
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

        return row;
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
                ['Platform', this.escapeHtml(item.platform || '—')]
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
            const result = await window.electronAPI.connectSSM(this.currentProfile, instanceId);
            if (result && result.success) this.toast(`SSM session started for ${name}`, 'success');
            else throw new Error(result?.error || 'Failed to start SSM session');
        } catch (error) {
            this.toast(`${name}: ${error.error || error.message}`, 'error');
        }
    }

    async connectRdp(instanceId, name) {
        this.toast(`Establishing RDP tunnel to ${name}…`, 'info');
        try {
            const result = await window.electronAPI.connectRDPSSM(this.currentProfile, instanceId, name);
            if (result && result.success) {
                this.toast(result.reused
                    ? `${name} is already tunnelled on port ${result.port}`
                    : `RDP tunnel open for ${name} on port ${result.port}`,
                    result.reused ? 'info' : 'success');
            } else {
                throw new Error(result?.error || 'Failed to establish RDP tunnel');
            }
        } catch (error) {
            this.toast(`${name}: ${error.error || error.message}`, 'error');
        }
    }

    openPortDialog(instanceId, name) {
        const presets = [
            { label: 'Oracle', port: 1521, service: 'oracle' },
            { label: 'SQL Server', port: 1433, service: 'sqlserver' },
            { label: 'PostgreSQL', port: 5432, service: 'postgresql' },
            { label: 'MySQL', port: 3306, service: 'mysql' },
            { label: 'Redis', port: 6379, service: 'redis' }
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

            const cached = this.endpointCache.get(this.currentProfile);
            if (cached) {
                endpoints = cached;
                loadState = 'ready';
                renderList();
                return;
            }

            loadState = 'loading';
            renderList();

            const result = await this.loadEndpoints();
            if (!overlay.isConnected) return;   // dialog closed while in flight

            if (result.success) {
                endpoints = result.data;
                loadState = 'ready';
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
                list.innerHTML = '<div class="combo-empty">No databases or caches found in this region</div>';
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

            // The port the API reported wins over the service preset — a database
            // on a non-standard port is otherwise silently wrong.
            if (endpoint.port) {
                remote.value = String(endpoint.port);
                syncChips();
            }

            // Encrypted Redis presents a certificate for its real hostname, which
            // will not match the localhost the client connects to.
            if (endpoint.tls) {
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
            this.endpointCache.delete(this.currentProfile);
            endpoints = [];
            loadState = 'idle';
            if (!panelOpen) openPanel(); else { renderList(); ensureEndpoints(); }
        });

        host.addEventListener('focus', () => openPanel());
        host.addEventListener('input', () => {
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

        overlay.querySelectorAll('.chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const wasOn = chip.classList.contains('on');
                overlay.querySelectorAll('.chip').forEach(c => c.classList.remove('on'));
                if (!wasOn) {
                    chip.classList.add('on');
                    remote.value = chip.dataset.port;
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
                remoteHost, remotePort: remote.value.trim(), localPort: local.value.trim()
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
    async loadEndpoints() {
        if (!this.currentProfile) return { success: false, error: 'No profile selected' };

        this.setBusy(true);
        try {
            const result = await window.electronAPI.getEndpoints(this.currentProfile);

            if (result && result.success) {
                if (result.reauthenticated) {
                    this.isLoggedIn = true;
                    this.updateConnection(true, this.selectedAuthProfile);
                    this.startSessionWatcher();
                }

                const data = result.data || [];
                this.endpointCache.set(this.currentProfile, data);

                // A permission gap on one service still leaves the others usable,
                // so this is a note rather than a failure.
                if (result.warnings && result.warnings.length) {
                    this.toast(`Some endpoints could not be listed: ${result.warnings.join('; ')}`, 'warning');
                }
                return { success: true, data };
            }

            if (result && result.sessionExpired) {
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

    renderTunnels(tunnels) {
        this.tunnels = tunnels || [];
        const wrap = document.getElementById('tunnelTableWrap');

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

            // kept on the cell so the ticker can redraw it without the tunnel list
            const startedAt = new Date(tunnel.startedAt).getTime();

            const row = document.createElement('tr');
            row.innerHTML = `
                <td><span class="state"><span class="dot ok"></span>${kind}</span></td>
                <td class="name-cell">${this.escapeHtml(tunnel.instanceName || tunnel.instanceId)}</td>
                <td class="mono">localhost:${tunnel.port}</td>
                <td class="mono muted">${this.escapeHtml(target)}</td>
                <td class="muted num" data-started-at="${startedAt}">${this.uptime(startedAt)}</td>
                <td class="actions"><div class="row-actions">
                    <button class="act" data-copy>Copy</button>
                    <button class="act" data-close>Disconnect</button>
                </div></td>
            `;
            row.querySelector('[data-copy]').addEventListener('click', (e) => {
                e.stopPropagation();
                this.copy(`localhost:${tunnel.port}`);
            });
            row.querySelector('[data-close]').addEventListener('click', async (e) => {
                e.stopPropagation();
                await window.electronAPI.closeTunnel(tunnel.id);
                this.toast(`Disconnected ${tunnel.instanceName || tunnel.instanceId}`, 'info');
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
