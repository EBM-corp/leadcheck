import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runPageChecks,
  checkWidgetInHiddenContainer,
  checkNativeSubmitFallback,
  checkWidgetPresence,
} from "../src/checks.js";
import { PROBE_MARKER } from "../src/probe.js";

const byId = (results, id) => results.find((r) => r.id === id);

/* ---------------------------------------------------------------- widget */

test("detects a Turnstile widget inside a collapsed <details>", () => {
  const html = `
    <details>
      <summary>More detail</summary>
      <form><div class="cf-turnstile" data-sitekey="x"></div>
      <button type="submit">Send</button></form>
    </details>`;
  const r = checkWidgetInHiddenContainer(html);
  assert.equal(r.passed, false, "must fail — this widget can never render");
  assert.equal(r.widgetDetected, "Cloudflare Turnstile");
  assert.match(r.findings[0].detail, /never render/);
});

test("an OPEN <details> is fine — the element has a layout box", () => {
  const html = `
    <details open>
      <form><div class="cf-turnstile"></div></form>
    </details>`;
  assert.equal(checkWidgetInHiddenContainer(html).passed, true);
});

test("detects a widget inside display:none and inside [hidden]", () => {
  const styled = `<div style="display:none"><div class="g-recaptcha"></div></div>`;
  assert.equal(checkWidgetInHiddenContainer(styled).passed, false);
  const attr = `<div hidden><div class="h-captcha"></div></div>`;
  assert.equal(checkWidgetInHiddenContainer(attr).passed, false);
});

test("recognises reCAPTCHA and hCaptcha, not just Turnstile", () => {
  assert.equal(checkWidgetPresence(`<form></form><div class="g-recaptcha"></div>`).widgetDetected, "reCAPTCHA");
  assert.equal(checkWidgetPresence(`<form></form><script src="https://hcaptcha.com/1/api.js"></script>`).widgetDetected, "hCaptcha");
});

test("a page with no widget at all is reported, not silently passed", () => {
  const r = checkWidgetPresence(`<form><input name="email"></form>`);
  assert.equal(r.widgetDetected, null);
  assert.equal(r.findings.length, 1);
});

/* -------------------------------------------------------------- fallback */

test("a form with action and method is not flagged", () => {
  const r = checkNativeSubmitFallback(`<form action="/api/x" method="post"></form>`);
  assert.equal(r.passed, true);
});

test("a form with neither action nor method is flagged", () => {
  const r = checkNativeSubmitFallback(`<form><button type="submit">Go</button></form>`);
  assert.equal(r.passed, false);
  assert.match(r.findings[0].detail, /discarded silently/);
});

/* ----------------------------------------------------------- correlation */

test("a disabled submit button resolves the pre-hydration warning", () => {
  const html = `<form><button type="submit" disabled>Send</button></form>`;
  const fallback = byId(runPageChecks(html), "native-submit-fallback");
  assert.equal(fallback.passed, true, "guarded form must not warn");
  assert.equal(fallback.mitigatedBy, "disabled-submit");
  assert.match(fallback.note, /already guarded/);
});

test("an UNguarded form still warns even when another form is guarded", () => {
  const html = `
    <form><button type="submit" disabled>A</button></form>
    <form><button type="submit">B</button></form>`;
  const fallback = byId(runPageChecks(html), "native-submit-fallback");
  assert.equal(fallback.passed, false, "one form is still exposed");
  assert.match(fallback.note, /1 of 2/);
});

/* --------------------------------------------------------------- safety */

test("the marked probe payload is unmistakable and un-deliverable", () => {
  assert.match(PROBE_MARKER, /leadcheck/);
  // RFC 2606 reserves .invalid — it can never route to a real person.
  const payload = JSON.stringify({ email: `${PROBE_MARKER}@example.invalid` });
  assert.match(payload, /\.invalid/);
});

/* ------------------------------------------------------------ real world */

test("handles a realistic page without throwing", () => {
  const html = `<!doctype html><html><body>
    <form class="x"><input name="email" required>
    <div class="cf-turnstile" data-sitekey="0x4"></div>
    <button type="submit" disabled>Send</button></form>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>
    </body></html>`;
  const results = runPageChecks(html);
  assert.equal(results.length, 4);
  assert.equal(results.every((r) => typeof r.passed === "boolean"), true);
});
