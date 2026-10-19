import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { applyReferralCookie } from "@/lib/affiliates/capture";

// Builds a Content-Security-Policy (audit #8/#10).
//
// Two variants, chosen by route:
//   • STRICT (nonce + 'strict-dynamic') for the authenticated dashboard, which
//     is dynamically rendered — so Next.js stamps the fresh nonce onto its
//     scripts every request and modern browsers ignore 'unsafe-inline'. The
//     Paddle SDK still works: 'strict-dynamic' propagates trust to scripts the
//     (nonced) app code injects at runtime. The 'unsafe-inline' https: tail is a
//     fallback only for browsers that don't understand 'strict-dynamic'.
//   • LEGACY (no nonce) for static/marketing pages. A per-request nonce can't be
//     baked into a cached/ISR page, so forcing one there would break their
//     scripts; those pages carry no user data, so the existing policy is kept.
const PADDLE_SCRIPT = "https://cdn.paddle.com https://sandbox-cdn.paddle.com https://public-cdn.paddle.com";
const PADDLE_CONNECT =
  "https://api.paddle.com https://sandbox-api.paddle.com " +
  "https://checkout-service.paddle.com https://sandbox-checkout-service.paddle.com " +
  "https://cdn.paddle.com https://sandbox-cdn.paddle.com";
const PADDLE_FRAME = "https://buy.paddle.com https://sandbox-buy.paddle.com";

// Google Analytics (gtag.js): script loads from googletagmanager.com; beacons
// go to *.google-analytics.com / *.analytics.google.com. Google's documented
// GA4 policy also needs the bare analytics.google.com (a wildcard doesn't
// match the apex), and, with Google Signals / the conversion linker on,
// www.google.com and *.g.doubleclick.net. Without those, the hits Google
// routes there were refused by this policy and never counted.
const GA_SCRIPT = "https://www.googletagmanager.com";
const GA_CONNECT =
  "https://www.google-analytics.com https://*.google-analytics.com https://analytics.google.com https://*.analytics.google.com " +
  "https://*.googletagmanager.com https://www.google.com https://*.g.doubleclick.net";

// Meta Pixel (lib/metaPixel.ts): fbevents.js loads from connect.facebook.net and
// reports to www.facebook.com/tr. Image beacons are already covered by img-src.
const META_SCRIPT = "https://connect.facebook.net";
const META_CONNECT = "https://www.facebook.com https://connect.facebook.net";

// Visitor country for the Meta Pixel consent check, from Vercel geo IP. Not
// httpOnly: lib/metaPixel.ts reads it in the browser on static pages.
const COUNTRY_COOKIE = "av_cc";

// The one host this deployment should be reached on, taken from
// NEXT_PUBLIC_APP_URL (e.g. "tryreportflow.com").
function canonicalHost(): string | null {
  try {
    return new URL(process.env.NEXT_PUBLIC_APP_URL ?? "").host || null;
  } catch {
    return null;
  }
}

// Machine-to-machine endpoints are exempt from the canonical redirect below.
// Vercel Cron invokes functions on the deployment's own *.vercel.app URL and
// Paddle posts webhooks to a fixed URL — neither is guaranteed to follow a 308,
// and a redirected POST can lose its signed body. Uptime checks stay on
// whichever host they were configured with. Meta's deauthorize and data
// deletion callbacks are signed POSTs too.
const CANONICAL_EXEMPT = [
  "/api/cron", "/api/webhooks", "/api/health", "/monitoring", "/api/meta/deauthorize", "/api/meta/data-deletion",
];

function buildCsp(nonce: string, strict: boolean): string {
  const supabaseOrigin = (() => {
    try {
      return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").origin;
    } catch {
      return "";
    }
  })();
  const supabaseWs = supabaseOrigin.replace(/^https:/, "wss:");

  const scriptSrc = strict
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' https:`
    : `script-src 'self' 'unsafe-inline' ${PADDLE_SCRIPT} ${GA_SCRIPT} ${META_SCRIPT}`;

  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${supabaseOrigin} ${supabaseWs} ${PADDLE_CONNECT} ${GA_CONNECT} ${META_CONNECT}`.replace(/\s+/g, " ").trim(),
    `frame-src 'self' ${PADDLE_FRAME}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

// Refreshes the Supabase session cookie and guards /dashboard, while attaching a
// nonce'd CSP to every response.
//
// Auth performance (audit #8): auth.getUser() validates the JWT against the
// Supabase auth server — a network round-trip. Doing it on EVERY matched request
// (marketing pages, API routes, etc.) is wasteful. We now only call it on
// auth-relevant paths (/dashboard guard + keeping signed-in users off
// /login,/signup); API routes already enforce their own auth. This removes the
// per-request auth-server hop on the majority of traffic.
export async function updateSession(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Canonical host. Production is served from BOTH the custom domain and the
  // project's *.vercel.app alias, and that broke OAuth: connect links are
  // relative, so the CSRF nonce cookie is written on whichever host the user
  // happens to be browsing, while the provider always returns to the single
  // redirect URI registered in its console. Land on the other host and the
  // cookie simply isn't sent — the callback rejects the flow with
  // "Invalid state" before doing any work.
  //
  // Forcing one host makes that mismatch impossible, and repairs a callback
  // already in flight: path and query (the provider's code + state) survive the
  // redirect, so the flow completes on the canonical host instead of failing.
  // Scoped to VERCEL_ENV=production so branch/preview deployments and local
  // development keep serving themselves.
  const canonical = canonicalHost();
  if (
    canonical &&
    process.env.VERCEL_ENV === "production" &&
    request.nextUrl.host !== canonical &&
    !CANONICAL_EXEMPT.some((p) => path.startsWith(p))
  ) {
    const url = request.nextUrl.clone();
    url.host = canonical;
    url.protocol = "https:";
    url.port = "";
    return NextResponse.redirect(url, 308);
  }

  // Maintenance mode (launch audit P1-8): flip MAINTENANCE_MODE=on in the env to
  // route all traffic to /maintenance, while keeping the health check and the
  // maintenance page itself reachable (so uptime monitors still work).
  if (
    process.env.MAINTENANCE_MODE === "on" &&
    path !== "/maintenance" &&
    !path.startsWith("/api/health") &&
    !path.startsWith("/monitoring") // Sentry tunnel
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/maintenance";
    return NextResponse.rewrite(url);
  }

  const nonce = crypto.randomUUID();
  // Strict, nonce'd CSP for the dynamically-rendered dashboard; legacy policy
  // for static/marketing routes (see buildCsp).
  const csp = buildCsp(nonce, path.startsWith("/dashboard"));

  // Propagate the nonce to the app (Next reads it to nonce its bootstrap
  // scripts; server components read it via headers() for inline JSON-LD).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request: { headers: requestHeaders } });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  const authRelevant = path.startsWith("/dashboard") || path === "/login" || path === "/signup";
  let signedInOnDashboard = false;

  if (authRelevant) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    signedInOnDashboard = Boolean(user) && path.startsWith("/dashboard");

    if (!user && path.startsWith("/dashboard")) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      const redirect = NextResponse.redirect(url);
      redirect.headers.set("content-security-policy", csp);
      return redirect;
    }

    // Signed-in visitors have no use for the auth pages — except when they were
    // sent there BY a failure. /auth/callback redirects to /login?error=… when a
    // confirmation link can't be claimed, and bouncing that to the dashboard
    // threw the reason away and silently dropped the user into whichever
    // account this browser already held. Someone confirming a second account
    // from a mailbox open in another profile hit exactly that: the wrong
    // dashboard, no explanation, and the original tab still waiting.
    const carriesError = request.nextUrl.searchParams.has("error");
    if (user && !carriesError && (path === "/login" || path === "/signup")) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      const redirect = NextResponse.redirect(url);
      redirect.headers.set("content-security-policy", csp);
      return redirect;
    }
  }

  const country = request.headers.get("x-vercel-ip-country");
  if (country && request.cookies.get(COUNTRY_COOKIE)?.value !== country) {
    response.cookies.set(COUNTRY_COOKIE, country, { path: "/", sameSite: "lax", secure: true, maxAge: 60 * 60 * 24 });
  }

  // Affiliate referral (lib/affiliates/capture.ts). Set on the final response
  // so the Supabase session cookies written above are kept alongside it.
  applyReferralCookie(request, response, { signedInOnDashboard });

  response.headers.set("content-security-policy", csp);
  return response;
}
