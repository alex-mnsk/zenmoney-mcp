import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import { createHash, randomBytes } from "node:crypto";
const escape = (value) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const callbackUrl = (env) => `${env.PUBLIC_ORIGIN}/github/callback`;
const signInHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const oauth = env.OAUTH_PROVIDER;
    if (url.pathname !== "/authorize" && url.pathname !== "/github/callback") {
      return new Response("Not found", { status: 404 });
    }
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !/^\d+$/.test(env.OWNER_GITHUB_ID ?? "")) {
      return new Response("Owner sign-in is not configured yet", { status: 503 });
    }
    try {
      if (url.pathname === "/authorize" && request.method === "GET") {
        const authRequest = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(authRequest);
        const consent = await oauth.beginConsent(authRequest);
        consent.headers.set("content-type", "text/html; charset=utf-8");
        consent.headers.set("content-security-policy", "default-src 'none'; form-action 'self' https://github.com https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'");
        consent.headers.set("referrer-policy", "same-origin");
        return new Response(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>\u0414\u043E\u0441\u0442\u0443\u043F \u043A ZenMoney</title>
<h1>\u0420\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u044C \u0434\u043E\u0441\u0442\u0443\u043F \u043A ZenMoney?</h1>
<p>\u041F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435: <strong>${escape(details.clientName)}</strong>.</p>
<p>${details.clientDomain ? `\u0414\u043E\u043C\u0435\u043D \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u044F: ${escape(details.clientDomain)}.` : "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u043D\u0435 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u043E."}</p>
<p>\u0414\u043E\u0441\u0442\u0443\u043F \u0431\u0443\u0434\u0435\u0442 \u043F\u0435\u0440\u0435\u0434\u0430\u043D \u043D\u0430: <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p>\u042D\u0442\u043E \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u043D\u0430 \u0432\u0430\u0448\u0435\u043C \u043A\u043E\u043C\u043F\u044C\u044E\u0442\u0435\u0440\u0435. \u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0439\u0442\u0435, \u0442\u043E\u043B\u044C\u043A\u043E \u0435\u0441\u043B\u0438 \u0432\u044B \u0441\u0430\u043C\u0438 \u043D\u0430\u0447\u0430\u043B\u0438 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435.</p>" : ""}
<p>${details.scope.includes("finance:write") ? "\u0427\u0442\u0435\u043D\u0438\u0435 \u0444\u0438\u043D\u0430\u043D\u0441\u043E\u0432\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u0438 \u0441\u043E\u0437\u0434\u0430\u043D\u0438\u0435 \u0440\u0430\u0441\u0445\u043E\u0434\u0430 \u043F\u043E\u0441\u043B\u0435 \u043F\u0440\u0435\u0434\u0432\u0430\u0440\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0433\u043E \u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440\u0430 \u0438 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F." : "\u0422\u043E\u043B\u044C\u043A\u043E \u0447\u0442\u0435\u043D\u0438\u0435 \u0434\u0430\u043D\u043D\u044B\u0445 ZenMoney."} \u0412\u043E\u0439\u0442\u0438 \u0441\u043C\u043E\u0436\u0435\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u043B\u0430\u0434\u0435\u043B\u0435\u0446. \u0417\u0430\u043F\u0438\u0441\u044C \u0434\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C\u043D\u043E \u0437\u0430\u0432\u0438\u0441\u0438\u0442 \u043E\u0442 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u0441\u0435\u0440\u0432\u0435\u0440\u0430.</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(consent.handle)}">
<button name="decision" value="approve">\u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C \u0447\u0435\u0440\u0435\u0437 GitHub</button>
<button name="decision" value="deny">\u041E\u0442\u043C\u0435\u043D\u0430</button></form></html>`, { headers: consent.headers });
      }
      if (url.pathname === "/authorize" && request.method === "POST") {
        if (request.headers.get("origin") !== env.PUBLIC_ORIGIN) return new Response("Access denied", { status: 403 });
        const form = await request.formData();
        const handle = String(form.get("handle") ?? "");
        if (form.get("decision") !== "approve") {
          const denied = await oauth.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const approved = await oauth.approveConsent(request, handle);
        const verifier = randomBytes(32).toString("base64url");
        const transaction = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
        const github = new URL("https://github.com/login/oauth/authorize");
        github.search = new URLSearchParams({
          client_id: env.GITHUB_CLIENT_ID,
          redirect_uri: callbackUrl(env),
          state: transaction.state,
          scope: "",
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
          allow_signup: "false"
        }).toString();
        transaction.headers.set("location", github.toString());
        return new Response(null, { status: 302, headers: transaction.headers });
      }
      if (url.pathname === "/github/callback" && request.method === "GET") {
        const transaction = await oauth.finishUpstream(request);
        const code = url.searchParams.get("code");
        if (!code || url.searchParams.has("error")) {
          transaction.headers.set("location", authorizationErrorRedirect(transaction.request, "access_denied"));
          return new Response(null, { status: 302, headers: transaction.headers });
        }
        const exchange = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { accept: "application/json" },
          body: new URLSearchParams({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: callbackUrl(env),
            code_verifier: transaction.data.verifier
          }),
          signal: AbortSignal.timeout(15e3), redirect: "manual"
        });
        const token = await exchange.json();
        if (!exchange.ok || !token || typeof token !== "object" || !("access_token" in token) || typeof token.access_token !== "string") {
          throw new Error("GitHub authorization failed");
        }
        const userResponse = await fetch("https://api.github.com/user", {
          headers: { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": "private-zenmoney-bridge" },
          signal: AbortSignal.timeout(15e3), redirect: "manual"
        });
        const user = await userResponse.json();
        if (!userResponse.ok || !user || typeof user !== "object" || !("id" in user) || String(user.id) !== env.OWNER_GITHUB_ID) {
          transaction.headers.set("location", authorizationErrorRedirect(transaction.request, "access_denied"));
          return new Response(null, { status: 302, headers: transaction.headers });
        }
        const grant = await oauth.completeAuthorization({
          request: transaction.request,
          userId: env.OWNER_GITHUB_ID,
          metadata: {},
          scope: transaction.request.scope,
          props: { githubId: env.OWNER_GITHUB_ID }
        });
        transaction.headers.set("location", grant.redirectTo);
        return new Response(null, { status: 302, headers: transaction.headers });
      }
      return new Response("Method not allowed", { status: 405 });
    } catch (error) {
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        return new Response("Invalid or expired sign-in. Start the connection again from ChatGPT.", { status: 400 });
      }
      return new Response("Sign-in is temporarily unavailable", { status: 502 });
    }
  }
};
export {
  signInHandler
};
