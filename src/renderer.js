class AWSManager {
    constructor() {
        this.currentProfile = null;
        this.profiles = [];            // Azure AD SSO profiles (for login)
        this.operationalProfiles = []; // non-SSO profiles (for instance ops)
        this.isLoggedIn = false;
        this.selectedAuthProfile = null;
        this.toastTimeout = null;
        this.sessionWatcher = null;
        this.isRefreshingSession = false;
        this.lastRefreshAt = null;
        this.profileComboOpen = false;
        this.filteredProfiles = [];
        this.activeOptionIndex = 0;
        this.activeTunnels = [];
        this.initWithPreloader();
    }

    async initWithPreloader() {
        await this.simulateLoading();
        await this.init();
        this.hidePreloader();
    }

    async simulateLoading() {
        const loadingStatus = document.getElementById('loadingStatus');
        const progressFill = document.getElementById('progressFill');
        const progressPercentage = document.getElementById('progressPercentage');

        const steps = [
            { text: 'Initializing application...', progress: 0, delay: 600 },
            { text: 'Loading AWS profiles...', progress: 30, delay: 700 },
            { text: 'Setting up UI components...', progress: 60, delay: 600 },
            { text: 'Finalizing setup...', progress: 90, delay: 500 },
            { text: 'Ready to launch!', progress: 100, delay: 400 }
        ];

        await new Promise(resolve => setTimeout(resolve, 400));

        for (const step of steps) {
            if (loadingStatus) {
                loadingStatus.style.opacity = '0.5';
                setTimeout(() => {
                    loadingStatus.textContent = step.text;
                    loadingStatus.style.opacity = '1';
                }, 150);
            }
            if (progressFill && progressPercentage) {
                progressFill.style.width = step.progress + '%';
                progressPercentage.textContent = step.progress + '%';
            }
            await new Promise(resolve => setTimeout(resolve, step.delay));
        }

        await new Promise(resolve => setTimeout(resolve, 500));
    }

    hidePreloader() {
        const preloader = document.getElementById('preloader');
        if (preloader) {
            preloader.classList.add('hidden');
            setTimeout(() => preloader.remove(), 500);
        }
    }

    async init() {
        this.setupEventListeners();
        await this.applyAppVersion();
        this.setupSessionsPanel();
        this.checkRequiredTools();
        await this.loadProfiles();
        this.updateInitialUI();
        // Kept for debugging from DevTools. Nothing in the UI depends on it:
        // buttons bind their handlers directly rather than through a global.
        window.awsManager = this;
    }

    // Stamp the real packaged version over the placeholders in the markup, so the
    // displayed version always matches package.json.
    async applyAppVersion() {
        try {
            const version = await window.electronAPI.getAppVersion();
            if (!version) return;

            document.querySelectorAll('.js-app-version').forEach(el => {
                el.textContent = `v${version}`;
            });
        } catch (error) {
            // Keep whatever the markup already shows
        }
    }

    // ==========================================================================
    // EXTERNAL TOOL PREFLIGHT
    // ==========================================================================

    // Surface missing CLI dependencies at startup rather than letting them fail
    // later inside a terminal window that closes immediately.
    async checkRequiredTools() {
        const banner = document.getElementById('depBanner');
        const list = document.getElementById('depBannerList');
        const closeBtn = document.getElementById('depBannerClose');
        if (!banner || !list) return;

        if (closeBtn && !closeBtn.dataset.bound) {
            closeBtn.dataset.bound = '1';
            closeBtn.addEventListener('click', () => { banner.style.display = 'none'; });
        }

        try {
            const result = await window.electronAPI.checkRequiredTools();
            if (!result || !result.success) return;

            const missing = (result.tools || []).filter(tool => !tool.found);
            if (!missing.length) {
                banner.style.display = 'none';
                return;
            }

            list.innerHTML = missing.map(tool => `
                <li>
                    <span class="dep-name">${this.escapeHtml(tool.name)}</span>
                    <span class="dep-purpose">${this.escapeHtml(tool.purpose)}</span>
                    <code class="dep-install">${this.escapeHtml(tool.install)}</code>
                </li>
            `).join('');

            banner.style.display = 'flex';
        } catch (error) {
            // A failed preflight must not block the app
        }
    }

    // ==========================================================================
    // PORT FORWARDING
    // ==========================================================================

    openPortForwardDialog(instanceId, instanceName) {
        if (!this.currentProfile) {
            this.showToast('No profile selected', 'error');
            return;
        }

        const presets = [
            { label: 'Oracle', port: 1521 },
            { label: 'SQL Server', port: 1433 },
            { label: 'PostgreSQL', port: 5432 },
            { label: 'MySQL', port: 3306 },
            { label: 'Redis', port: 6379 }
        ];

        const overlay = document.createElement('div');
        overlay.className = 'popup-overlay';

        const popup = document.createElement('div');
        popup.className = 'popup-content pf-dialog';
        popup.innerHTML = `
            <div class="popup-header">
                <h3>Forward a port</h3>
                <button class="popup-close" id="pfClose"><i class="fas fa-times"></i></button>
            </div>
            <div class="popup-body">
                <div class="pf-context">
                    <i class="fas fa-server"></i>
                    <span>Tunnelling through <strong>${this.escapeHtml(instanceName)}</strong> · ${this.escapeHtml(instanceId)}</span>
                </div>

                <div class="pf-field">
                    <label class="pf-label">Target</label>
                    <div class="pf-segment">
                        <button type="button" class="active" data-target="local">This instance</button>
                        <button type="button" data-target="remote">A host reachable from it</button>
                    </div>
                </div>

                <div class="pf-field" id="pfHostField" style="display: none;">
                    <label class="pf-label">Remote host</label>
                    <input class="pf-input mono" id="pfHost" spellcheck="false" autocomplete="off"
                           placeholder="my-db.abc123.eu-central-1.rds.amazonaws.com">
                </div>

                <div class="pf-field">
                    <label class="pf-label">Service</label>
                    <div class="pf-chips" id="pfChips">
                        ${presets.map(p => `<button type="button" class="pf-chip" data-port="${p.port}">${p.label}</button>`).join('')}
                    </div>
                </div>

                <div class="pf-ports">
                    <div class="pf-field" style="margin-bottom: 0;">
                        <label class="pf-label">Remote port</label>
                        <input class="pf-input mono" id="pfRemotePort" inputmode="numeric" placeholder="e.g. 1521">
                    </div>
                    <div class="pf-field" style="margin-bottom: 0;">
                        <label class="pf-label">Local port</label>
                        <input class="pf-input mono" id="pfLocalPort" inputmode="numeric" placeholder="Auto (free port)">
                    </div>
                </div>

                <div class="pf-hint">
                    <i class="fas fa-shield-halved"></i>
                    <span>Traffic goes out through the SSM agent. No inbound security-group rule, no public IP, and the session is recorded in CloudTrail.</span>
                </div>

                <div class="pf-footer">
                    <button type="button" class="pf-cancel" id="pfCancel">Cancel</button>
                    <button type="button" class="pf-start" id="pfStart">
                        <i class="fas fa-right-left"></i> Start forwarding
                    </button>
                </div>
            </div>
        `;

        overlay.appendChild(popup);
        document.body.appendChild(overlay);

        const hostField = popup.querySelector('#pfHostField');
        const hostInput = popup.querySelector('#pfHost');
        const remotePortInput = popup.querySelector('#pfRemotePort');
        const localPortInput = popup.querySelector('#pfLocalPort');
        const startBtn = popup.querySelector('#pfStart');
        const close = () => overlay.remove();

        popup.querySelector('#pfClose').addEventListener('click', close);
        popup.querySelector('#pfCancel').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        // Target toggle shows/hides the remote host field
        popup.querySelectorAll('.pf-segment button').forEach(btn => {
            btn.addEventListener('click', () => {
                popup.querySelectorAll('.pf-segment button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const isRemote = btn.dataset.target === 'remote';
                hostField.style.display = isRemote ? 'block' : 'none';
                if (isRemote) hostInput.focus();
            });
        });

        // Chips just fill the remote port; it stays editable
        popup.querySelectorAll('.pf-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                popup.querySelectorAll('.pf-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                remotePortInput.value = chip.dataset.port;
            });
        });

        // Typing a port by hand clears any chip selection
        remotePortInput.addEventListener('input', () => {
            popup.querySelectorAll('.pf-chip').forEach(chip => {
                chip.classList.toggle('active', chip.dataset.port === remotePortInput.value.trim());
            });
        });

        startBtn.addEventListener('click', async () => {
            const isRemote = popup.querySelector('.pf-segment button.active').dataset.target === 'remote';
            const remoteHost = isRemote ? hostInput.value.trim() : '';

            if (isRemote && !remoteHost) {
                this.showToast('Enter the remote host to forward to', 'warning');
                hostInput.focus();
                return;
            }
            if (!remotePortInput.value.trim()) {
                this.showToast('Enter the remote port to forward', 'warning');
                remotePortInput.focus();
                return;
            }

            startBtn.disabled = true;
            startBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting…';

            const result = await this.startPortForward(instanceId, instanceName, {
                remoteHost,
                remotePort: remotePortInput.value.trim(),
                localPort: localPortInput.value.trim()
            });

            if (result && result.success) {
                close();
            } else {
                startBtn.disabled = false;
                startBtn.innerHTML = '<i class="fas fa-right-left"></i> Start forwarding';
            }
        });

        setTimeout(() => remotePortInput.focus(), 100);
    }

    async startPortForward(instanceId, instanceName, options) {
        this.showLoading(true);
        try {
            const result = await window.electronAPI.startPortForward(
                this.currentProfile, instanceId, instanceName, options
            );

            if (result && result.success) {
                this.showToast(
                    result.reused
                        ? `Already forwarding on localhost:${result.port}`
                        : `Forwarding localhost:${result.port} → ${options.remoteHost || instanceName}:${options.remotePort}`,
                    result.reused ? 'info' : 'success'
                );
            } else {
                this.showToast(result?.error || 'Could not start port forwarding', 'error');
            }
            return result;
        } catch (error) {
            this.showToast(`Port forwarding failed: ${error.message}`, 'error');
            return { success: false };
        } finally {
            this.showLoading(false);
        }
    }

    // ==========================================================================
    // ACTIVE TUNNELS
    // ==========================================================================

    setupSessionsPanel() {
        const trigger = document.getElementById('sessionsTrigger');
        const wrap = document.getElementById('sessionsWrap');
        if (!trigger || !wrap) return;

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = wrap.classList.toggle('open');
            trigger.setAttribute('aria-expanded', String(open));
        });

        document.addEventListener('click', (e) => {
            if (!wrap.contains(e.target)) {
                wrap.classList.remove('open');
                trigger.setAttribute('aria-expanded', 'false');
            }
        });

        // Live updates pushed from the main process
        window.electronAPI.onTunnelsChanged(tunnels => this.renderTunnels(tunnels));

        // Keep the uptime column moving without re-fetching
        setInterval(() => {
            if (this.activeTunnels && this.activeTunnels.length) {
                this.renderTunnels(this.activeTunnels);
            }
        }, 30000);

        window.electronAPI.listTunnels()
            .then(tunnels => this.renderTunnels(tunnels))
            .catch(() => { /* nothing to show yet */ });
    }

    renderTunnels(tunnels) {
        this.activeTunnels = tunnels || [];

        const wrap = document.getElementById('sessionsWrap');
        const count = document.getElementById('sessionsCount');
        const list = document.getElementById('sessionsList');
        const trigger = document.getElementById('sessionsTrigger');
        if (!wrap || !count || !list) return;

        if (!this.activeTunnels.length) {
            wrap.style.display = 'none';
            wrap.classList.remove('open');
            if (trigger) trigger.setAttribute('aria-expanded', 'false');
            return;
        }

        wrap.style.display = 'block';
        count.textContent = this.activeTunnels.length;

        list.innerHTML = '';
        this.activeTunnels.forEach(tunnel => {
            const kind = tunnel.kind === 'port' ? 'port' : 'rdp';
            const target = tunnel.remoteHost
                ? `${this.shortenHost(tunnel.remoteHost)}:${tunnel.remotePort}`
                : `:${tunnel.remotePort || 3389}`;

            const row = document.createElement('div');
            row.className = 'session-row';
            row.innerHTML = `
                <div class="session-info">
                    <div class="session-top">
                        <span class="session-type ${kind}">${kind.toUpperCase()}</span>
                        <span class="session-name">${this.escapeHtml(tunnel.instanceName || tunnel.instanceId)}</span>
                    </div>
                    <span class="session-meta">localhost:${tunnel.port} &rarr; ${this.escapeHtml(target)} · ${this.formatUptime(tunnel.startedAt)}</span>
                </div>
                <button type="button" class="session-copy" title="Copy localhost:${tunnel.port}">
                    <i class="fas fa-copy"></i>
                </button>
                <button type="button" class="session-disconnect">Disconnect</button>
            `;

            row.querySelector('.session-copy')
                .addEventListener('click', () => this.copyToClipboard(`localhost:${tunnel.port}`));
            row.querySelector('.session-disconnect')
                .addEventListener('click', () => this.disconnectTunnel(tunnel));
            list.appendChild(row);
        });
    }

    async disconnectTunnel(tunnel) {
        try {
            await window.electronAPI.closeTunnel(tunnel.id);
            this.showToast(`Disconnected ${tunnel.instanceName || tunnel.instanceId}`, 'info');
        } catch (error) {
            this.showToast('Could not close the tunnel', 'error');
        }
    }

    // RDS endpoints are long; keep the ends, which is what identifies them
    shortenHost(host) {
        if (!host || host.length <= 28) return host;
        return `${host.slice(0, 14)}…${host.slice(-12)}`;
    }

    async copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            this.showToast(`Copied ${text}`, 'info');
        } catch (error) {
            this.showToast('Could not copy to clipboard', 'error');
        }
    }

    formatUptime(startedAt) {
        const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
        if (seconds < 60) return `${seconds}s`;

        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m`;

        return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    }

    // ==========================================================================
    // EVENT LISTENERS
    // ==========================================================================

    setupEventListeners() {
        this.setupProfileCombo();

        const loginBtn = document.getElementById('loginBtn');
        if (loginBtn) {
            loginBtn.addEventListener('click', () => this.showProfileSelectionPopup());
        }

        const appLogo = document.getElementById('appLogo');
        if (appLogo) {
            appLogo.addEventListener('click', () => this.showWelcomeScreen());
        }

        const refreshBtn = document.getElementById('refreshBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => this.loadInstances());
        }

        const toastClose = document.querySelector('.toast-close');
        if (toastClose) {
            toastClose.addEventListener('click', () => {
                const toast = document.getElementById('toast');
                if (toast) toast.classList.remove('show');
            });
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const overlay = document.querySelector('.popup-overlay');
                if (overlay) overlay.remove();
                if (this.profileComboOpen) this.closeProfileCombo();
            }
        });
    }

    // ==========================================================================
    // UI STATE
    // ==========================================================================

    updateInitialUI() {
        const loginBtn = document.getElementById('loginBtn');
        const statusIndicator = document.getElementById('statusIndicator');
        const statusText = document.getElementById('statusText');

        loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i><span>SSO Connect</span>';
        loginBtn.disabled = false;
        loginBtn.className = 'action-btn login-btn';

        statusIndicator.className = 'status-indicator offline';
        statusText.textContent = 'Disconnected';

        this.updateProfileSelectState();
    }

    updateConnectionStatus(isConnected, profileName = '') {
        const statusIndicator = document.getElementById('statusIndicator');
        const statusText = document.getElementById('statusText');
        const loginBtn = document.getElementById('loginBtn');

        if (isConnected) {
            statusIndicator.className = 'status-indicator online';
            statusText.textContent = `Connected${profileName ? ` (${profileName})` : ''}`;
            loginBtn.innerHTML = '<i class="fas fa-check-circle"></i><span>Connected</span>';
            loginBtn.className = 'action-btn login-btn connected';
        } else {
            statusIndicator.className = 'status-indicator offline';
            statusText.textContent = 'Disconnected';
            loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i><span>SSO Connect</span>';
            loginBtn.className = 'action-btn login-btn';
        }
        loginBtn.style.background = '';
        loginBtn.style.borderColor = '';
    }

    updateProfileSelectState() {
        const trigger = document.getElementById('profileComboTrigger');
        if (!trigger) return;

        trigger.disabled = !this.isLoggedIn;
        if (!this.isLoggedIn) {
            this.closeProfileCombo();
        }
    }

    // ==========================================================================
    // PROFILE LOADING & AUTHENTICATION
    // ==========================================================================

    async loadProfiles() {
        try {
            this.profiles = await window.electronAPI.getAwsProfiles();
            this.operationalProfiles = await window.electronAPI.getOperationalProfiles();
            this.renderProfileOptions('');
        } catch (error) {
            this.showToast('Failed to load AWS profiles: ' + error.message, 'error');
        }
    }

    // ==========================================================================
    // PROFILE COMBOBOX (searchable dropdown)
    // ==========================================================================

    setupProfileCombo() {
        const trigger = document.getElementById('profileComboTrigger');
        const search = document.getElementById('profileComboSearch');
        const combo = document.getElementById('profileCombo');

        if (!trigger || !search || !combo) return;

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleProfileCombo();
        });

        search.addEventListener('input', () => {
            this.renderProfileOptions(search.value);
        });

        search.addEventListener('keydown', (e) => {
            const count = this.filteredProfiles.length;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (count) this.setActiveOption((this.activeOptionIndex + 1) % count);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (count) this.setActiveOption((this.activeOptionIndex - 1 + count) % count);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const profile = this.filteredProfiles[this.activeOptionIndex];
                if (profile) this.chooseProfile(profile.name);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.closeProfileCombo();
                trigger.focus();
            }
        });

        // Click outside closes the panel
        document.addEventListener('click', (e) => {
            if (this.profileComboOpen && !combo.contains(e.target)) {
                this.closeProfileCombo();
            }
        });

        this.renderProfileOptions('');
    }

    toggleProfileCombo() {
        if (this.profileComboOpen) {
            this.closeProfileCombo();
        } else {
            this.openProfileCombo();
        }
    }

    openProfileCombo() {
        const combo = document.getElementById('profileCombo');
        const trigger = document.getElementById('profileComboTrigger');
        const search = document.getElementById('profileComboSearch');
        if (!combo || !trigger || trigger.disabled) return;

        this.profileComboOpen = true;
        combo.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');

        search.value = '';
        this.renderProfileOptions('');
        setTimeout(() => search.focus(), 0);
    }

    closeProfileCombo() {
        const combo = document.getElementById('profileCombo');
        const trigger = document.getElementById('profileComboTrigger');
        if (!combo) return;

        this.profileComboOpen = false;
        combo.classList.remove('open');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
    }

    renderProfileOptions(filter = '') {
        const list = document.getElementById('profileComboList');
        const countEl = document.getElementById('profileComboCount');
        if (!list) return;

        const all = this.operationalProfiles || [];
        const term = filter.trim().toLowerCase();

        this.filteredProfiles = term
            ? all.filter(p =>
                p.name.toLowerCase().includes(term) ||
                (p.region || '').toLowerCase().includes(term))
            : all.slice();

        list.innerHTML = '';

        if (!all.length) {
            list.innerHTML = '<div class="profile-combo-empty">No operational profiles found in ~/.aws/config</div>';
            if (countEl) countEl.textContent = '';
            return;
        }

        if (!this.filteredProfiles.length) {
            list.innerHTML = `<div class="profile-combo-empty">No profiles match "${this.escapeHtml(filter)}"</div>`;
            if (countEl) countEl.textContent = `0 of ${all.length}`;
            return;
        }

        this.filteredProfiles.forEach((profile, index) => {
            const option = document.createElement('div');
            option.className = 'profile-combo-option';
            option.setAttribute('role', 'option');
            option.dataset.profile = profile.name;

            if (profile.name === this.currentProfile) {
                option.classList.add('selected');
                option.setAttribute('aria-selected', 'true');
            }

            option.innerHTML = `
                <div class="option-main">
                    <span class="option-name">${this.highlightMatch(profile.name, term)}</span>
                    <span class="option-region">${this.escapeHtml(profile.region || '')}</span>
                </div>
                <i class="fas fa-check option-check"></i>
            `;

            option.addEventListener('click', () => this.chooseProfile(profile.name));
            option.addEventListener('mousemove', () => this.setActiveOption(index));

            list.appendChild(option);
        });

        if (countEl) {
            countEl.textContent = term
                ? `${this.filteredProfiles.length} of ${all.length} profiles`
                : `${all.length} profiles`;
        }

        // Pre-highlight the selected profile, otherwise the first result
        const selectedIndex = this.filteredProfiles.findIndex(p => p.name === this.currentProfile);
        this.setActiveOption(selectedIndex >= 0 ? selectedIndex : 0);
    }

    setActiveOption(index) {
        const list = document.getElementById('profileComboList');
        if (!list) return;

        const options = list.querySelectorAll('.profile-combo-option');
        if (!options.length) return;

        this.activeOptionIndex = index;
        options.forEach((el, i) => el.classList.toggle('active', i === index));

        const active = options[index];
        if (active) active.scrollIntoView({ block: 'nearest' });
    }

    chooseProfile(profileName) {
        this.closeProfileCombo();
        this.setProfileLabel(profileName);
        this.selectOperationalProfile(profileName);
    }

    setProfileLabel(profileName) {
        const label = document.getElementById('profileComboLabel');
        if (!label) return;

        if (!profileName) {
            label.textContent = 'Select Operational Profile';
            label.classList.remove('has-value');
            return;
        }

        const profile = (this.operationalProfiles || []).find(p => p.name === profileName);
        label.textContent = profile && profile.region
            ? `${profile.name} · ${profile.region}`
            : profileName;
        label.classList.add('has-value');
    }

    // textContent escapes & < > but leaves quotes alone, which is fine inside a text
    // node and unsafe inside an attribute. Quotes are escaped too so the result can
    // be used in either position without having to remember which is which.
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Escape first, then wrap the matched span — avoids injecting raw profile text
    highlightMatch(text, term) {
        const safe = this.escapeHtml(text);
        if (!term) return safe;

        const safeTerm = this.escapeHtml(term);
        const index = safe.toLowerCase().indexOf(safeTerm.toLowerCase());
        if (index === -1) return safe;

        return safe.slice(0, index) +
            '<mark>' + safe.slice(index, index + safeTerm.length) + '</mark>' +
            safe.slice(index + safeTerm.length);
    }

    showProfileSelectionPopup() {
        if (this.profiles.length === 0) {
            this.showToast('No aws-azure-login compatible profiles found. Please configure Azure AD SSO profiles first.', 'warning');
            return;
        }

        const overlay = document.createElement('div');
        overlay.className = 'popup-overlay';

        const popup = document.createElement('div');
        popup.className = 'popup-content';

        const profileListHtml = this.profiles.map(profile =>
            `<div class="profile-item" data-profile="${this.escapeHtml(profile.name)}" tabindex="0">
                <div class="profile-info">
                    <strong>${this.escapeHtml(profile.name)}</strong>
                    <span class="profile-region">${this.escapeHtml(profile.region)}</span>
                    ${profile.azureAppId ? `<span class="profile-azure">Azure SSO: ${this.escapeHtml(String(profile.azureAppId).split('/').pop())}</span>` : ''}
                </div>
                <i class="fas fa-chevron-right"></i>
            </div>`
        ).join('');

        popup.innerHTML = `
            <div class="popup-header">
                <h3>Select Azure AD SSO Profile</h3>
                <button class="popup-close" id="closePopup">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="popup-body">
                <p>Choose an AWS profile configured for Azure AD SSO authentication:</p>
                <div class="profile-list">
                    ${profileListHtml}
                </div>
                <div class="popup-footer-note">
                    <small><em>Only profiles compatible with aws-azure-login are shown</em></small>
                </div>
            </div>
        `;

        overlay.appendChild(popup);
        document.body.appendChild(overlay);

        document.getElementById('closePopup').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        popup.querySelectorAll('.profile-item').forEach(item => {
            item.addEventListener('click', async () => {
                const profileName = item.dataset.profile;
                overlay.remove();
                await this.authenticateWithProfile(profileName);
            });
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    item.click();
                }
            });
        });

        setTimeout(() => {
            const firstItem = popup.querySelector('.profile-item');
            if (firstItem) firstItem.focus();
        }, 100);
    }

    async authenticateWithProfile(profileName) {
        this.selectedAuthProfile = profileName;
        this.showToast(`Authenticating with Azure using ${profileName} profile...`, 'info');
        this.showLoading(true);

        this.updateConnectionStatus(false);
        const loginBtn = document.getElementById('loginBtn');
        loginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Authenticating...</span>';
        loginBtn.disabled = true;
        loginBtn.classList.add('authenticating');

        try {
            await window.electronAPI.azureAwsLogin(profileName);
            this.isLoggedIn = true;
            this.showToast('Successfully authenticated with Azure', 'success');
            this.updateConnectionStatus(true, profileName);
            this.updateProfileSelectState();
            this.startSessionWatcher();
        } catch (error) {
            this.showToast(`Authentication failed: ${error.error || error.message}`, 'error');
            this.handleAuthenticationFailure();
        } finally {
            this.showLoading(false);
            loginBtn.disabled = false;
            loginBtn.classList.remove('authenticating');
        }
    }

    handleAuthenticationFailure() {
        this.isLoggedIn = false;
        this.selectedAuthProfile = null;
        this.stopSessionWatcher();
        this.updateConnectionStatus(false);
        this.updateProfileSelectState();
    }

    // ==========================================================================
    // SESSION LIFECYCLE
    // ==========================================================================

    // Poll the credential expiry written by aws-azure-login and renew before it
    // lapses, so the user never hits an expired-session error mid-task.
    startSessionWatcher() {
        this.stopSessionWatcher();
        this.sessionWatcher = setInterval(() => this.checkSession(), 60000);
        this.checkSession();
    }

    stopSessionWatcher() {
        if (this.sessionWatcher) {
            clearInterval(this.sessionWatcher);
            this.sessionWatcher = null;
        }
    }

    async checkSession() {
        if (!this.isLoggedIn || this.isRefreshingSession) return;

        // Don't attempt a renewal more than once every 5 minutes. Without this a
        // profile whose expiry can't be advanced would trigger a login on every tick.
        const COOLDOWN_MS = 5 * 60 * 1000;
        if (this.lastRefreshAt && Date.now() - this.lastRefreshAt < COOLDOWN_MS) return;

        try {
            const status = await window.electronAPI.getSessionStatus(this.currentProfile);

            // No known expiry for the profiles in use — leave it to the reactive
            // retry path rather than guessing.
            if (!status || !status.success || status.expiresInMs === null) return;

            // Renew only when we're within 3 minutes of the real expiry
            const REFRESH_THRESHOLD_MS = 3 * 60 * 1000;
            if (status.expiresInMs > REFRESH_THRESHOLD_MS) return;

            this.isRefreshingSession = true;
            this.lastRefreshAt = Date.now();
            const result = await window.electronAPI.refreshSession();

            if (result && result.success) {
                // Silent by design: this is routine upkeep, not something the
                // user needs to be interrupted for.
                this.updateConnectionStatus(true, result.ssoProfile || this.selectedAuthProfile || '');
            } else {
                this.handleSessionExpired(result && result.error);
            }
        } catch (error) {
            // Non-fatal: the reactive retry in loadInstances still covers expiry
        } finally {
            this.isRefreshingSession = false;
        }
    }

    handleSessionExpired(message) {
        this.isLoggedIn = false;
        this.stopSessionWatcher();
        this.updateConnectionStatus(false);
        this.updateProfileSelectState();

        const text = message || 'Your AWS session has expired. Please sign in again with SSO Connect.';
        this.displayErrorState(text);
        this.showToast(text, 'warning');
    }

    selectOperationalProfile(profileName) {
        if (!this.isLoggedIn) {
            this.showToast('Please authenticate first', 'error');
            return;
        }

        if (profileName) {
            this.currentProfile = profileName;
            this.showToast(`Selected operational profile: ${profileName}`, 'info');
            this.loadInstances();
        } else {
            this.currentProfile = null;
            this.showWelcomeScreen();
        }
    }

    // ==========================================================================
    // VIEWS
    // ==========================================================================

    hideAllContent() {
        document.querySelectorAll('.content-view').forEach(view => {
            view.style.display = 'none';
        });
    }

    showWelcomeScreen() {
        this.hideAllContent();
        document.getElementById('welcomeScreen').style.display = 'flex';
    }

    showInstancesView() {
        this.hideAllContent();
        document.getElementById('serviceContent').style.display = 'flex';
    }

    // ==========================================================================
    // INSTANCE LOADING & RENDERING
    // ==========================================================================

    async loadInstances() {
        if (!this.currentProfile) {
            this.showToast('No profile selected', 'error');
            return;
        }

        this.showInstancesView();
        this.clearServiceData();
        this.showLoading(true);

        try {
            const result = await window.electronAPI.getEc2Instances(this.currentProfile);

            if (result && result.success) {
                // Main process may have silently re-authenticated to serve this call
                if (result.reauthenticated) {
                    this.isLoggedIn = true;
                    this.updateConnectionStatus(true, this.selectedAuthProfile || '');
                    this.startSessionWatcher();
                }

                this.displayInstances(result.data);

                if (result.ssmLookupFailed) {
                    this.showToast(
                        `Loaded ${result.data.length} instance(s) — SSM status unavailable, so connect buttons stay enabled`,
                        'warning'
                    );
                } else {
                    const renewed = result.reauthenticated ? ' — session renewed' : '';
                    this.showToast(`Loaded ${result.data.length} instance(s)${renewed}`, 'success');
                }
                return;
            }

            if (result && result.sessionExpired) {
                this.handleSessionExpired(result.error);
                return;
            }

            throw new Error(result?.error || 'No data returned');
        } catch (error) {
            const message = error.message || error.error || 'Unknown error occurred';
            this.showToast(`Failed to load instances: ${message}`, 'error');
            this.displayErrorState(message);
        } finally {
            this.showLoading(false);
        }
    }

    clearServiceData() {
        const container = document.getElementById('serviceData');
        if (container) container.innerHTML = '';
    }

    displayInstances(data) {
        const container = document.getElementById('serviceData');

        if (!data || data.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-inbox"></i>
                    <h3>No instances found</h3>
                    <p>No EC2 instances were found in the selected profile and region.</p>
                </div>
            `;
            return;
        }

        const searchContainer = this.createSearchContainer(data.length);
        const table = this.createInstanceTable(data);

        container.innerHTML = '';
        container.appendChild(searchContainer);
        container.appendChild(table);

        this.setupTableSearch(table, data.length);
    }

    createSearchContainer(totalCount) {
        const searchContainer = document.createElement('div');
        searchContainer.className = 'table-search-container';
        searchContainer.innerHTML = `
            <div class="table-search">
                <i class="fas fa-search"></i>
                <input type="text" id="tableSearch" placeholder="Search instances...">
                <span class="search-results-count" id="searchResultsCount">${totalCount} items</span>
            </div>
        `;
        return searchContainer;
    }

    setupTableSearch(table, totalCount) {
        const searchInput = document.getElementById('tableSearch');
        const resultsCount = document.getElementById('searchResultsCount');
        const tbody = table.querySelector('tbody');
        const rows = Array.from(tbody.querySelectorAll('tr'));

        searchInput.addEventListener('input', (e) => {
            const searchTerm = e.target.value.toLowerCase().trim();
            let visibleCount = 0;

            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                if (text.includes(searchTerm)) {
                    row.style.display = '';
                    visibleCount++;
                } else {
                    row.style.display = 'none';
                }
            });

            resultsCount.textContent = searchTerm
                ? `${visibleCount} of ${totalCount} items`
                : `${totalCount} items`;
        });
    }

    createInstanceTable(data) {
        const table = document.createElement('table');
        table.className = 'data-table';

        const headers = ['Instance Name', 'Instance ID', 'Type', 'State', 'SSM Agent', 'Public IP', 'Private IP', 'Platform', 'Actions'];
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        headers.forEach(header => {
            const th = document.createElement('th');
            th.textContent = header;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        data.forEach(item => tbody.appendChild(this.createInstanceRow(item)));
        table.appendChild(tbody);

        return table;
    }

    createInstanceRow(item) {
        const row = document.createElement('tr');
        const isRunning = item.state === 'running';
        const isWindows = item.platform && item.platform.toLowerCase().includes('windows');

        // A Session Manager connection only works if the instance is registered and
        // reachable. 'unknown' means the status could not be read (e.g. missing
        // permission), so connecting is still allowed rather than wrongly blocked.
        const ssmStatus = item.ssmStatus || 'unknown';
        const ssmConnectable = isRunning && (ssmStatus === 'online' || ssmStatus === 'unknown');

        const blockReason = this.escapeHtml(this.getSsmBlockReason(ssmStatus));

        // Buttons carry no instance data in their markup. The values are read from
        // the row's dataset by a listener attached below, so a hostile Name tag is
        // only ever text and can never be parsed as markup or script.
        let ssmButton;
        if (!isRunning) {
            ssmButton = `<button class="ssm-connect-btn" disabled title="Instance is not running">
                    <i class="fas fa-power-off"></i> Stopped
               </button>`;
        } else if (ssmConnectable) {
            ssmButton = `<button class="ssm-connect-btn" data-action="ssm">
                    <i class="fas fa-terminal"></i> SSM
               </button>`;
        } else {
            ssmButton = `<button class="ssm-connect-btn" disabled title="${blockReason}">
                    <i class="fas fa-unlink"></i> No SSM
               </button>`;
        }

        // RDP additionally requires a Windows instance
        const rdpButton = (ssmConnectable && isWindows)
            ? `<button class="rdp-connect-btn" data-action="rdp">
                    <i class="fas fa-desktop"></i> RDP
               </button>`
            : '';

        // Port forwarding rides the same SSM session, so it needs the same reachability
        const portButton = ssmConnectable
            ? `<button class="port-forward-btn" data-action="port">
                    <i class="fas fa-right-left"></i> Port
               </button>`
            : `<button class="port-forward-btn" disabled title="${blockReason}">
                    <i class="fas fa-right-left"></i> Port
               </button>`;

        row.innerHTML = `
            <td>${this.escapeHtml(item.instanceName || 'No Name')}</td>
            <td>${this.escapeHtml(item.instanceId)}</td>
            <td>${this.escapeHtml(item.instanceType)}</td>
            <td><span class="status-badge status-${this.escapeHtml(item.state)}">${this.escapeHtml(item.state)}</span></td>
            <td>${this.createSsmCell(item)}</td>
            <td>${this.escapeHtml(item.publicIp || '-')}</td>
            <td>${this.escapeHtml(item.privateIp || '-')}</td>
            <td>${this.escapeHtml(item.platform)}</td>
            <td class="actions-cell">
                <div class="action-buttons">
                    ${ssmButton}
                    ${rdpButton}
                    ${portButton}
                </div>
            </td>
        `;

        // dataset values are set as properties, never rendered into markup
        const instanceId = item.instanceId;
        const instanceName = item.instanceName || 'No Name';

        row.querySelectorAll('button[data-action]').forEach(button => {
            button.addEventListener('click', () => {
                switch (button.dataset.action) {
                    case 'ssm':
                        this.connectToInstance(instanceId, instanceName);
                        break;
                    case 'rdp':
                        this.connectToInstanceRDP(instanceId, instanceName);
                        break;
                    case 'port':
                        this.openPortForwardDialog(instanceId, instanceName);
                        break;
                }
            });
        });

        return row;
    }

    // Badge showing whether Systems Manager can reach this instance
    createSsmCell(item) {
        // SSM state is meaningless for an instance that isn't running
        if (item.state !== 'running') {
            return '<span class="ssm-badge ssm-na">—</span>';
        }

        const meta = {
            online:          { label: 'Online',          cls: 'ssm-online' },
            connection_lost: { label: 'Connection lost', cls: 'ssm-lost' },
            inactive:        { label: 'Inactive',        cls: 'ssm-inactive' },
            unmanaged:       { label: 'Not managed',     cls: 'ssm-unmanaged' },
            unknown:         { label: 'Unknown',         cls: 'ssm-unknown' }
        };

        const status = item.ssmStatus || 'unknown';
        const badge = meta[status] || meta.unknown;

        const details = [];
        if (item.ssmLastPing) {
            details.push(`Last ping: ${new Date(item.ssmLastPing).toLocaleString()}`);
        }
        if (item.ssmAgentVersion) {
            details.push(`Agent ${item.ssmAgentVersion}`);
        }
        if (status === 'unmanaged') {
            details.push('Not registered with Systems Manager — check the SSM agent and the instance IAM role.');
        }
        if (status === 'unknown') {
            details.push('SSM status could not be read (ssm:DescribeInstanceInformation permission may be missing).');
        }

        const title = this.escapeHtml(details.length ? details.join(' · ') : badge.label);
        return `<span class="ssm-badge ${badge.cls}" title="${title}">${badge.label}</span>`;
    }

    getSsmBlockReason(status) {
        switch (status) {
            case 'unmanaged':
                return 'This instance is not registered with Systems Manager. Install/start the SSM agent and attach an IAM role with AmazonSSMManagedInstanceCore.';
            case 'connection_lost':
                return 'The SSM agent is registered but has stopped responding, so a session cannot be started.';
            case 'inactive':
                return 'The SSM agent is inactive on this instance.';
            default:
                return 'Systems Manager cannot reach this instance.';
        }
    }

    displayErrorState(errorMessage) {
        const container = document.getElementById('serviceData');
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-exclamation-triangle"></i>
                <h3>Error Loading Data</h3>
                <p>${errorMessage}</p>
            </div>
        `;
    }

    // ==========================================================================
    // CONNECT ACTIONS
    // ==========================================================================

    async connectToInstance(instanceId, instanceName) {
        if (!this.currentProfile) {
            this.showToast('No profile selected', 'error');
            return;
        }

        const displayName = instanceName !== 'No Name' ? instanceName : instanceId;
        this.showToast(`Connecting to ${displayName} via SSM...`, 'info');
        this.showLoading(true);

        try {
            const result = await window.electronAPI.connectSSM(this.currentProfile, instanceId);
            if (result && result.success) {
                this.showToast(`SSM session started for ${displayName}`, 'success');
            } else {
                throw new Error(result?.error || 'Failed to start SSM session');
            }
        } catch (error) {
            this.showToast(`Failed to connect to ${displayName}: ${error.error || error.message}`, 'error');
        } finally {
            this.showLoading(false);
        }
    }

    async connectToInstanceRDP(instanceId, instanceName) {
        if (!this.currentProfile) {
            this.showToast('No profile selected', 'error');
            return;
        }

        const displayName = instanceName !== 'No Name' ? instanceName : instanceId;
        this.showToast(`Establishing RDP tunnel to ${displayName}...`, 'info');
        this.showLoading(true);

        try {
            const result = await window.electronAPI.connectRDPSSM(this.currentProfile, instanceId, instanceName);
            if (result && result.success) {
                this.showToast(
                    result.reused
                        ? `${displayName} is already tunnelled on port ${result.port}`
                        : `RDP tunnel established for ${displayName} on port ${result.port}`,
                    result.reused ? 'info' : 'success'
                );
            } else {
                throw new Error(result?.error || 'Failed to establish RDP tunnel');
            }
        } catch (error) {
            this.showToast(`Failed to connect to ${displayName}: ${error.error || error.message}`, 'error');
        } finally {
            this.showLoading(false);
        }
    }

    // ==========================================================================
    // UTILITIES
    // ==========================================================================

    showLoading(show) {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.style.display = show ? 'flex' : 'none';
    }

    showToast(message, type = 'info') {
        const toast = document.getElementById('toast');
        if (!toast) return;

        const icon = toast.querySelector('.toast-icon');
        const messageSpan = toast.querySelector('.toast-message');

        if (this.toastTimeout) clearTimeout(this.toastTimeout);
        toast.classList.remove('show');

        setTimeout(() => {
            toast.className = 'toast-notification';
            toast.classList.add(type);

            const icons = {
                'success': 'fas fa-check-circle',
                'error': 'fas fa-exclamation-circle',
                'info': 'fas fa-info-circle',
                'warning': 'fas fa-exclamation-triangle'
            };

            if (icon) icon.className = `toast-icon ${icons[type]}`;
            if (messageSpan) messageSpan.textContent = message;

            toast.classList.add('show');

            this.toastTimeout = setTimeout(() => {
                toast.classList.remove('show');
                this.toastTimeout = null;
            }, 4000);
        }, 100);
    }
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    new AWSManager();
});
