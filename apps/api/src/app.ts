import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { getX402Middleware } from './lib/x402.js';
import { stringify as yamlStringify } from './lib/yaml.js';
import { errorHandler, notFound } from './middleware/errorEnvelope.js';
import { requestId } from './middleware/requestId.js';
import { agentMatchesRoutes } from './routes/agents-matches.js';
import { agentRoutes } from './routes/agents.js';
import { authRoutes } from './routes/auth.js';
import { authSiwaRoutes } from './routes/auth-siwa.js';
import { dataRoutes } from './routes/data.js';
import { healthRoutes } from './routes/health.js';
import { prepareRoutes } from './routes/prepare.js';
import { ratingRoutes } from './routes/ratings.js';
import { scoreRoutes } from './routes/scores.js';
import { sponsorRoutes } from './routes/sponsors.js';
import { tournamentRoutes } from './routes/tournaments.js';

const app = new OpenAPIHono();

// Middleware order matters: requestId before everything so the header is set
// even on early-rejection paths; CORS next so preflights short-circuit before
// route resolution; errorHandler is registered via app.onError below.
app.use('*', requestId());
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      // SIWA + ERC-8128 headers (Sprint X4).
      'X-SIWA-Receipt',
      'Signature',
      'Signature-Input',
      'Content-Digest',
      // x402 client retry header (Sprint X5). The legacy `X-PAYMENT`
      // alias is also accepted by the middleware.
      'PAYMENT-SIGNATURE',
      'X-PAYMENT',
    ],
    exposeHeaders: [
      'X-Request-Id',
      'X-RateLimit-Reset',
      'X-SkillOS-Tier',
      'X-SkillOS-Verification',
      // x402 server response header (Sprint X5). Carries base64-encoded
      // payment requirements JSON on the 402 response, and the
      // settlement receipt on the 200 retry.
      'PAYMENT-REQUIRED',
      'PAYMENT-RESPONSE',
    ],
    maxAge: 86400,
  }),
);

// x402 paywall middleware (Sprint X5). Self-scoped to the routes listed in
// lib/x402.ts (currently /v1/data/*); all other paths pass through to next().
app.use('*', getX402Middleware());

// Register the JWT bearer security scheme on the OpenAPI registry so it
// shows up in /docs and clients can discover the auth requirement.
app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'Bearer JWT issued by POST /v1/auth/siwb/verify (24h TTL).',
});

// SIWA receipt + ERC-8128 per-request signature scheme — agent endpoints.
// Receipt carried as X-SIWA-Receipt header; write endpoints additionally
// require Signature + Signature-Input + Content-Digest (RFC 9421 / ERC-8128).
app.openAPIRegistry.registerComponent('securitySchemes', 'siwaReceipt', {
  type: 'apiKey',
  in: 'header',
  name: 'X-SIWA-Receipt',
  description:
    'Opaque HMAC-signed receipt issued by POST /v1/auth/siwa/verify (24h TTL). On write endpoints (POST /v1/agents/scores, PATCH /v1/agents/profile), MUST be accompanied by ERC-8128 request signature headers.',
});

// x402 paywall (Sprint X5) — paid data tier. Client signs an EIP-3009 USDC
// transfer for the price advertised in the 402 PAYMENT-REQUIRED header,
// then retries with PAYMENT-SIGNATURE. Testnet facilitator: x402.org.
app.openAPIRegistry.registerComponent('securitySchemes', 'x402Payment', {
  type: 'apiKey',
  in: 'header',
  name: 'PAYMENT-SIGNATURE',
  description:
    'x402 payment signature (EIP-3009 USDC transfer authorization). Initial request returns HTTP 402 with payment requirements in the PAYMENT-REQUIRED response header. Client signs the requested amount and retries with PAYMENT-SIGNATURE. Base Sepolia testnet uses the public x402.org facilitator; USDC contract 0x036CbD53842c5426634e7929541eC2318f3dCF7e.',
});

app.route('/', healthRoutes);
app.route('/', authRoutes);
app.route('/', authSiwaRoutes);
app.route('/', tournamentRoutes);
app.route('/', scoreRoutes);
app.route('/', ratingRoutes);
app.route('/', sponsorRoutes);
app.route('/', agentRoutes);
app.route('/', agentMatchesRoutes);
app.route('/', dataRoutes);
app.route('/', prepareRoutes);

// ─── OpenAPI 3.1 spec endpoints ───────────────────────────────────────────

const openApiConfig = {
  openapi: '3.1.0' as const,
  info: {
    title: 'SkillOS API',
    version: '0.1.0',
    description:
      'Public read-only HTTP API for the SkillOS protocol. Tournaments, scores, and sponsor receipts on Base Sepolia. See https://docs.skillos.network for the full developer surface map.',
    license: { name: 'MIT' },
  },
  servers: [
    { url: 'https://api.skillos.network', description: 'Production' },
    { url: 'http://localhost:3000', description: 'Local dev' },
  ],
};

app.doc31('/openapi.json', openApiConfig);

app.get('/openapi.yaml', (c) => {
  const doc = app.getOpenAPI31Document(openApiConfig);
  return c.body(yamlStringify(doc), 200, {
    'Content-Type': 'application/yaml; charset=utf-8',
  });
});

// ─── /docs — Stoplight Elements UI (CDN-loaded, brand-themed) ─────────────

const STOPLIGHT_VERSION = '8.4.6';

const docsHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SkillOS API · Reference</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
      rel="stylesheet"
    />
    <link
      rel="stylesheet"
      href="https://unpkg.com/@stoplight/elements@${STOPLIGHT_VERSION}/styles.min.css"
    />
    <style>
      :root {
        --primary: #e4f222;
        --color-primary: #e4f222;
        --background: #08090a;
        --color-canvas: #08090a;
      }
      html, body, #root {
        margin: 0;
        height: 100%;
        background: #08090a;
        color: #f5f5f5;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      a, a:visited { color: #e4f222; }
    </style>
  </head>
  <body>
    <elements-api
      apiDescriptionUrl="/openapi.yaml"
      router="hash"
      layout="sidebar"
      tryItCredentialsPolicy="omit"
    ></elements-api>
    <script src="https://unpkg.com/@stoplight/elements@${STOPLIGHT_VERSION}/web-components.min.js"></script>
  </body>
</html>`;

app.get('/docs', (c) =>
  c.body(docsHtml, 200, { 'Content-Type': 'text/html; charset=utf-8' }),
);

// Friendly root: redirect to docs.
app.get('/', (c) => c.redirect('/docs', 302));

// 404 + error
app.notFound(notFound);
app.onError(errorHandler);

export default app;
