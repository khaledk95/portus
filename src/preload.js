const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // App metadata
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Is a newer release out? Notification only — nothing is downloaded or installed
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  openReleasePage: (url) => ipcRenderer.invoke('open-release-page', url),

  // Preflight for the external tools Portus shells out to
  checkRequiredTools: () => ipcRenderer.invoke('check-required-tools'),

  // Generic port forwarding over SSM
  startPortForward: (profileName, instanceId, instanceName, options) =>
    ipcRenderer.invoke('start-port-forward', profileName, instanceId, instanceName, options),

  // Active tunnels
  listTunnels: () => ipcRenderer.invoke('list-tunnels'),
  closeTunnel: (tunnelId) => ipcRenderer.invoke('close-tunnel', tunnelId),
  onTunnelsChanged: (callback) => {
    // Only the payload is forwarded; the IpcRendererEvent stays in preload
    const listener = (_event, tunnels) => callback(tunnels);
    ipcRenderer.on('tunnels-changed', listener);
    return () => ipcRenderer.removeListener('tunnels-changed', listener);
  },

  // AWS profiles, each tagged with the credential provider it uses
  getProfiles: () => ipcRenderer.invoke('get-profiles'),

  // What the sign-in dialog lists — Identity Center grouped by portal session
  getLoginTargets: () => ipcRenderer.invoke('get-login-targets'),

  // Start the login the profile's provider declares (Azure AD, Identity Center)
  signIn: (profileName) => ipcRenderer.invoke('sign-in', profileName),

  // Identity Center prints a code the user has to confirm in the browser
  onSsoVerification: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('sso-verification', listener);
    return () => ipcRenderer.removeListener('sso-verification', listener);
  },

  // A profile with mfa_serial cannot produce credentials until a code is entered
  onMfaRequired: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('mfa-required', listener);
    return () => ipcRenderer.removeListener('mfa-required', listener);
  },
  onMfaCancelled: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('mfa-cancelled', listener);
    return () => ipcRenderer.removeListener('mfa-cancelled', listener);
  },
  submitMfaCode: (id, code) => ipcRenderer.invoke('submit-mfa-code', { id, code }),

  // Session lifecycle
  getSessionStatus: (profileName) => ipcRenderer.invoke('get-session-status', profileName),
  refreshSession: (profileName) => ipcRenderer.invoke('refresh-session', profileName),

  // Regions this account has enabled, for the region picker
  getRegions: (profileName) => ipcRenderer.invoke('get-regions', profileName),

  // EC2 (target list for SSM / RDP). Region is the one picked in the UI; without
  // it the profile's configured region is used.
  getEc2Instances: (profileName, region) => ipcRenderer.invoke('get-ec2-instances', profileName, region),

  // Managed database endpoints suggested in the port forwarding dialog
  getEndpoints: (profileName, region) => ipcRenderer.invoke('get-endpoints', profileName, region),

  // SSM Connect
  connectSSM: (profileName, instanceId, region) =>
    ipcRenderer.invoke('connect-ssm', profileName, instanceId, region),

  // RDP over SSM Connect
  connectRDPSSM: (profileName, instanceId, instanceName, region) =>
    ipcRenderer.invoke('connect-rdp-ssm', profileName, instanceId, instanceName, region),
});
