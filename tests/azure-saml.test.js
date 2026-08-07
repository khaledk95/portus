// The SAML pieces of the Azure sign-in, tested without Electron.
//
// These are the parts that decide whether Microsoft accepts the request and
// whether the answer is understood. The window and the session belong to
// Electron and are exercised by hand; everything here is pure.

const path = require('path');
const Module = require('module');
const zlib = require('zlib');
const { createSuite } = require('./helpers/assert');

// azure-saml requires electron at the top level for BrowserWindow and session,
// neither of which any function below touches.
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { userAgentFallback: 'stub' },
      BrowserWindow: class {},
      session: { fromPartition: () => ({}) }
    };
  }
  return realLoad.call(this, request, ...rest);
};

const saml = require(path.join(__dirname, '..', 'src', 'azure-saml'));
Module._load = realLoad;

const suite = createSuite('Azure AD SAML');

// A minimal assertion in the shape Microsoft returns for the AWS app
const assertionXml = (roleValues) => `
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">
  <Assertion xmlns="urn:oasis:names:tc:SAML:2.0:assertion">
    <AttributeStatement>
      <Attribute Name="https://aws.amazon.com/SAML/Attributes/Role">
        ${roleValues.map(v => `<AttributeValue>${v}</AttributeValue>`).join('\n        ')}
      </Attribute>
      <Attribute Name="https://aws.amazon.com/SAML/Attributes/RoleSessionName">
        <AttributeValue>someone@example.com</AttributeValue>
      </Attribute>
    </AttributeStatement>
  </Assertion>
</samlp:Response>`;

const encode = xml => Buffer.from(xml, 'utf8').toString('base64');

(async () => {
  // ---------------------------------------------------------------------------
  suite.section('the request Microsoft is asked to answer');

  const xml = saml.buildAuthnRequest('https://signin.aws.amazon.com/saml');

  suite.check('one AuthnRequest', (xml.match(/<samlp:AuthnRequest/g) || []).length === 1);
  suite.check('the id is a valid XML NCName, so it cannot start with a digit',
    /\bID="_[0-9a-f-]{36}"/.test(xml), (xml.match(/ID="[^"]*"/) || [])[0]);
  suite.check('IssueInstant is ISO-8601 in UTC',
    /IssueInstant="\d{4}-\d{2}-\d{2}T[\d:.]+Z"/.test(xml));
  suite.check('AWS is named as the assertion consumer',
    xml.includes('AssertionConsumerServiceURL="https://signin.aws.amazon.com/saml"'));
  suite.check('the issuer is the app id URI',
    /<Issuer[^>]*>https:\/\/signin\.aws\.amazon\.com\/saml<\/Issuer>/.test(xml));
  suite.check('both namespaces are declared',
    xml.includes('xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"')
      && xml.includes('xmlns="urn:oasis:names:tc:SAML:2.0:assertion"'));
  suite.check('IsPassive is false, so Microsoft may ask the user something',
    xml.includes('IsPassive="false"'));

  const first = saml.buildAuthnRequest('x').match(/ID="([^"]+)"/)[1];
  const second = saml.buildAuthnRequest('x').match(/ID="([^"]+)"/)[1];
  suite.check('each request gets its own id', first !== second);

  // ---------------------------------------------------------------------------
  suite.section('the redirect binding');
  // Deflate-raw then base64 then url-encode. Getting any of the three wrong gives
  // a Microsoft error page rather than a login page, with nothing to explain it.

  const url = saml.buildLoginUrl('00000000-1111-2222-3333-444444444444', 'urn:amazon:webservices');
  const parsed = new URL(url);

  suite.check('it targets the tenant SAML2 endpoint',
    parsed.origin === 'https://login.microsoftonline.com'
      && parsed.pathname === '/00000000-1111-2222-3333-444444444444/saml2',
    parsed.origin + parsed.pathname);

  const roundTripped = zlib.inflateRawSync(
    Buffer.from(parsed.searchParams.get('SAMLRequest'), 'base64')
  ).toString('utf8');

  suite.check('the request survives deflate, base64 and url-encoding',
    roundTripped.includes('<samlp:AuthnRequest') && roundTripped.includes('urn:amazon:webservices'),
    roundTripped.slice(0, 60));

  suite.check('a tenant id with odd characters is encoded, not interpolated raw',
    saml.buildLoginUrl('a/../b', 'x').includes('a%2F..%2Fb'),
    saml.buildLoginUrl('a/../b', 'x').slice(0, 70));

  // ---------------------------------------------------------------------------
  suite.section('reading the roles out of the assertion');

  const roles = saml.parseRoles(encode(assertionXml([
    'arn:aws:iam::111111111111:role/Admin,arn:aws:iam::111111111111:saml-provider/Azure',
    // AWS does not guarantee the order of the pair
    'arn:aws:iam::222222222222:saml-provider/Azure,arn:aws:iam::222222222222:role/ReadOnly'
  ])));

  suite.check('both roles are found', roles.length === 2, roles);
  suite.check('role and principal are told apart by what they are, not by position',
    roles[0].roleArn.endsWith(':role/Admin')
      && roles[0].principalArn.includes(':saml-provider/')
      && roles[1].roleArn.endsWith(':role/ReadOnly')
      && roles[1].principalArn.includes(':saml-provider/'),
    roles);

  suite.check('whitespace around a value is ignored',
    saml.parseRoles(encode(assertionXml([
      '  arn:aws:iam::1:role/A , arn:aws:iam::1:saml-provider/P  '
    ])))[0].roleArn === 'arn:aws:iam::1:role/A');

  suite.check('a repeated role is listed once',
    saml.parseRoles(encode(assertionXml([
      'arn:aws:iam::1:role/A,arn:aws:iam::1:saml-provider/P',
      'arn:aws:iam::1:role/A,arn:aws:iam::1:saml-provider/P'
    ]))).length === 1);

  suite.check('the session name attribute is not mistaken for a role',
    saml.parseRoles(encode(assertionXml(['arn:aws:iam::1:role/A,arn:aws:iam::1:saml-provider/P'])))
      .every(r => !r.roleArn.includes('@')));

  suite.check('an assertion with no roles yields none',
    saml.parseRoles(encode('<samlp:Response><Assertion/></samlp:Response>')).length === 0);

  suite.check('a half-formed pair is discarded rather than half-used',
    saml.parseRoles(encode(assertionXml(['arn:aws:iam::1:role/OnlyARole']))).length === 0);

  // ---------------------------------------------------------------------------
  suite.section('the persisted Microsoft session');
  // This is what makes renewal silent, so it has to be stable for a tenant and
  // separate between tenants.

  const a = saml.partitionFor('00000000-1111-2222-3333-444444444444');
  const b = saml.partitionFor('99999999-8888-7777-6666-555555555555');

  suite.check('it persists', a.startsWith('persist:'), a);
  suite.check('it is stable for a tenant', a === saml.partitionFor('00000000-1111-2222-3333-444444444444'));
  suite.check('two tenants do not share one', a !== b);
  // A partition name becomes a directory under the user data folder, so path
  // separators and dots are stripped rather than escaped.
  suite.check('nothing but safe characters reach the partition name',
    saml.partitionFor('../../evil path;rm -rf') === 'persist:portus-azure-evilpathrm-rf',
    saml.partitionFor('../../evil path;rm -rf'));

  // ---------------------------------------------------------------------------
  suite.section('the window is not written off as an unknown browser');
  // Microsoft offers passkeys and Windows Hello only to a browser it recognises.
  // With the Electron token present the same account on the same tenant gets the
  // password form and nothing else, while Firefox and Chrome get the full list.

  const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/138.0.7204.35 Electron/37.1.0 Safari/537.36';

  const cleaned = saml.browserUserAgent(ELECTRON_UA);

  suite.check('the Electron token is gone', !/Electron/i.test(cleaned), cleaned);
  suite.check('the Chromium version is left alone, so it never reads as stale',
    cleaned.includes('Chrome/138.0.7204.35'), cleaned);
  suite.check('and the rest of the agent is untouched',
    cleaned === 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/138.0.7204.35 Safari/537.36', cleaned);
  suite.check('no double space is left where the token was',
    !/ {2}/.test(cleaned), cleaned);
  suite.check('an agent that never named Electron is passed through unchanged',
    saml.browserUserAgent('Mozilla/5.0 Chrome/138.0.0.0 Safari/537.36')
      === 'Mozilla/5.0 Chrome/138.0.0.0 Safari/537.36');

  // ---------------------------------------------------------------------------
  suite.section('timeouts suit what is being waited for');

  suite.check('a silent renewal gives up quickly',
    saml.SILENT_TIMEOUT_MS <= 30000, saml.SILENT_TIMEOUT_MS);
  suite.check('an interactive sign-in waits for a person and their phone',
    saml.INTERACTIVE_TIMEOUT_MS >= 120000, saml.INTERACTIVE_TIMEOUT_MS);

  suite.done();
})();
