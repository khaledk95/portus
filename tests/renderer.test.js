// The renderer, driven through the real markup.
//
// Everything here is a behaviour that has broken at least once: a method called
// but never defined, a flag written at the wrong moment, a dialog dismissed by a
// route that skipped its own cleanup, remote text reaching innerHTML. The
// main-process suites cannot see any of it.

const { bootRenderer, settle, profile, instance } = require('./helpers/renderer-harness');
const { createSuite } = require('./helpers/assert');

const suite = createSuite('Renderer');

const PROFILES = [
  profile('azure-corp', { provider: 'azure', providerLabel: 'Azure AD', canLogin: true }),
  profile('idc-prod', { provider: 'sso', providerLabel: 'Identity Center', canLogin: true, interactiveLogin: true, region: 'eu-west-1' }),
  profile('keys', { source: 'credentials', region: 'us-east-1' }),
  profile('vault', { provider: 'process', providerLabel: 'Credential process', region: 'ap-southeast-2' }),
  profile('assumed', { provider: 'assume-role', providerLabel: 'Assume role', region: 'us-east-2' })
];

const LOGIN_TARGETS = [
  { id: 'profile:azure-corp', label: 'azure-corp', provider: 'azure', providerLabel: 'Azure AD',
    profileName: 'azure-corp', profileCount: 4, region: 'eu-central-1' },
  { id: 'sso-session:mycompany', label: 'mycompany', provider: 'sso', providerLabel: 'Identity Center',
    profileName: 'idc-prod', profileCount: 2 }
];

const ENDPOINTS = [
  { id: '1', name: 'odd-postgres', host: 'odd-postgres.abc.eu-central-1.rds.amazonaws.com',
    port: 5433, service: 'postgresql', kind: 'RDS instance', tls: false },
  { id: '2', name: 'prod-aurora-pg', host: 'prod-aurora-pg.cluster-abc.eu-central-1.rds.amazonaws.com',
    port: 5432, service: 'postgresql', kind: 'Aurora writer', tls: false },
  { id: '3', name: 'session-cache', host: 'master.session-cache.abc.euc1.cache.amazonaws.com',
    port: 6379, service: 'redis', kind: 'ElastiCache primary', tls: true }
];

const XSS = 'evil"><img src=x onerror="window.__xss = true">';

const boot = (extra = {}) => bootRenderer({
  profiles: PROFILES,
  loginTargets: LOGIN_TARGETS,
  instances: [instance()],
  endpoints: ENDPOINTS,
  ...extra
});

const pick = async (app, name) => {
  app.document.getElementById('profileComboTrigger').click();
  await settle(app.window, 40);
  const option = [...app.document.querySelectorAll('#profileComboList .combo-option')]
    .find(el => el.querySelector('.opt-name').textContent.trim() === name);
  option.click();
  await settle(app.window, 120);
};

const openPortDialog = async (app, remote = true) => {
  app.document.querySelector('button[data-action="port"]').click();
  await settle(app.window, 40);
  if (remote) {
    [...app.document.querySelectorAll('#pfTarget button')]
      .find(b => b.dataset.target === 'remote').click();
    await settle(app.window, 120);
  }
};

(async () => {
  // ---------------------------------------------------------------------------
  suite.section('the app finishes starting');
  {
    const app = await boot();
    suite.check('it boots without an error', app.errors.length === 0, app.errors.map(String));
    suite.check('the splash is gone', !app.document.getElementById('splash'));
    suite.check('every profile is loaded', app.portus.profiles.length === 5, app.portus.profiles.length);
    suite.check('the picker is usable with no sign-in',
      app.document.getElementById('profileComboTrigger').disabled === false);
    suite.check('nothing was signed into', app.calls.signIns.length === 0, app.calls.signIns);
    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('a profile can be used without signing in');
  {
    const app = await boot();
    await pick(app, 'keys');

    suite.check('the profile is selected', app.portus.currentProfile === 'keys');
    suite.check('its instances loaded', app.portus.instances.length === 1);
    suite.check('a row is rendered',
      app.document.querySelectorAll('#instanceTableWrap tbody tr').length === 1);
    suite.check('still no sign-in', app.calls.signIns.length === 0, app.calls.signIns);
    suite.check('the status bar names the provider',
      /Access keys/.test(app.document.getElementById('statusSso').textContent));
    suite.check('the region follows the profile',
      app.document.getElementById('statusRegion').textContent === 'us-east-1');
    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('the filters are wired');
  // bindFilters was once called and never defined, which killed the whole app on
  // launch as an unhandled rejection.
  {
    const app = await boot({
      instances: [
        instance({ instanceId: 'i-run', instanceName: 'runner', state: 'running', platform: 'Linux' }),
        instance({ instanceId: 'i-stop', instanceName: 'stopper', state: 'stopped', platform: 'Windows' })
      ]
    });
    await pick(app, 'keys');

    const rows = () => app.document.querySelectorAll('#instanceTableWrap tbody tr').length;
    suite.check('both instances listed', rows() === 2, rows());

    app.document.querySelector('#filterState button[data-state="running"]').click();
    await settle(app.window);
    suite.check('the state filter narrows the list', rows() === 1, rows());

    app.document.querySelector('#filterState button[data-state="all"]').click();
    app.document.querySelector('#filterOs button[data-os="windows"]').click();
    await settle(app.window);
    suite.check('the OS filter narrows the list', rows() === 1, rows());

    app.document.querySelector('#filterOs button[data-os="all"]').click();
    await settle(app.window);
    suite.check('clearing restores it', rows() === 2, rows());
    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('the sign-in dialog offers logins, not profiles');
  {
    const app = await boot();
    app.document.getElementById('loginBtn').click();
    await settle(app.window, 40);

    const items = [...app.document.querySelectorAll('.overlay .profile-item')];
    const meta = items.map(i => i.querySelector('.pi-meta').textContent.trim());

    suite.check('two rows for five profiles', items.length === 2, items.length);
    suite.check('the session is named, not one of its profiles',
      items.some(i => i.querySelector('.pi-name').textContent.trim() === 'mycompany')
        && !items.some(i => i.querySelector('.pi-name').textContent.trim() === 'idc-prod'),
      items.map(i => i.querySelector('.pi-name').textContent.trim()));
    suite.check('each row says what the login covers',
      meta.includes('Identity Center · 2 profiles') && meta.includes('Azure AD · 4 profiles'), meta);

    items.find(i => i.dataset.profile === 'idc-prod').click();
    await settle(app.window, 120);
    suite.check('signing in uses a member profile', app.calls.signIns.join(',') === 'idc-prod', app.calls.signIns);
    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('the release notice is remembered when dismissed, not when shown');
  {
    const update = {
      available: true, current: '2.3.2', version: '2.3.3',
      notes: 'line one\nline two',
      url: 'https://github.com/khaledk95/portus/releases/tag/v2.3.3'
    };
    const app = await boot({ update });
    const seen = () => app.window.localStorage.getItem('portus.releaseSeen');

    suite.check('the notice appears at startup', !!app.document.getElementById('releaseOverlay'));
    suite.check('showing it alone records nothing', seen() === null, seen());
    suite.check('the notes keep their line breaks',
      app.document.getElementById('releaseNotes').textContent === 'line one\nline two');

    // quitting without touching it
    app.document.getElementById('releaseOverlay').remove();
    suite.check('an untouched notice stays unrecorded', seen() === null, seen());

    app.portus.announceRelease(update);
    await settle(app.window);
    suite.check('so it returns next launch', !!app.document.getElementById('releaseOverlay'));

    app.document.querySelector('#releaseOverlay [data-close]').click();
    await settle(app.window);
    suite.check('dismissing records it', seen() === '2.3.3', seen());

    app.portus.announceRelease(update);
    await settle(app.window);
    suite.check('and it does not return', !app.document.getElementById('releaseOverlay'));

    // Escape goes through the global overlay handler, which skips close()
    app.window.localStorage.removeItem('portus.releaseSeen');
    app.portus.announceRelease(update);
    await settle(app.window);
    app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(app.window);
    suite.check('Escape counts as dismissing', seen() === '2.3.3', seen());
    suite.check('and closes it', !app.document.getElementById('releaseOverlay'));

    app.window.localStorage.removeItem('portus.releaseSeen');
    app.portus.announceRelease(update);
    await settle(app.window);
    app.document.getElementById('releaseOpen').click();
    await settle(app.window, 60);
    suite.check('View release opens the page',
      app.calls.opened.length === 1 && app.calls.opened[0].endsWith('/tag/v2.3.3'), app.calls.opened);
    suite.check('and records it', seen() === '2.3.3', seen());
    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('the MFA prompt answers every way it can be closed');
  {
    const app = await boot();
    const answers = app.calls.mfaAnswers;

    app.listeners.mfa({ id: 'mfa-1', profileName: 'assumed' });
    await settle(app.window, 60);

    suite.check('the prompt appears', !!app.document.getElementById('mfaOverlay'));
    suite.check('it names the profile', /assumed/.test(app.document.getElementById('mfaOverlay').textContent));
    suite.check('Continue is disabled until six digits',
      app.document.getElementById('mfaSubmit').disabled === true);

    const type = (value) => {
      const input = app.document.getElementById('mfaCode');
      input.value = value;
      input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    };

    type('12ab34cd56');
    await settle(app.window);
    suite.check('non-digits are stripped and it caps at six',
      app.document.getElementById('mfaCode').value === '123456',
      app.document.getElementById('mfaCode').value);
    suite.check('Continue is enabled', app.document.getElementById('mfaSubmit').disabled === false);

    app.document.getElementById('mfaSubmit').click();
    await settle(app.window, 60);
    suite.check('the code goes back with its request id',
      answers.length === 1 && answers[0].id === 'mfa-1' && answers[0].code === '123456', answers);

    // cancelling must answer too, or the main process waits forever
    app.listeners.mfa({ id: 'mfa-2', profileName: 'assumed' });
    await settle(app.window, 40);
    app.document.querySelector('#mfaOverlay [data-cancel]').click();
    await settle(app.window, 60);
    suite.check('cancelling sends a null answer',
      answers.length === 2 && answers[1].code === null, answers[1]);

    app.listeners.mfa({ id: 'mfa-3', profileName: 'assumed' });
    await settle(app.window, 40);
    app.document.getElementById('mfaCode')
      .dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(app.window, 60);
    suite.check('Escape answers too', answers.length === 3 && answers[2].code === null, answers[2]);

    // a request that timed out in main closes its own dialog and no other
    app.listeners.mfa({ id: 'mfa-4', profileName: 'assumed' });
    await settle(app.window, 40);
    app.listeners.mfaCancelled({ id: 'mfa-older' });
    await settle(app.window);
    suite.check('a stale cancellation leaves the current prompt alone',
      !!app.document.getElementById('mfaOverlay'));
    app.listeners.mfaCancelled({ id: 'mfa-4' });
    await settle(app.window);
    suite.check('its own cancellation closes it', !app.document.getElementById('mfaOverlay'));
    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('the Azure role picker answers every way it can be closed');
  // The sign-in is blocked on this answer in the main process, so a dialog that
  // closes without sending one leaves the whole login hanging.
  {
    const app = await boot();
    const answers = app.calls.roleAnswers;

    app.listeners.roleChoice({
      id: 'role-1',
      profileName: 'azure-prod',
      roles: [
        'arn:aws:iam::111111111111:role/Admin',
        'arn:aws:iam::222222222222:role/team/ReadOnly'
      ]
    });
    await settle(app.window, 60);

    const overlay = () => app.document.getElementById('roleChoiceOverlay');
    suite.check('the picker appears', !!overlay());
    suite.check('it names the profile', /azure-prod/.test(overlay().textContent));

    const items = overlay().querySelectorAll('.profile-item');
    suite.check('every role is offered', items.length === 2, items.length);
    suite.check('the role name is shown rather than the whole ARN',
      items[0].querySelector('.pi-name').textContent === 'Admin',
      items[0].querySelector('.pi-name').textContent);
    suite.check('a path in the ARN does not become the name',
      items[1].querySelector('.pi-name').textContent === 'ReadOnly',
      items[1].querySelector('.pi-name').textContent);
    suite.check('the account is shown, since that is what distinguishes them',
      items[1].querySelector('.pi-meta').textContent === '222222222222',
      items[1].querySelector('.pi-meta').textContent);

    items[1].click();
    await settle(app.window, 60);
    suite.check('the full ARN goes back with its request id',
      answers.length === 1
        && answers[0].id === 'role-1'
        && answers[0].roleArn === 'arn:aws:iam::222222222222:role/team/ReadOnly', answers);
    suite.check('choosing closes the picker', !overlay());

    app.listeners.roleChoice({ id: 'role-2', profileName: 'azure-prod', roles: ['arn:aws:iam::1:role/A'] });
    await settle(app.window, 40);
    app.document.querySelector('#roleChoiceOverlay [data-cancel]').click();
    await settle(app.window, 60);
    suite.check('cancelling sends a null answer',
      answers.length === 2 && answers[1].roleArn === null, answers[1]);

    app.listeners.roleChoice({ id: 'role-3', profileName: 'azure-prod', roles: ['arn:aws:iam::1:role/A'] });
    await settle(app.window, 40);
    app.document.querySelector('#roleChoiceOverlay .profile-item')
      .dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(app.window, 60);
    suite.check('Escape answers too', answers.length === 3 && answers[2].roleArn === null, answers[2]);

    // one click, one answer — a double click must not settle a request twice
    app.listeners.roleChoice({ id: 'role-4', profileName: 'azure-prod', roles: ['arn:aws:iam::1:role/A'] });
    await settle(app.window, 40);
    const only = app.document.querySelector('#roleChoiceOverlay .profile-item');
    only.click();
    only.click();
    await settle(app.window, 60);
    suite.check('a second click on the same item is ignored', answers.length === 4, answers.length);

    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('the name, ID and address can be copied from the row');
  {
    const app = await boot({
      instances: [
        instance({ instanceName: 'bastion', instanceId: 'i-0abc123', privateIp: '10.0.1.24' }),
        instance({ instanceName: null, instanceId: 'i-0def456', privateIp: null })
      ]
    });
    await pick(app, 'keys');

    const copied = app.calls.copied;
    const rows = app.document.querySelectorAll('#instanceTableWrap tbody tr');
    const copyButtons = rows[0].querySelectorAll('button[data-copy]');

    suite.check('all three values are copyable', copyButtons.length === 3, copyButtons.length);
    suite.check('the cell still reads as the value, not as a control',
      copyButtons[0].textContent.trim() === 'bastion', copyButtons[0].textContent);

    for (const [index, expected] of [[0, 'bastion'], [1, 'i-0abc123'], [2, '10.0.1.24']]) {
      copyButtons[index].click();
      await settle(app.window, 40);
      suite.check(`${expected} reaches the clipboard`,
        copied[copied.length - 1] === expected, copied[copied.length - 1]);
    }

    // The row opens the detail panel; copying from it must not also do that
    suite.check('copying does not select the row',
      app.portus.selectedInstanceId === null, app.portus.selectedInstanceId);

    rows[0].click();
    await settle(app.window, 40);
    suite.check('the row itself still selects', app.portus.selectedInstanceId === 'i-0abc123');

    // Nothing to copy means nothing offered, and the dash stays a plain dash
    const secondRow = app.document.querySelectorAll('#instanceTableWrap tbody tr')[1];
    suite.check('a row missing a name and an address offers only the id',
      secondRow.querySelectorAll('button[data-copy]').length === 1,
      secondRow.querySelectorAll('button[data-copy]').length);
    suite.check('and shows a dash where each missing value would be',
      secondRow.cells[0].textContent.trim() === '—'
        && secondRow.cells[5].textContent.trim() === '—',
      [secondRow.cells[0].textContent.trim(), secondRow.cells[5].textContent.trim()]);

    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('endpoint discovery fills the port from the endpoint');
  {
    const app = await boot();
    await pick(app, 'keys');
    await openPortDialog(app);

    const rows = () => app.document.querySelectorAll('#pfHostList .endpoint-option');
    suite.check('endpoints are offered', rows().length === 3, rows().length);
    suite.check('they are fetched once, on demand', app.calls.endpointChecks === 1, app.calls.endpointChecks);

    app.document.querySelector('.chip[data-service="redis"]').click();
    await settle(app.window);
    suite.check('the service chip filters them', rows().length === 1, rows().length);

    app.document.querySelector('.chip[data-service="postgresql"]').click();
    await settle(app.window);
    const odd = [...rows()].find(r => r.querySelector('.opt-name').textContent === 'odd-postgres');
    odd.dispatchEvent(new app.window.MouseEvent('mousedown', { bubbles: true }));
    await settle(app.window);

    suite.check('picking one fills the host',
      app.document.getElementById('pfHost').value === 'odd-postgres.abc.eu-central-1.rds.amazonaws.com',
      app.document.getElementById('pfHost').value);
    suite.check('and its real port beats the service preset',
      app.document.getElementById('pfRemote').value === '5433',
      app.document.getElementById('pfRemote').value);

    app.document.getElementById('pfStart').click();
    await settle(app.window, 80);
    suite.check('the forward carries both',
      app.calls.forwards.length === 1
        && app.calls.forwards[0].remoteHost === 'odd-postgres.abc.eu-central-1.rds.amazonaws.com'
        && app.calls.forwards[0].remotePort === '5433',
      app.calls.forwards[0]);
    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('a host that was never discovered still works');
  {
    const app = await boot();
    await pick(app, 'keys');
    await openPortDialog(app);

    const host = app.document.getElementById('pfHost');
    host.value = 'internal-thing.corp.local';
    host.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    app.document.getElementById('pfRemote').value = '5432';
    await settle(app.window);

    app.document.getElementById('pfStart').click();
    await settle(app.window, 80);
    suite.check('a typed host is used verbatim',
      app.calls.forwards[0] && app.calls.forwards[0].remoteHost === 'internal-thing.corp.local',
      app.calls.forwards[0]);
    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('the tunnel uptime ticks while its view is open');
  {
    const app = await boot({
      tunnels: [{ id: 't1', kind: 'port', instanceId: 'i-1', instanceName: 'bastion-01',
                  port: 50001, remoteHost: 'db', remotePort: 5432, startedAt: Date.now() - 2000 }]
    });

    app.portus.showView('tunnels');
    await settle(app.window, 40);

    const cell = () => app.document.querySelector('#tunnelTableWrap tbody tr').children[4].textContent.trim();
    const before = cell();
    suite.check('uptime is shown in seconds', /^\d+s$/.test(before), before);
    suite.check('the ticker is running', !!app.portus.uptimeTicker);

    await settle(app.window, 1200);
    suite.check('it advances', cell() !== before, [before, cell()]);

    app.portus.showView('instances');
    await settle(app.window, 40);
    suite.check('and stops when the view is hidden', !app.portus.uptimeTicker);
    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('nothing from outside the app becomes markup');
  // Instance names, profile names, endpoint names and release notes all arrive
  // from AWS, from ~/.aws or over the network.
  {
    const app = await boot({
      profiles: [profile(XSS, { source: 'credentials' })],
      loginTargets: [],
      // The id and the address land inside attributes on the copy control, so a
      // quote in either would break out of it rather than just render oddly
      instances: [instance({ instanceName: XSS, instanceId: XSS, privateIp: XSS })],
      endpoints: [{ id: 'x', name: XSS, host: `${XSS}.rds.amazonaws.com`, port: 5432,
                    service: 'postgresql', kind: 'RDS instance', tls: false }],
      update: { available: true, current: '2.3.2', version: '9.9.9',
                notes: `<img src=x onerror="window.__xss = true">`,
                url: 'https://github.com/khaledk95/portus/releases/tag/v9.9.9' }
    });

    suite.check('release notes are text, not markup',
      !app.document.getElementById('releaseNotes').querySelector('img'),
      app.document.getElementById('releaseNotes').innerHTML.slice(0, 60));
    app.document.querySelector('#releaseOverlay [data-close]').click();
    await settle(app.window);

    app.document.getElementById('profileComboTrigger').click();
    await settle(app.window, 40);
    suite.check('a profile name is escaped',
      !app.document.getElementById('profileComboList').querySelector('img'));

    await pick(app, XSS);
    suite.check('an instance name is escaped',
      !app.document.querySelector('#instanceTableWrap tbody').querySelector('img'));

    // The value goes into data-copy, title and aria-label as well as the text
    const copyControl = app.document.querySelector('#instanceTableWrap button[data-copy]');
    suite.check('a hostile id does not break out of the copy attribute',
      copyControl && copyControl.dataset.copy === XSS, copyControl && copyControl.dataset.copy);
    suite.check('and copies back exactly what AWS reported, payload and all',
      (copyControl.click(), app.calls.copied[app.calls.copied.length - 1] === XSS),
      app.calls.copied[app.calls.copied.length - 1]);

    await openPortDialog(app);
    suite.check('an endpoint name is escaped',
      !app.document.getElementById('pfHostList').querySelector('img'));

    suite.check('and no payload ever fired', app.window.__xss !== true);
    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('the region starts from the profile and can be switched');
  {
    const app = await boot();
    const regionLabel = () => app.document.getElementById('regionComboLabel').textContent.trim();

    suite.check('the picker is disabled before a profile is chosen',
      app.document.getElementById('regionComboTrigger').disabled === true);

    await pick(app, 'keys');
    suite.check('it opens on the profile\'s own region',
      app.portus.currentRegion === 'us-east-1', app.portus.currentRegion);
    suite.check('the first instance request used it',
      app.calls.instanceRegions[0] === 'us-east-1', app.calls.instanceRegions);
    suite.check('the picker names the region', /us-east-1/.test(regionLabel()), regionLabel());
    suite.check('the picker is now usable',
      app.document.getElementById('regionComboTrigger').disabled === false);
    suite.check('the status bar agrees',
      app.document.getElementById('statusRegion').textContent === 'us-east-1');

    // switch
    app.document.getElementById('regionComboTrigger').click();
    await settle(app.window, 40);
    const options = [...app.document.querySelectorAll('#regionComboList .combo-option')];
    suite.check('every enabled region is offered', options.length === 3, options.length);
    suite.check('a known region shows its city',
      options.some(o => /Frankfurt/.test(o.textContent)), options.map(o => o.textContent.trim()));

    options.find(o => /eu-central-1/.test(o.textContent)).click();
    await settle(app.window, 120);

    suite.check('switching changes the region', app.portus.currentRegion === 'eu-central-1');
    suite.check('and reloads instances against it',
      app.calls.instanceRegions[app.calls.instanceRegions.length - 1] === 'eu-central-1',
      app.calls.instanceRegions);
    suite.check('the status bar follows',
      app.document.getElementById('statusRegion').textContent === 'eu-central-1');

    // a connect made after switching goes to the new region
    app.document.querySelector('button[data-action="ssm"]').click();
    await settle(app.window, 60);
    suite.check('an SSM session opens in the chosen region',
      app.calls.ssm[0] && app.calls.ssm[0].region === 'eu-central-1', app.calls.ssm);
    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('switching profiles goes back to that profile\'s region');
  {
    const app = await boot();
    await pick(app, 'keys');                       // configured us-east-1

    // Deliberately a region no other profile is configured for, so a carried-over
    // value cannot be mistaken for a correct reset.
    app.portus.chooseRegion('eu-central-1');
    await settle(app.window, 100);
    suite.check('a region was chosen', app.portus.currentRegion === 'eu-central-1');

    await pick(app, 'idc-prod');                   // configured eu-west-1
    suite.check('the new profile starts from its own region, not the one just chosen',
      app.portus.currentRegion === 'eu-west-1', app.portus.currentRegion);

    await pick(app, 'vault');                      // configured ap-southeast-2
    suite.check('and so does the next',
      app.portus.currentRegion === 'ap-southeast-2', app.portus.currentRegion);

    await pick(app, 'keys');
    suite.check('returning to the first profile returns to its region',
      app.portus.currentRegion === 'us-east-1', app.portus.currentRegion);
    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('endpoints are looked up per region, not per profile');
  {
    const app = await boot();
    await pick(app, 'keys');

    await openPortDialog(app);
    suite.check('endpoints fetched for the starting region',
      app.calls.endpointRegions[0] === 'us-east-1', app.calls.endpointRegions);
    app.document.querySelectorAll('.overlay').forEach(o => o.remove());

    app.portus.chooseRegion('eu-central-1');
    await settle(app.window, 120);

    await openPortDialog(app);
    suite.check('switching region re-fetches rather than reusing the old list',
      app.calls.endpointChecks === 2, app.calls.endpointChecks);
    suite.check('and asks for the new region',
      app.calls.endpointRegions[1] === 'eu-central-1', app.calls.endpointRegions);
    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('a region list that could not be read still leaves one usable');
  {
    const app = await boot();
    app.state.regionsResult = {
      success: true,
      data: [{ name: 'us-east-1', label: 'N. Virginia' }],
      configured: 'us-east-1',
      limited: true,
      reason: 'not authorized to perform ec2:DescribeRegions'
    };
    await pick(app, 'keys');

    suite.check('the profile\'s region is still selected', app.portus.currentRegion === 'us-east-1');
    suite.check('the picker is enabled with the one region',
      app.document.getElementById('regionComboTrigger').disabled === false);
    suite.check('and says why it is short',
      /DescribeRegions/.test(app.document.getElementById('regionComboTrigger').title),
      app.document.getElementById('regionComboTrigger').title);
    suite.check('instances still loaded', app.portus.instances.length === 1);
    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('a failure leaves the app usable');
  {
    const app = await boot();
    app.state.instancesResult = { success: false, error: 'Could not load credentials from any providers' };
    await pick(app, 'keys');

    suite.check('it reports not connected', app.portus.isLoggedIn === false);
    suite.check('the picker still works',
      app.document.getElementById('profileComboTrigger').disabled === false);
    // setInstanceEmpty rebuilds the block, so the id from index.html is gone
    const emptyText = app.document.querySelector('#instanceTableWrap .empty p');
    suite.check('the reason is shown',
      emptyText && /Could not load credentials/.test(emptyText.textContent),
      emptyText && emptyText.textContent);

    app.state.instancesResult = null;
    await pick(app, 'keys');
    suite.check('and it recovers on retry', app.portus.isLoggedIn === true);
    app.window.close();
  }

  suite.done();
})().catch(error => {
  console.error('\n  the suite threw:', error && error.stack);
  process.exit(1);
});
