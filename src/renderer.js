class AWSManager {
    constructor() {
        this.currentProfile = null;
        this.profiles = [];            // Azure AD SSO profiles (for login)
        this.operationalProfiles = []; // non-SSO profiles (for instance ops)
        this.isLoggedIn = false;
        this.selectedAuthProfile = null;
        this.toastTimeout = null;
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
        await this.loadProfiles();
        this.updateInitialUI();
        window.awsManager = this;
    }

    // ==========================================================================
    // EVENT LISTENERS
    // ==========================================================================

    setupEventListeners() {
        const profileSelect = document.getElementById('profileSelect');
        if (profileSelect) {
            profileSelect.addEventListener('change', (e) => {
                this.selectOperationalProfile(e.target.value);
            });
        }

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

        const select = document.getElementById('profileSelect');
        select.disabled = true;
        select.style.opacity = '0.6';
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
        const select = document.getElementById('profileSelect');
        select.disabled = !this.isLoggedIn;
        select.style.opacity = this.isLoggedIn ? '1' : '0.6';
    }

    // ==========================================================================
    // PROFILE LOADING & AUTHENTICATION
    // ==========================================================================

    async loadProfiles() {
        try {
            this.profiles = await window.electronAPI.getAwsProfiles();
            this.operationalProfiles = await window.electronAPI.getOperationalProfiles();
            this.populateProfileSelect();
        } catch (error) {
            this.showToast('Failed to load AWS profiles: ' + error.message, 'error');
        }
    }

    populateProfileSelect() {
        const select = document.getElementById('profileSelect');
        select.innerHTML = '';

        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = 'Select Operational Profile';
        select.appendChild(defaultOption);

        if (this.operationalProfiles && this.operationalProfiles.length > 0) {
            this.operationalProfiles.forEach(profile => {
                const option = document.createElement('option');
                option.value = profile.name;
                option.textContent = `${profile.name} (${profile.region})`;
                select.appendChild(option);
            });
        } else {
            const noProfilesOption = document.createElement('option');
            noProfilesOption.value = '';
            noProfilesOption.textContent = 'No operational profiles available';
            noProfilesOption.disabled = true;
            select.appendChild(noProfilesOption);
        }
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
            `<div class="profile-item" data-profile="${profile.name}" tabindex="0">
                <div class="profile-info">
                    <strong>${profile.name}</strong>
                    <span class="profile-region">${profile.region}</span>
                    ${profile.azureAppId ? `<span class="profile-azure">Azure SSO: ${profile.azureAppId.split('/').pop()}</span>` : ''}
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
        this.updateConnectionStatus(false);
        this.updateProfileSelectState();
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
                this.displayInstances(result.data);
                this.showToast(`Loaded ${result.data.length} instance(s)`, 'success');
            } else {
                throw new Error(result?.error || 'No data returned');
            }
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

        const headers = ['Instance Name', 'Instance ID', 'Type', 'State', 'Public IP', 'Private IP', 'Platform', 'Launch Time', 'Actions'];
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
        const safeName = (item.instanceName || 'No Name').replace(/'/g, "\\'");

        // SSM button - any running instance
        const ssmButton = isRunning
            ? `<button class="ssm-connect-btn" onclick="window.awsManager.connectToInstance('${item.instanceId}', '${safeName}')">
                    <i class="fas fa-terminal"></i> SSM
               </button>`
            : `<button class="ssm-connect-btn" disabled>
                    <i class="fas fa-power-off"></i> Stopped
               </button>`;

        // RDP button - running Windows instances only
        const rdpButton = (isRunning && isWindows)
            ? `<button class="rdp-connect-btn" onclick="window.awsManager.connectToInstanceRDP('${item.instanceId}', '${safeName}')">
                    <i class="fas fa-desktop"></i> RDP
               </button>`
            : '';

        row.innerHTML = `
            <td>${item.instanceName || 'No Name'}</td>
            <td>${item.instanceId}</td>
            <td>${item.instanceType}</td>
            <td><span class="status-badge status-${item.state}">${item.state}</span></td>
            <td>${item.publicIp || '-'}</td>
            <td>${item.privateIp || '-'}</td>
            <td>${item.platform}</td>
            <td>${new Date(item.launchTime).toLocaleString()}</td>
            <td class="actions-cell">
                <div class="action-buttons">
                    ${ssmButton}
                    ${rdpButton}
                </div>
            </td>
        `;

        return row;
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
                this.showToast(`RDP tunnel established for ${displayName} on port ${result.port}`, 'success');
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
