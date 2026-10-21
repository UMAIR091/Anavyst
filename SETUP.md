# Anavyst — Setup

Anavyst is a multi-tenant reporting and analytics platform for marketing agencies. The current stack includes Next.js, React, TypeScript, Supabase, Resend, Anthropic (optional AI summaries), and Paddle Billing.

## Before you start

- Node.js compatible with the project's Next.js version
- npm
- A Supabase project
- The provider credentials for the integrations you intend to run locally

Never paste API keys, OAuth client secrets, service-role keys, or production environment values into chat, issues, pull requests, or source files. Store local secrets in `.env.local` and configure production secrets in your deployment provider.

## Local development

1. Clone the repository and install the locked dependencies:

   ```bash
   npm ci
   ```

2. Create a local environment file from the example:

   ```bash
   cp .env.example .env.local
   ```

   Fill in only the credentials required for the features you are testing. Keep `.env.local` untracked.

3. Configure Supabase using the project's current migration history. Apply migrations in order using your normal Supabase CLI/development workflow; do not run only the initial migration against an existing database.

4. Configure the OAuth redirect URLs in each provider's developer console to match your local app URL and the callback paths documented in `.env.example`.

5. Start the development server:

   ```bash
   npm run dev
   ```

## Useful checks

```bash
npm test
npm run build
```

Run these in a development environment with appropriate environment variables. A successful local build or test run does not by itself verify production OAuth, billing webhooks, cron jobs, or tenant isolation.

## Current service configuration

- **Supabase:** database, authentication, and server-side data access. Keep the service-role key server-only.
- **Google and other ad/analytics providers:** configure only the integrations you are actively testing. Redirect URIs must match the provider console exactly.
- **Resend:** email delivery and agency-specific sender configuration.
- **Anthropic:** optional AI-generated report summaries. Without a configured API key, AI summaries may be unavailable.
- **Paddle Billing:** current billing integration. Use Paddle sandbox credentials for development and configure webhook events and secrets as documented in `.env.example`.
- **Lemon Squeezy:** legacy environment variables may remain for historical compatibility; it is not the current checkout provider.

## Production safety

- Do not test billing, OAuth, token deletion, or scheduled syncs against production unless the test is explicitly planned and safe.
- Keep `LIVE_INTEGRATIONS` restricted to integrations that have been configured and tested for the target environment.
- Configure `CRON_SECRET` as a server-side secret and send it using the authorization header format expected by the cron routes.
- Review Supabase migrations and row-level security policies before deploying database changes.
- Never commit `.env.local`, production environment files, access tokens, or real customer data.
