const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // App metadata
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

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

  // SSM Connect
  connectSSM: (profileName, instanceId) => ipcRenderer.invoke('connect-ssm', profileName, instanceId),

  // RDP over SSM Connect
  connectRDPSSM: (profileName, instanceId, instanceName) => ipcRenderer.invoke('connect-rdp-ssm', profileName, instanceId, instanceName),
});
