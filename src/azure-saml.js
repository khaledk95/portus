// Azure AD sign-in.
//
// Portus builds the SAML request, opens Microsoft's login page in a window, and
// waits for the assertion to come back. Nothing on that page is automated:
// whatever the tenant asks for — a password, a push, a passkey, a compliant
// device — Microsoft asks and the user answers. No password is seen, handled or
// stored here.

const { app, BrowserWindow, session } = require('electron');
const zlib = require('zlib');
const crypto = require('crypto');

// Where AWS receives the assertion. Also the audience Microsoft signs it for.
const AWS_ACS_URL = 'https://signin.aws.amazon.com/saml';

// A silent attempt is a renewal: the Microsoft session is either still good, in
// which case the assertion comes back with nothing on screen, or it is not, in
// which case Microsoft would want to ask something and we stop instead.
const SILENT_TIMEOUT_MS = 15000;

// An interactive sign-in waits on a person, who may be reaching for a phone.
const INTERACTIVE_TIMEOUT_MS = 300000;

// Microsoft's login page decides which sign-in methods to offer partly from the
// browser identity, and Electron's default user agent ends with an
// `Electron/37.1.0` token. A browser it does not recognise gets the password form
// and nothing else: no passkey, no Windows Hello, no security key. Confirmed by
// comparison — the same account on the same tenant is offered those methods in
// Firefox and Chrome, and not here.
//
// Only the Electron token is removed. Everything else stays as Chromium reports
// it, including the version, so this does not go stale or claim to be a browser
// Portus is not — it is Chromium, and now says so without the qualifier.
function browserUserAgent(defaultUserAgent = app.userAgentFallback) {
  return String(defaultUserAgent).replace(/\s*Electron\/\S+/, '');
}

// SAML ids must be valid XML NCNames, which may not begin with a digit — hence
// the leading underscore rather than a bare UUID.
function buildAuthnRequest(appIdUri) {
  const id = `_${crypto.randomUUID()}`;

  return `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" `
    + `ID="${id}" Version="2.0" IssueInstant="${new Date().toISOString()}" IsPassive="false" `
    + `AssertionConsumerServiceURL="${AWS_ACS_URL}">`
    + `<Issuer xmlns="urn:oasis:names:tc:SAML:2.0:assertion">${appIdUri}</Issuer>`
    + `<samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"/>`
    + `</samlp:AuthnRequest>`;
}

// HTTP-Redirect binding: raw deflate, base64, url-encode.
function buildLoginUrl(tenantId, appIdUri) {
  const deflated = zlib.deflateRawSync(Buffer.from(buildAuthnRequest(appIdUri), 'utf8'));

  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/saml2`
    + `?SAMLRequest=${encodeURIComponent(deflated.toString('base64'))}`;
}

// The assertion lists every role the user may assume, each paired with the SAML
// provider that vouches for it. AWS wants both, and pairs are not ordered
// consistently, so each is identified by what it is rather than by position.
function parseRoles(samlResponseBase64) {
  const xml = Buffer.from(samlResponseBase64, 'base64').toString('utf8');

  const values = [...xml.matchAll(/<AttributeValue[^>]*>([^<]*arn:aws:iam[^<]*)<\/AttributeValue>/g)]
    .map(match => match[1].trim());

  const roles = values.map(value => {
    const parts = value.split(',').map(part => part.trim());
    return {
      roleArn: parts.find(part => part.includes(':role/')),
      principalArn: parts.find(part => part.includes(':saml-provider/'))
    };
  }).filter(role => role.roleArn && role.principalArn);

  // A duplicate here would show the same role twice in the picker
  const seen = new Set();
  return roles.filter(role => {
    if (seen.has(role.roleArn)) return false;
    seen.add(role.roleArn);
    return true;
  });
}

// One partition per tenant, persisted. This is what makes renewal silent: the
// Microsoft session cookie lives here, and while it is valid the assertion comes
// back without anything being shown. It is a scoped, expiring cookie rather than
// a replayable password, which is the trade that made this worth building.
function partitionFor(tenantId) {
  return `persist:portus-azure-${String(tenantId).replace(/[^a-zA-Z0-9-]/g, '')}`;
}

/**
 * Runs the SAML flow and returns the assertion.
 *
 * @param {object}  profile          needs ssoTenantId and ssoAppIdUri
 * @param {boolean} options.silent   never show a window; give up if one is needed
 * @param {object}  options.parent   window to centre the sign-in on
 * @returns {Promise<{ samlResponse: string, roles: Array }>}
 */
function requestAssertion(profile, { silent = false, parent = null } = {}) {
  return new Promise((resolve, reject) => {
    const { azureTenantId, azureAppIdUri } = profile;

    if (!azureTenantId || !azureAppIdUri) {
      reject(new Error('This profile is missing azure_tenant_id or azure_app_id_uri.'));
      return;
    }

    const partition = session.fromPartition(partitionFor(azureTenantId));
    const filter = { urls: [`${AWS_ACS_URL}*`] };

    let settled = false;
    let win = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;

      clearTimeout(timer);
      try { partition.webRequest.onBeforeRequest(filter, null); } catch (e) { /* already gone */ }
      if (win && !win.isDestroyed()) win.destroy();

      if (error) reject(error); else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error(silent
        ? 'The Microsoft session has expired — signing in again is needed.'
        : 'Timed out waiting for the Microsoft sign-in to finish.'));
    }, silent ? SILENT_TIMEOUT_MS : INTERACTIVE_TIMEOUT_MS);

    // The assertion arrives as a form POST to AWS. Reading it here means it never
    // has to be scraped out of a page, and the page itself is never inspected.
    partition.webRequest.onBeforeRequest(filter, (details, callback) => {
      const upload = details.uploadData && details.uploadData[0];
      const body = upload && upload.bytes ? Buffer.from(upload.bytes).toString('utf8') : '';
      const match = body.match(/(?:^|&)SAMLResponse=([^&]*)/);

      if (!match) {
        callback({ cancel: false });
        return;
      }

      // Cancelled deliberately: the assertion is for Portus, and letting the POST
      // through would sign the embedded browser into the AWS console as well.
      callback({ cancel: true });

      try {
        const samlResponse = decodeURIComponent(match[1].replace(/\+/g, ' '));
        const roles = parseRoles(samlResponse);

        if (!roles.length) {
          finish(new Error('Microsoft returned an assertion with no AWS roles in it.'));
          return;
        }
        finish(null, { samlResponse, roles });
      } catch (error) {
        finish(new Error(`Could not read the assertion Microsoft returned: ${error.message}`));
      }
    });

    win = new BrowserWindow({
      width: 520,
      height: 720,
      show: false,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: !silent && !!parent,
      title: 'Sign in with Azure AD',
      autoHideMenuBar: true,
      webPreferences: {
        session: partition,
        nodeIntegration: false,
        contextIsolation: true,
        // Nothing of ours runs in this window; it only ever shows Microsoft's page
        sandbox: true
      }
    });

    // Set on the webContents rather than passed to loadURL, so it survives every
    // redirect — a federated tenant hands off to another identity provider, and
    // that one sniffs the browser too.
    win.webContents.setUserAgent(browserUserAgent());

    // Shown only when Microsoft actually needs something. A silent renewal that
    // succeeds never puts anything on screen.
    if (!silent) {
      win.once('ready-to-show', () => { if (!settled) win.show(); });
    }

    win.on('closed', () => {
      win = null;
      finish(new Error('Sign-in was cancelled.'));
    });

    win.loadURL(buildLoginUrl(azureTenantId, azureAppIdUri))
      .catch(error => finish(new Error(`Could not reach Microsoft sign-in: ${error.message}`)));
  });
}

// Forgets the Microsoft session for a tenant, so the next sign-in starts clean.
async function forgetSession(tenantId) {
  const partition = session.fromPartition(partitionFor(tenantId));
  await partition.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb'] });
}

module.exports = {
  AWS_ACS_URL,
  browserUserAgent,
  buildAuthnRequest,
  buildLoginUrl,
  parseRoles,
  partitionFor,
  requestAssertion,
  forgetSession,
  SILENT_TIMEOUT_MS,
  INTERACTIVE_TIMEOUT_MS
};
