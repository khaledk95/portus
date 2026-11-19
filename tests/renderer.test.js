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
  suite.section('a dismissed release is still visible as a badge');
  // Dismissing used to end it: the update was invisible until a newer release
  // came along, with nothing to click back to.
  {
    const update = {
      available: true, current: '2.3.3', version: '2.4.0',
      notes: 'line one\nline two',
      url: 'https://github.com/khaledk95/portus/releases/tag/v2.4.0'
    };
    const app = await boot({ update });
    const chip = () => app.document.querySelector('.js-app-version');

    suite.check('the chip is marked while the dialog is up',
      chip().classList.contains('has-update'), chip().className);

    app.document.querySelector('#releaseOverlay [data-close]').click();
    await settle(app.window);

    suite.check('and stays marked after dismissing',
      chip().classList.contains('has-update'), chip().className);
    suite.check('it says which version, so the mark is not a mystery',
      /2\.4\.0/.test(chip().getAttribute('title') || ''), chip().getAttribute('title'));
    suite.check('and is reachable by keyboard',
      chip().getAttribute('role') === 'button' && chip().getAttribute('tabindex') === '0');

    chip().click();
    await settle(app.window, 60);
    suite.check('clicking it brings the notes back',
      !!app.document.getElementById('releaseOverlay')
        && /line one/.test(app.document.getElementById('releaseNotes').textContent));

    // Reopening must not stack dialogs
    chip().click();
    await settle(app.window, 60);
    suite.check('and does not open a second one',
      app.document.querySelectorAll('#releaseOverlay').length === 1,
      app.document.querySelectorAll('#releaseOverlay').length);

    app.window.close();
  }

  {
    // The cached answer outlives the version it was about. Trusting it would
    // leave the badge on after the update it was telling you to install.
    const app = await boot({ update: { available: true, current: '2.3.2', version: '2.0.0' } });
    const chip = app.document.querySelector('.js-app-version');

    suite.check('a release older than the one running is not badged',
      !chip.classList.contains('has-update'), chip.className);
    suite.check('and the chip stays inert',
      !chip.getAttribute('role'), chip.getAttribute('role'));
    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('the release check runs once a day, not once a launch');
  {
    const update = { available: true, current: '2.3.3', version: '2.4.0', notes: 'x' };

    const first = await boot({ update });
    suite.check('a cold start asks GitHub', first.calls.updateChecks === 1, first.calls.updateChecks);

    const cached = JSON.parse(first.window.localStorage.getItem('portus.updateCheck'));
    suite.check('and records what it found, with when',
      cached && cached.result.version === '2.4.0' && typeof cached.checkedAt === 'number', cached);
    first.window.close();

    // A launch later the same day, carrying that storage forward
    const soon = await boot({ update, storage: { 'portus.updateCheck': JSON.stringify({
      checkedAt: Date.now() - 60 * 60 * 1000, result: update
    }) } });
    suite.check('a launch an hour later asks nothing',
      soon.calls.updateChecks === 0, soon.calls.updateChecks);
    suite.check('but still knows an update is waiting',
      soon.document.querySelector('.js-app-version').classList.contains('has-update'));
    soon.window.close();

    const old = await boot({ update, storage: { 'portus.updateCheck': JSON.stringify({
      checkedAt: Date.now() - 25 * 60 * 60 * 1000, result: update
    }) } });
    suite.check('a day later it asks again', old.calls.updateChecks === 1, old.calls.updateChecks);
    old.window.close();

    // A clock that moved backwards would otherwise read as fresh forever
    const future = await boot({ update, storage: { 'portus.updateCheck': JSON.stringify({
      checkedAt: Date.now() + 60 * 60 * 1000, result: update
    }) } });
    suite.check('a timestamp in the future is not treated as fresh',
      future.calls.updateChecks === 1, future.calls.updateChecks);
    future.window.close();

    const broken = await boot({ update, storage: { 'portus.updateCheck': 'not json' } });
    suite.check('and neither is unreadable storage',
      broken.calls.updateChecks === 1, broken.calls.updateChecks);
    broken.window.close();
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

    // -------------------------------------------------------------------------
    // The panel is part of the layout rather than an overlay, so without this
    // the only way out of it was reloading the list.

    const panel = app.document.getElementById('detailPanel');
    suite.check('selecting a row opens the detail panel',
      panel.style.display !== 'none', panel.style.display);

    suite.check('the key pair named at launch is shown',
      /platform-keypair/.test(app.document.getElementById('detailBody').textContent),
      app.document.getElementById('detailBody').textContent.replace(/\s+/g, ' ').slice(0, 160));

    // Inside the panel is not "away from" it
    panel.click();
    await settle(app.window, 40);
    suite.check('clicking inside the panel keeps it open',
      app.portus.selectedInstanceId === 'i-0abc123', app.portus.selectedInstanceId);

    // Another row selects that instance rather than closing
    app.document.querySelectorAll('#instanceTableWrap tbody tr')[1].click();
    await settle(app.window, 40);
    suite.check('clicking another row moves the selection, it does not close',
      app.portus.selectedInstanceId === 'i-0def456', app.portus.selectedInstanceId);

    // And anywhere else closes it
    app.document.getElementById('instanceCount').click();
    await settle(app.window, 40);
    suite.check('clicking away closes it',
      app.portus.selectedInstanceId === null, app.portus.selectedInstanceId);
    suite.check('and the panel is hidden again',
      app.document.getElementById('detailPanel').style.display === 'none',
      app.document.getElementById('detailPanel').style.display);

    // Escape is the other obvious gesture, once nothing is in front of it
    app.document.querySelectorAll('#instanceTableWrap tbody tr')[0].click();
    await settle(app.window, 40);
    app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(app.window, 40);
    suite.check('Escape closes it too', app.portus.selectedInstanceId === null,
      app.portus.selectedInstanceId);

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

  // ---------------------------------------------------------------------------
  suite.section('the page grants scripts and connections nothing it does not use');
  // jsdom does not enforce CSP, so this pins the policy string itself — the
  // same readFileSync+regex convention as release-check.test.js. The app ships
  // exactly one script element (the external renderer.js) and every AWS call
  // goes over ipcRenderer.invoke, so inline script and https: connections are
  // grants nothing uses; any future escaping regression would use them.
  {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'index.html'), 'utf8');
    const policy = (source.match(/Content-Security-Policy"\s+content="([^"]+)"/) || [])[1] || '';
    const scriptSrc = (policy.match(/script-src([^;]*);/) || [])[1] || '';
    const connectSrc = (policy.match(/connect-src([^;]*);/) || [])[1] || '';

    suite.check('script-src does not allow inline script',
      !/'unsafe-inline'/.test(scriptSrc), scriptSrc.trim());
    suite.check('connect-src is the app itself, not every https host',
      connectSrc.trim() === "'self'", connectSrc.trim());
  }

  // ---------------------------------------------------------------------------
  suite.section('an instance with no SSM agent can still be reached through one');
  // Its row used to be a dead "No SSM" button. If something managed is running
  // in the same VPC, there is a route — so the row offers it.

  {
    const app = await boot({
      instances: [
        instance({ instanceName: 'bastion-01', instanceId: 'i-0hop00000000001', subnetId: 'subnet-b' }),
        instance({ instanceName: 'same-subnet-hop', instanceId: 'i-0hop00000000002', subnetId: 'subnet-a' }),
        instance({ instanceName: 'other-vpc-hop', instanceId: 'i-0hop00000000003',
          vpcId: 'vpc-999', subnetId: 'subnet-z' }),
        instance({ instanceName: 'legacy-win', instanceId: 'i-0target00000001',
          platform: 'Windows', privateIp: '10.0.2.57', subnetId: 'subnet-a',
          ssmStatus: 'unmanaged', ssmAgentVersion: null, ssmPlatformName: null })
      ]
    });
    await pick(app, 'keys');

    const rowFor = (id) => [...app.document.querySelectorAll('tbody tr')]
      .find(tr => tr.textContent.includes(id));

    const targetRow = rowFor('i-0target00000001');
    const viaButton = targetRow.querySelector('button[data-action="via"]');

    suite.check('the unmanaged row offers a way in',
      !!viaButton, targetRow.querySelector('.row-actions').textContent.trim());
    suite.check('and the SSM column still reports the truth',
      /not managed/i.test(targetRow.textContent), targetRow.textContent.replace(/\s+/g, ' ').slice(0, 120));

    // Ranking, read straight off the dialog so it is the order a user sees
    viaButton.click();
    await settle(app.window, 60);

    const options = [...app.document.querySelectorAll('#hopPick option')];
    const labels = options.map(option => option.textContent.replace(/\s+/g, ' ').trim());

    suite.check('a hop in another VPC is not offered, since it cannot reach the address',
      !labels.some(label => /other-vpc-hop/.test(label)), labels);
    suite.check('the same-subnet hop is preselected',
      /same-subnet-hop/.test(labels[0]) && options[0].selected, labels);
    suite.check('and it is marked as such',
      /same subnet/.test(labels[0]), labels[0]);
    suite.check('the rest of the VPC is still available',
      labels.some(label => /bastion-01/.test(label)), labels);

    // Windows, so Remote Desktop leads and the port field is out of the way
    suite.check('Remote Desktop is the default for a Windows target',
      app.document.querySelector('#hopMode button.on').dataset.mode === 'rdp',
      app.document.querySelector('#hopMode button.on').textContent.trim());

    app.document.querySelector('#hopStart').click();
    await settle(app.window, 80);

    const call = app.calls.rdp[app.calls.rdp.length - 1];

    suite.check('connecting asks for the target, carrying the hop with it',
      call && call.instanceId === 'i-0target00000001'
        && call.options.via.instanceId === 'i-0hop00000000002'
        && call.options.via.targetHost === '10.0.2.57',
      call);

  }

  {
    // A Linux target has no RDP client to launch, so the only offer is a port
    // forward — and ssh stays the user's to run, since Portus holds no keys.
    const app = await boot({
      instances: [
        instance({ instanceName: 'bastion-01', instanceId: 'i-0hop00000000001' }),
        instance({ instanceName: 'legacy-linux', instanceId: 'i-0target00000002',
          privateIp: '10.0.2.58', ssmStatus: 'unmanaged' })
      ]
    });
    await pick(app, 'keys');

    [...app.document.querySelectorAll('tbody tr')]
      .find(tr => tr.textContent.includes('i-0target00000002'))
      .querySelector('button[data-action="via"]')
      .click();
    await settle(app.window, 60);

    suite.check('no Remote Desktop option for a Linux target',
      !app.document.querySelector('#hopMode button[data-mode="rdp"]'),
      app.document.querySelector('#hopMode').textContent.trim());
    suite.check('a port forward is selected, defaulting to ssh',
      app.document.querySelector('#hopMode button.on').dataset.mode === 'port'
        && app.document.querySelector('#hopPort').value === '22');
    suite.check('and the dialog says Portus will not run ssh for you',
      /your own ssh/i.test(app.document.querySelector('#hopPortHint').textContent),
      app.document.querySelector('#hopPortHint').textContent);

    app.document.querySelector('#hopStart').click();
    await settle(app.window, 80);

    const call = app.calls.forwardTargets[app.calls.forwardTargets.length - 1];

    suite.check('the forward runs on the hop, with the target as the far end',
      call && call.instanceId === 'i-0hop00000000001'
        && call.options.remoteHost === '10.0.2.58'
        && String(call.options.remotePort) === '22'
        && call.options.target.instanceId === 'i-0target00000002',
      call);

  }

  {
    // Nothing managed in the VPC means there is genuinely no route, and saying
    // so is better than a dialog with an empty dropdown.
    const app = await boot({
      instances: [
        instance({ instanceName: 'legacy-linux', instanceId: 'i-0target00000003',
          privateIp: '10.0.2.59', ssmStatus: 'unmanaged' })
      ]
    });
    await pick(app, 'keys');

    const row = app.document.querySelector('tbody tr');
    suite.check('with no hop available the row stays disabled',
      !row.querySelector('button[data-action="via"]')
        && row.querySelector('.row-actions button').disabled === true,
      row.querySelector('.row-actions').textContent.trim());

  }

  // ---------------------------------------------------------------------------
  suite.section('the port dialog no longer offers clusters');
  // It used to, and could only ever give a tunnel: a cluster picked here had
  // no kubeconfig written for it, so no kubectl button appeared. Clusters have
  // their own view now, which knows the cluster's VPC and writes the config.
  //
  // Both halves matter. Removing the preset while discovery still returned
  // clusters would leave them pickable from the host list and recreate exactly
  // that gap.
  {
    const app = await boot({
      instances: [instance({ instanceName: 'bastion-01', instanceId: 'i-0abc123' })],
      endpoints: [
        { id: '1', name: 'orders-prod', kind: 'Aurora writer', service: 'postgresql',
          host: 'orders-prod.cluster-abc.eu-central-1.rds.amazonaws.com', port: 5432, tls: true },
        { id: 'eks:local-prod', name: 'local-prod', kind: 'EKS cluster', service: 'kubernetes',
          host: 'LOCAL1234.gr7.eu-central-1.eks.amazonaws.com', port: 443, tls: true,
          kubernetes: { clusterName: 'local-prod' } }
      ]
    });
    await pick(app, 'keys');

    app.document.querySelector('button[data-action="port"]').click();
    await settle(app.window, 40);

    const services = [...app.document.querySelectorAll('#pfChips .chip')]
      .map(chip => chip.dataset.service);
    suite.check('there is no EKS preset',
      !services.includes('kubernetes'), services);

    [...app.document.querySelectorAll('#pfTarget button')]
      .find(b => b.dataset.target === 'remote').click();
    await settle(app.window, 250);

    const listed = [...app.document.querySelectorAll('#pfHostList .endpoint-option')]
      .map(el => el.textContent.replace(/\s+/g, ' ').trim());

    suite.check('a database is still offered',
      listed.some(label => /orders-prod/.test(label)), listed);
    suite.check('and a cluster is not, so none can be picked here',
      !listed.some(label => /local-prod/.test(label)), listed);

    // Typing a cluster's host still forwards a port — that is a plain tunnel,
    // which is all this dialog ever promised
    const host = app.document.getElementById('pfHost');
    host.value = 'LOCAL1234.gr7.eu-central-1.eks.amazonaws.com';
    host.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    app.document.getElementById('pfRemote').value = '443';
    await settle(app.window, 80);

    app.document.getElementById('pfStart').click();
    await settle(app.window, 120);

    const sent = app.calls.forwards[app.calls.forwards.length - 1];
    suite.check('a typed host still forwards',
      sent && sent.remoteHost === 'LOCAL1234.gr7.eu-central-1.eks.amazonaws.com', sent);
    suite.check('and nothing claims to be a cluster',
      !sent.kubernetes, sent);

    app.window.close();
  }

  // ---------------------------------------------------------------------------
  suite.section('the EKS tab lists clusters and connects to one');
  // Reaching a cluster used to mean knowing which instance sat in its VPC and
  // going through the port dialog. The tab knows the VPC, so it can work the
  // hop out — that is the whole point of it.

  const CLUSTER = (over = {}) => ({
    id: 'eks:platform-prod', name: 'platform-prod',
    host: 'ABCD1234P.gr7.eu-central-1.eks.amazonaws.com',
    port: 443, service: 'kubernetes', kind: 'EKS cluster',
    engineVersion: '1.31', status: 'ACTIVE', tls: true,
    vpcId: 'vpc-123', endpointPublicAccess: false, endpointPrivateAccess: true,
    kubernetes: { clusterName: 'platform-prod' }, ...over
  });

  {
    const app = await boot({
      instances: [
        instance({ instanceName: 'bastion-01', instanceId: 'i-0hop00000000001' }),
        instance({ instanceName: 'eks-node-01', instanceId: 'i-0node0000000001',
          tags: [{ key: 'eks:cluster-name', value: 'platform-prod' }] }),
        // Right account, wrong VPC: it cannot reach the endpoint
        instance({ instanceName: 'other-vpc', instanceId: 'i-0other000000001', vpcId: 'vpc-999' })
      ],
      clusters: [
        CLUSTER(),
        CLUSTER({ id: 'eks:sandbox', name: 'sandbox', kubernetes: { clusterName: 'sandbox' },
          endpointPublicAccess: true, endpointPrivateAccess: false }),
        CLUSTER({ id: 'eks:legacy', name: 'legacy', kubernetes: { clusterName: 'legacy' },
          status: 'UPDATING' }),
        CLUSTER({ id: 'eks:lonely', name: 'lonely', kubernetes: { clusterName: 'lonely' },
          vpcId: 'vpc-nothing-here' })
      ]
    });
    await pick(app, 'keys');

    suite.check('nothing is listed before the tab is opened',
      app.calls.clusterLookups.length === 0, app.calls.clusterLookups);

    app.document.querySelector('.nav-item[data-view="eks"]').click();
    await settle(app.window, 250);

    suite.check('opening it lists them, from the selected account',
      app.calls.clusterLookups.length === 1
        && app.calls.clusterLookups[0].profileName === 'keys',
      app.calls.clusterLookups);
    suite.check('and the sidebar counts them',
      app.document.getElementById('navClusterCount').textContent === '4',
      app.document.getElementById('navClusterCount').textContent);

    const rowFor = (name) => [...app.document.querySelectorAll('#clusterTableWrap tbody tr')]
      .find(tr => tr.textContent.includes(name));

    // A node of the cluster is the safest hop: right VPC by definition, and
    // already talking to the API server
    const hops = [...rowFor('platform-prod').querySelectorAll('[data-hop] option')]
      .map(option => option.textContent.trim());
    suite.check('a node of the cluster is offered first',
      /eks-node-01/.test(hops[0]) && /node/.test(hops[0]), hops);
    suite.check('an instance in another VPC is not offered at all',
      !hops.some(label => /other-vpc/.test(label)), hops);

    suite.check('a public cluster is not offered a tunnel it does not need',
      /No tunnel needed/.test(rowFor('sandbox').textContent), rowFor('sandbox').textContent.trim());
    suite.check('a cluster mid-update cannot be connected to',
      /Unavailable/.test(rowFor('legacy').textContent), rowFor('legacy').textContent.trim());
    // Nothing is in that cluster's VPC. That is not "no route" — a cluster in
    // another account is reached over peering, so the instance carrying it is
    // in a different VPC by definition, and that is the case this tab exists
    // to make easy. Candidates are offered, marked as unchecked.
    suite.check('a cluster in no known VPC still offers the managed instances',
      !!rowFor('lonely').querySelector('[data-hop]')
        && !!rowFor('lonely').querySelector('[data-connect]'),
      rowFor('lonely').textContent.replace(/\s+/g, ' ').trim());
    suite.check('and says the route could not be checked',
      /unverified/.test(rowFor('lonely').textContent),
      rowFor('lonely').textContent.replace(/\s+/g, ' ').trim());
    suite.check('while a cluster with instances in its own VPC says nothing of the sort',
      !/unverified/.test(rowFor('platform-prod').textContent),
      rowFor('platform-prod').textContent.replace(/\s+/g, ' ').trim());

    // Connect: one click, no dialog
    rowFor('platform-prod').querySelector('[data-connect]').click();
    await settle(app.window, 150);

    const sent = app.calls.forwardTargets[app.calls.forwardTargets.length - 1];
    suite.check('connecting runs the tunnel on the chosen hop',
      sent && sent.instanceId === 'i-0node0000000001', sent);
    // Acting on a row is not selecting it — otherwise the detail panel opens
    // behind every Connect
    suite.check('and does not open the detail panel behind it',
      app.portus.selectedClusterName === null, app.portus.selectedClusterName);
    suite.check('pointed at the cluster endpoint on 443',
      sent.options.remoteHost === 'ABCD1234P.gr7.eu-central-1.eks.amazonaws.com'
        && String(sent.options.remotePort) === '443',
      sent.options);
    suite.check('and marked as the cluster, so a kubeconfig is written',
      sent.options.kubernetes && sent.options.kubernetes.clusterName === 'platform-prod'
        && sent.options.kubernetes.profileName === 'keys',
      sent.options.kubernetes);

    // Overriding the hop is the escape hatch for a wrong guess
    const picker = rowFor('platform-prod').querySelector('[data-hop]');
    picker.value = 'i-0hop00000000001';
    picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await settle(app.window, 60);

    rowFor('platform-prod').querySelector('[data-connect]').click();
    await settle(app.window, 150);

    const overridden = app.calls.forwardTargets[app.calls.forwardTargets.length - 1];
    suite.check('a hop chosen by hand is the one used',
      overridden.instanceId === 'i-0hop00000000001', overridden.instanceId);

    app.window.close();
  }

  {
    // Switching account in the sidebar replaces the instance list, and the hop
    // offered for a cluster comes from that list. If the cluster table was
    // drawn while the previous account's instances were still loaded, it went
    // on offering them — a hop from the account you just left.
    const app = await boot({
      profiles: [profile('keys'), profile('other', { region: 'eu-west-1' })],
      instances: [instance({ instanceName: 'account-x-box', instanceId: 'i-0xxx00000000001' })],
      clusters: [CLUSTER({ vpcId: 'vpc-123' })]
    });
    await pick(app, 'keys');

    app.document.querySelector('.nav-item[data-view="eks"]').click();
    await settle(app.window, 250);

    const hopLabels = () => [...app.document.querySelectorAll('#clusterTableWrap tbody tr [data-hop] option')]
      .map(option => option.textContent.trim());

    suite.check('the first account\'s instance is offered',
      hopLabels().some(label => /account-x-box/.test(label)), hopLabels());

    // The instance list arriving after the cluster table was drawn is the real
    // sequence: listing clusters is one call, listing instances is that plus
    // the SSM inventory, so the slower one lands second and the table was
    // already on screen offering whatever was loaded before it.
    app.state.instances = [instance({ instanceName: 'account-y-box', instanceId: 'i-0yyy00000000001' })];
    await app.portus.loadInstances();
    await settle(app.window, 200);

    app.document.querySelector('.nav-item[data-view="eks"]').click();
    await settle(app.window, 200);

    suite.check('after switching account, its own instances are offered',
      hopLabels().some(label => /account-y-box/.test(label)), hopLabels());
    suite.check('and the account that was left is gone from the list',
      !hopLabels().some(label => /account-x-box/.test(label)), hopLabels());

    app.window.close();
  }

  {
    // Changing account reloads the instance list, but that is not a request to
    // go and look at it. Being thrown back to Instances from wherever you were,
    // every time the account changed, is the opposite of helpful.
    const app = await boot({
      profiles: [profile('keys'), profile('other', { region: 'eu-west-1' })],
      clusters: [CLUSTER()]
    });
    await pick(app, 'keys');

    app.document.querySelector('.nav-item[data-view="eks"]').click();
    await settle(app.window, 250);
    suite.check('the EKS tab is open', app.portus.view === 'eks', app.portus.view);

    await pick(app, 'other');
    await settle(app.window, 400);
    suite.check('changing account leaves you where you were',
      app.portus.view === 'eks', app.portus.view);

    app.document.querySelector('.nav-item[data-view="tunnels"]').click();
    await settle(app.window, 80);
    await pick(app, 'keys');
    await settle(app.window, 400);
    suite.check('from Tunnels too', app.portus.view === 'tunnels', app.portus.view);

    app.window.close();
  }

  {
    // The region is per account, so it is picked from what that account has
    // enabled rather than typed, and starts on the one its profile names.
    // us-east-1 is deliberately not the first option, so landing on it proves
    // the profile's own region is used rather than whatever heads the list.
    const app = await boot({
      profiles: [profile('keys', { region: 'us-east-1' }), profile('other', { region: 'eu-west-1' })],
      clusters: [CLUSTER()],
      regions: [
        { name: 'eu-central-1', label: 'Frankfurt' },
        { name: 'eu-west-1', label: 'Ireland' },
        { name: 'us-east-1', label: 'N. Virginia' }
      ]
    });
    await pick(app, 'keys');

    app.document.querySelector('.nav-item[data-view="eks"]').click();
    await settle(app.window, 300);

    const region = () => app.document.getElementById('eksRegion');
    suite.check('the region is a picker, not a text box',
      region().tagName === 'SELECT', region().tagName);
    suite.check('listing every region the account has enabled',
      [...region().options].map(o => o.value).join(',') === 'eu-central-1,eu-west-1,us-east-1',
      [...region().options].map(o => o.value));
    suite.check('named by city as well as code',
      /Frankfurt/.test(region().options[0].textContent), region().options[0].textContent);
    suite.check('and starting on the profile\'s own region',
      region().value === 'us-east-1', region().value);

    // Choosing one re-lists against it
    region().value = 'eu-west-1';
    region().dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await settle(app.window, 250);

    const lookup = app.calls.clusterLookups[app.calls.clusterLookups.length - 1];
    suite.check('a chosen region is what the clusters are listed in',
      lookup && lookup.region === 'eu-west-1', lookup);

    // Pointing the tab at another account rebuilds the list for that account
    const picker = app.document.getElementById('eksProfile');
    picker.value = 'other';
    picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await settle(app.window, 300);

    suite.check('switching account re-asks for that account\'s regions',
      app.calls.regionLookups.includes('other'), app.calls.regionLookups);

    app.window.close();
  }

  {
    // Selecting a cluster shows what is behind it: the facts, and the instances
    // tagged as its nodes, each offering what that instance offers anywhere.
    const app = await boot({
      profiles: [profile('keys'), profile('other', { region: 'eu-west-1' })],
      instances: [
        instance({ instanceName: 'node-a', instanceId: 'i-0node0000000001',
          privateIp: '10.0.2.11', tags: [{ key: 'eks:cluster-name', value: 'platform-prod' }] }),
        instance({ instanceName: 'node-b', instanceId: 'i-0node0000000002',
          privateIp: '10.0.2.12', ssmStatus: 'unmanaged',
          tags: [{ key: 'eks:cluster-name', value: 'platform-prod' }] }),
        // Tagged for a different cluster, so not this one's business
        instance({ instanceName: 'other-node', instanceId: 'i-0node0000000003',
          tags: [{ key: 'eks:cluster-name', value: 'data-prod' }] }),
        instance({ instanceName: 'plain-box', instanceId: 'i-0plain000000001' })
      ],
      clusters: [CLUSTER(), CLUSTER({ id: 'eks:bare', name: 'bare',
        kubernetes: { clusterName: 'bare' } })]
    });
    await pick(app, 'keys');

    app.document.querySelector('.nav-item[data-view="eks"]').click();
    await settle(app.window, 250);

    const panel = () => app.document.getElementById('clusterDetail');
    const body = () => app.document.getElementById('clusterDetailBody');
    const rowFor = (name) => [...app.document.querySelectorAll('#clusterTableWrap tbody tr')]
      .find(tr => tr.textContent.includes(name));

    suite.check('no panel until a cluster is picked',
      panel().style.display === 'none', panel().style.display);

    rowFor('platform-prod').click();
    await settle(app.window, 120);

    suite.check('selecting one opens it',
      panel().style.display !== 'none', panel().style.display);
    suite.check('headed by the cluster and its endpoint',
      app.document.getElementById('clusterDetailTitle').textContent === 'platform-prod'
        && /eks\.amazonaws\.com/.test(app.document.getElementById('clusterDetailHost').textContent),
      app.document.getElementById('clusterDetailHost').textContent);
    suite.check('carrying the facts the table has no room for',
      /vpc-123/.test(body().textContent) && /1\.31/.test(body().textContent),
      body().textContent.replace(/\s+/g, ' ').slice(0, 120));

    const nodeNames = [...body().querySelectorAll('.node .node-name')].map(el => el.textContent.trim());
    suite.check('its own nodes are listed', nodeNames.join(',') === 'node-a,node-b', nodeNames);
    suite.check('another cluster\'s node is not', !nodeNames.includes('other-node'), nodeNames);
    suite.check('nor an instance that is no cluster\'s node',
      !nodeNames.includes('plain-box'), nodeNames);
    suite.check('and the count says what it counted',
      /2 tagged/.test(body().textContent),
      (body().textContent.match(/Nodes[^\n]*/) || [])[0]);

    // A node offers exactly what that instance offers in the instance list
    const first = [...body().querySelectorAll('.node')][0];
    suite.check('a reachable node offers a shell',
      !!first.querySelector('[data-action="ssm"]'), first.textContent.trim());

    const second = [...body().querySelectorAll('.node')][1];
    suite.check('an unmanaged node offers the way in it has',
      !!second.querySelector('[data-action="via"]'), second.textContent.trim());

    first.querySelector('[data-action="ssm"]').click();
    await settle(app.window, 80);
    suite.check('and the action runs against that instance',
      app.calls.ssm[app.calls.ssm.length - 1].id === 'i-0node0000000001', app.calls.ssm);

    // Nothing tagged is not the same as no nodes, and saying "none" would be a
    // claim Portus cannot make
    rowFor('bare').click();
    await settle(app.window, 120);
    suite.check('a cluster with nothing tagged explains itself',
      /eks:cluster-name/.test(body().textContent)
        && !body().querySelector('.node'),
      body().textContent.replace(/\s+/g, ' ').slice(0, 140));

    // Closing, the same two ways the instance panel closes
    app.document.getElementById('clusterCount').click();
    await settle(app.window, 80);
    suite.check('clicking away closes it',
      panel().style.display === 'none' && app.portus.selectedClusterName === null,
      app.portus.selectedClusterName);

    rowFor('platform-prod').click();
    await settle(app.window, 100);
    app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(app.window, 80);
    suite.check('Escape closes it too',
      app.portus.selectedClusterName === null, app.portus.selectedClusterName);

    app.window.close();
  }

  {
    // How long the version is supported, in the table and in the panel. The
    // window that counts is the one the version is in.
    const app = await boot({
      instances: [instance({ instanceName: 'bastion-01', instanceId: 'i-0hop00000000001' })],
      clusters: [
        CLUSTER({ engineVersion: '1.31', support: {
          status: 'STANDARD_SUPPORT',
          standardSupportEnds: '2027-03-23T00:00:00.000Z',
          extendedSupportEnds: '2028-03-23T00:00:00.000Z'
        }, supportPolicy: 'EXTENDED' }),
        CLUSTER({ id: 'eks:old', name: 'old-cluster', kubernetes: { clusterName: 'old-cluster' },
          engineVersion: '1.28', support: {
            status: 'EXTENDED_SUPPORT',
            standardSupportEnds: '2025-11-26T00:00:00.000Z',
            extendedSupportEnds: '2026-11-26T00:00:00.000Z'
          }, supportPolicy: 'STANDARD' }),
        CLUSTER({ id: 'eks:dead', name: 'past-it', kubernetes: { clusterName: 'past-it' },
          engineVersion: '1.24', support: { status: 'UNSUPPORTED',
            standardSupportEnds: null, extendedSupportEnds: null } }),
        CLUSTER({ id: 'eks:unknown', name: 'no-permission', kubernetes: { clusterName: 'no-permission' },
          engineVersion: '1.31', support: null })
      ]
    });
    await pick(app, 'keys');

    app.document.querySelector('.nav-item[data-view="eks"]').click();
    await settle(app.window, 250);

    const header = [...app.document.querySelectorAll('#clusterTableWrap thead th')]
      .map(th => th.textContent.trim());
    suite.check('Support sits right after Version',
      header[1] === 'Version' && header[2] === 'Support', header);

    const rowFor = (name) => [...app.document.querySelectorAll('#clusterTableWrap tbody tr')]
      .find(tr => tr.textContent.includes(name));
    const supportCell = (name) => rowFor(name).children[2].textContent.replace(/\s+/g, ' ').trim();

    suite.check('a supported version counts down to the end of standard support',
      /Standard/.test(supportCell('platform-prod')) && /23 Mar 2027/.test(supportCell('platform-prod')),
      supportCell('platform-prod'));
    // Already in extended support, so the standard date is behind it and the
    // extended one is what is left
    suite.check('one in extended support counts down to the end of that',
      /Extended/.test(supportCell('old-cluster')) && /26 Nov 2026/.test(supportCell('old-cluster')),
      supportCell('old-cluster'));
    suite.check('a version past both says so, with no date to count to',
      /Unsupported/.test(supportCell('past-it')) && !/\d{4}/.test(supportCell('past-it')),
      supportCell('past-it'));
    suite.check('and one that could not be read shows nothing rather than guessing',
      supportCell('no-permission') === '—', supportCell('no-permission'));

    // The panel has room for both dates and for what happens at the end
    rowFor('platform-prod').click();
    await settle(app.window, 120);
    const body = app.document.getElementById('clusterDetailBody').textContent.replace(/\s+/g, ' ');

    suite.check('the panel gives both dates',
      /Standard support ends\s*23 Mar 2027/.test(body) && /Extended support ends\s*23 Mar 2028/.test(body),
      body.slice(0, 220));
    suite.check('and says this cluster will enter extended support',
      /At end of standard\s*Enters extended support/.test(body), body.slice(0, 260));

    rowFor('old-cluster').click();
    await settle(app.window, 120);
    suite.check('while one set to upgrade says that instead',
      /At end of standard\s*Upgraded automatically/.test(
        app.document.getElementById('clusterDetailBody').textContent.replace(/\s+/g, ' ')));

    rowFor('no-permission').click();
    await settle(app.window, 120);
    suite.check('a cluster with no support data names the permission it needs',
      /eks:DescribeClusterVersions/.test(app.document.getElementById('clusterDetailBody').textContent));

    // Detail values are either an unbreakable token — an instance id, an
    // endpoint host — or a few words of prose. break-all suited the first and
    // split the second mid-word ("Enters extended su / pport"), which only
    // showed once the panel narrowed to 250px below 1180px wide.
    //
    // Checked against the stylesheet source, not the rendered page: jsdom does
    // no layout and does not fetch the stylesheet, so there is nothing to
    // measure. It guards the rule from being changed back, not the pixels.
    const css = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'styles.css'), 'utf8');
    const valueRule = (css.match(/\.kv dd \{[^}]*\}/) || [''])[0];

    suite.check('a detail value breaks inside a word only when it has to',
      /overflow-wrap:\s*anywhere/.test(valueRule) && !/word-break:\s*break-all/.test(valueRule),
      valueRule);

    app.window.close();
  }

  {
    // Nodes belong to the cluster's account. Pointed elsewhere, the instance
    // list is the wrong account's and there is nothing honest to show.
    const app = await boot({
      profiles: [profile('keys'), profile('other', { region: 'eu-west-1' })],
      instances: [instance({ instanceName: 'node-a', instanceId: 'i-0node0000000001',
        tags: [{ key: 'eks:cluster-name', value: 'platform-prod' }] })],
      clusters: [CLUSTER()]
    });
    await pick(app, 'keys');

    app.document.querySelector('.nav-item[data-view="eks"]').click();
    await settle(app.window, 250);

    const picker = app.document.getElementById('eksProfile');
    picker.value = 'other';
    picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await settle(app.window, 300);

    app.document.querySelector('#clusterTableWrap tbody tr').click();
    await settle(app.window, 120);

    const body = app.document.getElementById('clusterDetailBody');
    suite.check('a cluster in another account says why its nodes are missing',
      /Nodes live in other/.test(body.textContent) && !body.querySelector('.node'),
      body.textContent.replace(/\s+/g, ' ').slice(0, 160));

    app.window.close();
  }

  {
    // Once a tunnel exists the row offers what you do with it, not Connect again
    const app = await boot({
      instances: [instance({ instanceName: 'bastion-01', instanceId: 'i-0hop00000000001' })],
      clusters: [CLUSTER()],
      tunnels: [{
        id: 't1', kind: 'port', instanceId: 'i-0hop00000000001', instanceName: 'bastion-01',
        profileName: 'keys', port: 6443,
        remoteHost: 'ABCD1234P.gr7.eu-central-1.eks.amazonaws.com', remotePort: 443,
        startedAt: Date.now(), target: null,
        kubernetes: { clusterName: 'platform-prod', kubeconfig: '/k/platform-prod.yaml' }
      }]
    });
    await pick(app, 'keys');

    app.document.querySelector('.nav-item[data-view="eks"]').click();
    await settle(app.window, 250);

    const row = app.document.querySelector('#clusterTableWrap tbody tr');
    suite.check('an open tunnel turns Connect into kubectl',
      !!row.querySelector('[data-kubectl]') && !row.querySelector('[data-connect]'),
      row.textContent.trim());

    row.querySelector('[data-kubectl]').click();
    await settle(app.window, 80);
    suite.check('which opens a terminal for that tunnel',
      app.calls.kubectlTerminals[app.calls.kubectlTerminals.length - 1] === 't1',
      app.calls.kubectlTerminals);

    row.querySelector('[data-disconnect]').click();
    await settle(app.window, 80);
    suite.check('and Disconnect closes it',
      app.calls.closedTunnels[app.calls.closedTunnels.length - 1] === 't1',
      app.calls.closedTunnels);

    app.window.close();
  }

  suite.done();
})().catch(error => {
  console.error('\n  the suite threw:', error && error.stack);
  process.exit(1);
});
