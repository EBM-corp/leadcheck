# leadcheck

**leadcheck finds the ways a lead form fails silently.** It fetches a page, inspects the forms on it, and optionally probes the endpoint behind them — looking specifically for failures that return HTTP 200, show the visitor nothing unusual, and leave no trace in your logs.

```bash
npx leadcheck https://example.com/contact
```

```
leadcheck https://example.com/contact

  ✗ Anti-bot widget cannot render
      → Cloudflare Turnstile widget is inside a collapsed <details> and will never render
      fix: Keep any form carrying an anti-bot widget visible at page load.
  ! Forms lose submissions made before hydration
      → no action and no method — a submit before hydration posts to the current URL
        and is discarded silently
  ✓ Anti-bot protection on the page
  i Submit buttons disabled in server HTML

  1 failing, 1 warning, 4 checks
```

## Why silent failures specifically

A form that throws a visible error gets reported by the first person who hits it. These do not:

| Failure | What the visitor sees | What you see |
|---|---|---|
| Submit before hydration | Page reloads, form empty | Nothing. A 200 in the access log. |
| Anti-bot widget never rendered | Generic "try again" forever | 403s you assume are bots |
| Endpoint doesn't verify its own token | Everything works | Everything works — including for bots |
| Endpoint 500s on bad input | Generic error | An exception, if you happen to look |

Each of these has cost somebody real enquiries. The third and fourth cost *us* real enquiries, which is why this exists.

## What it checks

**1. Pre-hydration submit loss.** A `<form onSubmit={e => e.preventDefault()}>` with no `action` and no `method` is the normal React shape, and it is correct — once hydrated. Before that the markup is still a plain HTML form, so a submit does what a plain form does: a native POST to the current URL. The server renders the page, the visitor gets a 200 and a blank form, and the submission is gone.

leadcheck also **correlates** this with check 4: if your submit buttons ship `disabled`, you have already applied the standard mitigation, and the warning resolves to a pass that explains why. A tool that warns you about something you have already handled is a tool people stop running.

**2. An anti-bot widget that can never render.** Turnstile's implicit render pass runs *once*, when `api.js` loads, and walks the document for `.cf-turnstile`. An element inside a collapsed `<details>`, a `hidden` container, or `display:none` has no layout box at that moment — it is skipped, and **opening it later does not retry**.

On its own that is cosmetic. Combined with correct server-side verification it is an outage: the form can never produce a token, so every genuine submission is rejected with a 403 while the page looks perfectly normal. Detects Turnstile, reCAPTCHA and hCaptcha.

**3. Whether the endpoint validates.** Sends `{}` and expects a 4xx. A 5xx means the handler threw rather than validated. A 2xx on an empty object is worse.

**4. Whether the anti-bot token is actually enforced** (opt-in). The widget on your page stops nothing by itself — a bot POSTs straight to your API and never runs your JavaScript. The only thing that stops it is checking the token server-side.

## Usage

```bash
# Page checks only — no requests to your API
npx leadcheck https://example.com/contact

# Also probe the endpoint. Sends {} — cannot create a row.
npx leadcheck https://example.com/contact --endpoint https://example.com/api/contact

# Additionally test whether the token is enforced. See "Safety" below.
npx leadcheck https://example.com/contact \
  --endpoint https://example.com/api/contact --probe-enforcement

# Machine-readable, for CI
npx leadcheck https://example.com/contact --json
```

| Option | |
|---|---|
| `--endpoint <url>` | probe the API behind the form |
| `--probe-enforcement` | test token enforcement — **may write one marked row** |
| `--json` | machine-readable output |
| `--timeout <ms>` | per-request timeout (default 10000) |

**Exit codes:** `0` no failures · `1` at least one failure · `2` could not run. Suitable for CI.

## Safety

This tool POSTs to live lead endpoints. Done carelessly that writes junk into somebody's real CRM, and the person running the check is often not the person who has to clean it up. So:

- **The default probe sends `{}`** — an empty object, which any correct endpoint rejects at validation before touching a database. It cannot create a row.
- **`--probe-enforcement` is opt-in because it can.** It sends a well-formed payload with no anti-bot token. If the server turns out not to enforce one, that payload is accepted and stored — and that *is* the finding; the row is the proof.
- Every field in that payload is marked `leadcheck-probe`, and the address uses `.invalid`, which [RFC 2606](https://datatracker.ietf.org/doc/html/rfc2606) reserves so it can never route to a real person. If a row appears, it is unmistakable and trivially deletable.

Only run `--probe-enforcement` against a site you are responsible for.

## Use in CI

```yaml
- run: npx leadcheck https://example.com/contact --endpoint https://example.com/api/contact
```

The check fails the build if a form can no longer capture. This is worth having because form breakage is nearly always collateral damage from an unrelated change — a layout refactor that wraps a form in a disclosure, a framework upgrade that changes hydration timing.

## Development

```bash
npm test          # 11 tests, no dependencies
```

The test suite is mutation-tested: breaking the `<details>` check, the correlation logic, or the widget patterns each makes it fail. Tests that pass against broken code are worse than no tests.

## Why this exists

We shipped every one of these bugs on our own site.

A long enquiry form was moved behind a collapsed `<details>` to reduce friction on mobile. The Turnstile widget inside it stopped rendering, and because the endpoint correctly verified the token, **every submission through that form was rejected with a 403 for hours** — with nothing in the logs to distinguish it from a quiet week.

Then, while fixing it, we enabled verification on a second endpoint *before* confirming its page could produce a token, and took the primary contact form down entirely.

The full write-up is here: [Cloudflare Turnstile never renders inside a collapsed `<details>`](https://ebmcorporation.com/blog/turnstile-collapsed-details-never-renders).

Built by [EBM Corporation](https://ebmcorporation.com) — we build and run software for businesses, which means we also run into things like this.

## Licence

MIT — see [LICENSE](LICENSE).
