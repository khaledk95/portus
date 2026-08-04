const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // App metadata
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

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

  // AWS Profile Management
  getAwsProfiles: () => ipcRenderer.invoke('get-aws-profiles'),
  getOperationalProfiles: () => ipcRenderer.invoke('get-operational-profiles'),

  // Azure AD SSO Login
  azureAwsLogin: (profileName) => ipcRenderer.invoke('azure-aws-login', profileName),

  // Session lifecycle
  getSessionStatus: (profileName) => ipcRenderer.invoke('get-session-status', profileName),
  refreshSession: (profileName) => ipcRenderer.invoke('refresh-session', profileName),

  // EC2 (target list for SSM / RDP)
  getEc2Instances: (profileName) => ipcRenderer.invoke('get-ec2-instances', profileName),

  // Managed database endpoints suggested in the port forwarding dialog
  getEndpoints: (profileName) => ipcRenderer.invoke('get-endpoints', profileName),

  // SSM Connect
  connectSSM: (profileName, instanceId) => ipcRenderer.invoke('connect-ssm', profileName, instanceId),

  // RDP over SSM Connect
  connectRDPSSM: (profileName, instanceId, instanceName) => ipcRenderer.invoke('connect-rdp-ssm', profileName, instanceId, instanceName),
});
