import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_TRANSACTIONS = 1000;
const TRANSACTION_TTL_MS = 5 * 60 * 1000; // 5 minutes

const htmlEscape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function page(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${htmlEscape(title)}</title>
  <style>
    body { font: 16px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 820px; margin: 48px auto; padding: 0 20px; color: #18212b; background: #fafbfc; }
    h1 { margin-top: 0; color: #0d2b45; font-size: 1.75rem; border-bottom: 2px solid #e1e8ed; padding-bottom: 12px; }
    a.button { display: inline-block; background: #1458a5; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500; transition: background 0.15s ease; }
    a.button:hover { background: #0f4482; }
    a.button.secondary { background: #5c6f84; }
    a.button.secondary:hover { background: #475666; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f0f4f8; padding: 16px; border-radius: 6px; border: 1px solid #d8e2ec; font-size: 14px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    code { overflow-wrap: anywhere; background: #eaeff5; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .status-card { padding: 14px 18px; border-radius: 6px; margin: 16px 0; }
    .status-card.success { background: #eaf7ed; border-left: 4px solid #28a745; color: #155724; }
    .status-card.danger { background: #fdf2f2; border-left: 4px solid #dc3545; color: #721c24; }
    .status-card.info { background: #eef6fc; border-left: 4px solid #1458a5; color: #0c5460; }
    .meta-list { list-style: none; padding-left: 0; }
    .meta-list li { margin: 8px 0; }
    .actions { margin-top: 24px; display: flex; gap: 12px; }
  </style>
</head>
<body>
  <h1>${htmlEscape(title)}</h1>
  ${body}
</body>
</html>`;
}

export function configFromEnv(env = process.env) {
  return {
    host: env.HOST || '127.0.0.1',
    port: env.PORT !== undefined ? Number(env.PORT) : 3000,
    publicBaseUrl: env.PUBLIC_BASE_URL || '',
    loginUrl: env.CAS_LOGIN_URL || 'https://sso.stu.edu.cn/login',
    validateUrl: env.CAS_VALIDATE_URL || 'https://sso.stu.edu.cn/serviceValidate',
    allowInsecureLocalTest: env.ALLOW_INSECURE_LOCAL_TEST === '1',
  };
}

export function checkConfig(config) {
  if (config.port !== undefined) {
    if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
      throw new Error(`Invalid port: "${config.port}". Port must be an integer between 0 and 65535.`);
    }
  }
  const login = new URL(config.loginUrl);
  const validate = new URL(config.validateUrl);
  if (login.origin !== validate.origin || login.username || validate.username || login.password || validate.password) {
    throw new Error('CAS login and validation endpoints must use the same origin and have no URL credentials');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(login.hostname);
  if (login.protocol !== 'https:' && !(config.allowInsecureLocalTest && loopback && login.protocol === 'http:')) {
    throw new Error('CAS endpoints must use HTTPS');
  }
  if (config.publicBaseUrl) {
    const base = new URL(config.publicBaseUrl);
    if (base.pathname !== '/' || base.search || base.hash || base.username || base.password) {
      throw new Error('PUBLIC_BASE_URL must be an origin, for example https://oa.example.edu.cn');
    }
    if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
      throw new Error('A non-local PUBLIC_BASE_URL must use HTTPS');
    }
  }
}

function cookieValue(header, name) {
  const values = String(header || '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}

function equal(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function limitedText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) throw new Error('Validation response exceeded 64 KiB');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createDemoServer(userConfig = {}) {
  const envDefaults = configFromEnv();
  const config = { ...envDefaults, ...userConfig };
  checkConfig(config);

  const transactions = new Map();
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const send = (status, title, body) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(title, body));
    };

    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method !== 'GET') {
        return send(405, '仅支持 GET', '<p>该端点仅接收 GET 请求。</p><p class="actions"><a class="button secondary" href="/">返回首页</a></p>');
      }

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'pass', ok: true, timestamp: new Date().toISOString() }));
      }

      const address = server.address();
      const base = config.publicBaseUrl ? new URL(config.publicBaseUrl).origin : `http://127.0.0.1:${address ? address.port : config.port}`;
      const secure = base.startsWith('https:') ? '; Secure' : '';

      if (url.pathname === '/') {
        return send(200, '汕大 SSO / CAS 联调工具', `
          <div class="status-card info">
            <strong>联调模式提示：</strong> 本工具仅测试 CAS 跳转与票据验证链路，不创建账号、不收集学校密码，亦不签发业务系统凭据。
          </div>
          <p><a class="button" href="/login">跳转汕大统一登录</a></p>
          <h3>当前生效配置</h3>
          <ul class="meta-list">
            <li><strong>回调地址基址：</strong><code>${htmlEscape(base)}</code></li>
            <li><strong>学校登录地址：</strong><code>${htmlEscape(config.loginUrl)}</code></li>
            <li><strong>学校验票地址：</strong><code>${htmlEscape(config.validateUrl)}</code></li>
          </ul>
        `);
      }

      if (url.pathname === '/login') {
        const state = randomBytes(32).toString('base64url');
        const service = new URL('/callback', base);
        service.searchParams.set('state', state);
        const serviceUrl = service.toString();

        const now = Date.now();
        for (const [key, val] of transactions) {
          if (val.expiresAt < now) transactions.delete(key);
        }
        if (transactions.size >= MAX_TRANSACTIONS) {
          const oldest = transactions.keys().next().value;
          transactions.delete(oldest);
        }
        transactions.set(state, { serviceUrl, expiresAt: now + TRANSACTION_TTL_MS });

        const login = new URL(config.loginUrl);
        login.searchParams.set('service', serviceUrl);
        res.setHeader('Set-Cookie', `stu_demo_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300${secure}`);
        res.writeHead(302, { Location: login.toString() });
        return res.end();
      }

      if (url.pathname === '/callback') {
        res.setHeader('Set-Cookie', `stu_demo_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
        const stateValues = url.searchParams.getAll('state');
        const ticketValues = url.searchParams.getAll('ticket');
        const state = stateValues.length === 1 ? stateValues[0] : '';
        const ticket = ticketValues.length === 1 ? ticketValues[0] : '';
        const cookie = cookieValue(req.headers.cookie, 'stu_demo_state');
        const tx = transactions.get(state);
        transactions.delete(state);

        if (!tx || !state || !cookie || !equal(state, cookie) || tx.expiresAt < Date.now() || !/^ST-[A-Za-z0-9._~-]{1,2048}$/.test(ticket)) {
          return send(400, '回调校验失败', `
            <div class="status-card danger">
              <strong>校验未通过：</strong>缺少有效的一次性登录事务、State 匹配失败或 CAS 票据格式异常。请从首页重新发起登录。
            </div>
            <p class="actions"><a class="button secondary" href="/">返回首页</a></p>
          `);
        }

        const validate = new URL(config.validateUrl);
        validate.searchParams.set('service', tx.serviceUrl);
        validate.searchParams.set('ticket', ticket);

        const response = await fetch(validate, {
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
          headers: { Accept: 'application/xml, text/xml' },
        });

        const raw = await limitedText(response);
        const success = response.ok && /<(?:[A-Za-z_][\w.-]*:)?authenticationSuccess(?:\s[^>]*)?>/.test(raw);

        let userDetails = '';
        if (success) {
          const userMatch = /<(?:[A-Za-z_][\w.-]*:)?user(?:\s[^>]*)?>([^<]+)<\//.exec(raw);
          const user = userMatch ? userMatch[1].trim() : '';
          userDetails = `
            <div class="status-card success">
              <strong>CAS 认证成功！</strong>
              ${user ? `<br>识别到的用户主体 (cas:user)：<code>${htmlEscape(user)}</code>` : ''}
            </div>
          `;
        } else {
          const failMatch = /<(?:[A-Za-z_][\w.-]*:)?authenticationFailure(?:\s+code="([^"]*)")?[^>]*>([\s\S]*?)<\//.exec(raw);
          const failCode = failMatch ? failMatch[1] : '';
          const failMsg = failMatch ? failMatch[2].trim() : '';
          userDetails = `
            <div class="status-card danger">
              <strong>CAS 验票未成功</strong> (HTTP 状态码: ${response.status})
              ${failCode ? `<br>错误码：<code>${htmlEscape(failCode)}</code>` : ''}
              ${failMsg ? `<br>详细原因：${htmlEscape(failMsg)}` : ''}
            </div>
          `;
        }

        return send(success ? 200 : 502, success ? 'CAS 验票返回成功' : 'CAS 验票未成功', `
          ${userDetails}
          <p>以下为学校验票端点返回的原始 XML 响应内容（仅供联调调试）：</p>
          <pre>${htmlEscape(raw || '(空响应)')}</pre>
          <p class="actions"><a class="button" href="/">返回首页</a></p>
        `);
      }

      return send(404, '页面不存在', '<p>所请求的页面不存在。</p><p class="actions"><a class="button secondary" href="/">返回首页</a></p>');
    } catch (error) {
      return send(502, '请求处理失败', `
        <div class="status-card danger">
          <strong>异常信息：</strong>${htmlEscape(error instanceof Error ? error.message : String(error))}
        </div>
        <p class="actions"><a class="button secondary" href="/">返回首页</a></p>
      `);
    }
  });

  return server;
}

function printUsage() {
  console.log(`
汕大 SSO / CAS 联调工具 (stu-sso-cas-smoke-test)

用法:
  npm start
  node server.mjs

常用环境变量:
  PORT                      服务监听端口 (默认: 3000)
  HOST                      服务监听地址 (默认: 127.0.0.1)
  PUBLIC_BASE_URL           向学校登记的公网回调域名 (如: https://sso-demo.example.edu.cn)
  CAS_LOGIN_URL             汕大统一认证登录地址 (默认: https://sso.stu.edu.cn/login)
  CAS_VALIDATE_URL          汕大统一认证验票地址 (默认: https://sso.stu.edu.cn/serviceValidate)
  ALLOW_INSECURE_LOCAL_TEST 仅允许本机测试时使用 HTTP (设置为 1 开启)
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const config = configFromEnv();
  const server = createDemoServer(config);
  server.listen(config.port, config.host, () => {
    const actualPort = server.address().port;
    console.log('='.repeat(60));
    console.log('汕大 SSO / CAS 联调工具已启动');
    console.log(`本地访问地址: http://${config.host}:${actualPort}`);
    console.log(`CAS 登录地址: ${config.loginUrl}`);
    console.log(`CAS 验票地址: ${config.validateUrl}`);
    if (config.publicBaseUrl) {
      console.log(`公网回调基址: ${config.publicBaseUrl}`);
    } else {
      console.log(`公网回调基址: (未配置 PUBLIC_BASE_URL，使用本地地址)`);
    }
    console.log('='.repeat(60));
  });

  const shutdown = () => {
    console.log('\n正在停止服务...');
    server.close(() => {
      console.log('服务已安全退出。');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
