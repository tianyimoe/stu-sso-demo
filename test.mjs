import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createDemoServer, checkConfig, configFromEnv } from './server.mjs';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

test('CAS redirect, exact service validation, user extraction, and single-use callback', async t => {
  let validatedService = '';
  const provider = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/login') {
      const callback = new URL(url.searchParams.get('service'));
      callback.searchParams.set('ticket', 'ST-test123');
      res.writeHead(302, { Location: callback.toString() });
      return res.end();
    }
    if (url.pathname === '/serviceValidate') {
      validatedService = url.searchParams.get('service');
      res.setHeader('Content-Type', 'application/xml');
      return res.end('<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas"><cas:authenticationSuccess><cas:user>student1</cas:user></cas:authenticationSuccess></cas:serviceResponse>');
    }
    res.writeHead(404);
    res.end();
  });
  const providerBase = await listen(provider);
  t.after(() => close(provider));

  const app = createDemoServer({
    loginUrl: providerBase + '/login',
    validateUrl: providerBase + '/serviceValidate',
    publicBaseUrl: '',
    allowInsecureLocalTest: true,
  });
  const appBase = await listen(app);
  t.after(() => close(app));

  // 1. Visit /login
  const start = await fetch(appBase + '/login', { redirect: 'manual' });
  assert.equal(start.status, 302);
  const cookieHeader = start.headers.get('set-cookie');
  assert.ok(cookieHeader);
  const cookie = cookieHeader.split(';')[0];
  assert.match(cookie, /^stu_demo_state=[A-Za-z0-9_-]+$/);

  // 2. Redirect to Mock SSO Provider
  const loginLocation = start.headers.get('location');
  const school = await fetch(loginLocation, { redirect: 'manual' });
  assert.equal(school.status, 302);

  // 3. Callback to Demo with ticket
  const callback = school.headers.get('location');
  const result = await fetch(callback, { headers: { Cookie: cookie } });
  assert.equal(result.status, 200);
  const body = await result.text();
  assert.match(body, /CAS 验票返回成功/);
  assert.match(body, /student1/);
  assert.equal(validatedService, new URL(loginLocation).searchParams.get('service'));

  // 4. Replay attack attempt: ticket / state already consumed
  const replay = await fetch(callback, { headers: { Cookie: cookie } });
  assert.equal(replay.status, 400);

  // 5. Missing cookie attempt
  const missingCookie = await fetch(new URL(callback).origin + '/callback?state=fake&ticket=ST-test123');
  assert.equal(missingCookie.status, 400);
});

test('CAS authenticationFailure handling and error diagnostic display', async t => {
  const provider = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/login') {
      const callback = new URL(url.searchParams.get('service'));
      callback.searchParams.set('ticket', 'ST-invalid-ticket');
      res.writeHead(302, { Location: callback.toString() });
      return res.end();
    }
    if (url.pathname === '/serviceValidate') {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end(`
        <cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
          <cas:authenticationFailure code="INVALID_TICKET">
            Ticket ST-invalid-ticket not recognized
          </cas:authenticationFailure>
        </cas:serviceResponse>
      `);
    }
    res.writeHead(404);
    res.end();
  });
  const providerBase = await listen(provider);
  t.after(() => close(provider));

  const app = createDemoServer({
    loginUrl: providerBase + '/login',
    validateUrl: providerBase + '/serviceValidate',
    publicBaseUrl: '',
    allowInsecureLocalTest: true,
  });
  const appBase = await listen(app);
  t.after(() => close(app));

  const start = await fetch(appBase + '/login', { redirect: 'manual' });
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const school = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const callback = school.headers.get('location');

  const result = await fetch(callback, { headers: { Cookie: cookie } });
  assert.equal(result.status, 502);
  const text = await result.text();
  assert.match(text, /CAS 验票未成功/);
  assert.match(text, /INVALID_TICKET/);
  assert.match(text, /Ticket ST-invalid-ticket not recognized/);
});

test('Security protections: CSRF state tampering and malformed ticket validation', async t => {
  const app = createDemoServer({
    loginUrl: 'http://127.0.0.1:9999/login',
    validateUrl: 'http://127.0.0.1:9999/serviceValidate',
    allowInsecureLocalTest: true,
  });
  const appBase = await listen(app);
  t.after(() => close(app));

  const start = await fetch(appBase + '/login', { redirect: 'manual' });
  const cookie = start.headers.get('set-cookie').split(';')[0];

  // Tampered state
  const tamperedRes = await fetch(`${appBase}/callback?state=tamperedStateValue&ticket=ST-valid123`, {
    headers: { Cookie: cookie },
  });
  assert.equal(tamperedRes.status, 400);

  // Malformed ticket format (XSS or command injection attempt)
  const realState = cookie.replace('stu_demo_state=', '');
  const badTicketRes = await fetch(`${appBase}/callback?state=${realState}&ticket=<script>alert(1)</script>`, {
    headers: { Cookie: cookie },
  });
  assert.equal(badTicketRes.status, 400);
});

test('Health check, root home, and unsupported HTTP method', async t => {
  const app = createDemoServer({
    allowInsecureLocalTest: true,
    loginUrl: 'http://127.0.0.1:9999/login',
    validateUrl: 'http://127.0.0.1:9999/serviceValidate',
  });
  const appBase = await listen(app);
  t.after(() => close(app));

  // Health endpoint
  const healthRes = await fetch(appBase + '/health');
  assert.equal(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.status, 'pass');

  // Root endpoint
  const rootRes = await fetch(appBase + '/');
  assert.equal(rootRes.status, 200);
  const rootHtml = await rootRes.text();
  assert.match(rootHtml, /汕大 SSO \/ CAS 联调工具/);
  assert.match(rootHtml, /跳转汕大统一登录/);

  // Method Not Allowed
  const postRes = await fetch(appBase + '/login', { method: 'POST' });
  assert.equal(postRes.status, 405);

  // Not found
  const notFoundRes = await fetch(appBase + '/not-found');
  assert.equal(notFoundRes.status, 404);
});

test('checkConfig error handling', () => {
  // Invalid port
  assert.throws(() => {
    checkConfig({ port: -1, loginUrl: 'https://sso.stu.edu.cn/login', validateUrl: 'https://sso.stu.edu.cn/serviceValidate' });
  }, /Invalid port/);

  assert.throws(() => {
    checkConfig({ port: 70000, loginUrl: 'https://sso.stu.edu.cn/login', validateUrl: 'https://sso.stu.edu.cn/serviceValidate' });
  }, /Invalid port/);

  // Mismatched origins
  assert.throws(() => {
    checkConfig({ loginUrl: 'https://sso.stu.edu.cn/login', validateUrl: 'https://other.stu.edu.cn/serviceValidate' });
  }, /must use the same origin/);

  // Remote non-HTTPS
  assert.throws(() => {
    checkConfig({ loginUrl: 'http://sso.stu.edu.cn/login', validateUrl: 'http://sso.stu.edu.cn/serviceValidate' });
  }, /must use HTTPS/);

  // Invalid PUBLIC_BASE_URL (cannot have path or query)
  assert.throws(() => {
    checkConfig({
      loginUrl: 'https://sso.stu.edu.cn/login',
      validateUrl: 'https://sso.stu.edu.cn/serviceValidate',
      publicBaseUrl: 'https://oa.stu.edu.cn/subpath',
    });
  }, /PUBLIC_BASE_URL must be an origin/);
});
