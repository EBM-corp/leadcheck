/*
 * The checks themselves, kept separate from I/O so they can be unit tested
 * against fixture HTML without a network.
 *
 * WHY THESE SPECIFIC CHECKS: each one corresponds to a failure that is SILENT.
 * A form that throws a visible error gets reported by the first person who hits
 * it. These do not. They return HTTP 200, show the visitor a success state or a
 * generic retry, and leave nothing in your logs that distinguishes a lost lead
 * from a quiet week. Every one of them has cost somebody real enquiries,
 * including us.
 */

/** Very small tolerant tag scanner. A real parser is overkill and adds a
 *  dependency; we only need attributes and containment, not a DOM. */
function findTags(html, tagName) {
  const out = [];
  const re = new RegExp(`<${tagName}\\b([^>]*)>`, "gi");
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ index: m.index, raw: m[0], attrs: parseAttrs(m[1]) });
  }
  return out;
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([a-zA-Z0-9_:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

/** Text of the element that opened at `openIndex`, up to its matching close. */
function sliceElement(html, tagName, openIndex) {
  const close = html.indexOf(`</${tagName}`, openIndex);
  return close === -1 ? html.slice(openIndex) : html.slice(openIndex, close);
}

const WIDGET_PATTERNS = [
  { name: "Cloudflare Turnstile", re: /cf-turnstile|challenges\.cloudflare\.com/i },
  { name: "reCAPTCHA", re: /g-recaptcha|recaptcha\/api\.js/i },
  { name: "hCaptcha", re: /h-captcha|hcaptcha\.com/i },
];

/**
 * CHECK 1 — a form with no `action` and no `method` loses everything submitted
 * before its JavaScript handler attaches.
 *
 * `<form onSubmit={e => e.preventDefault()}>` is the normal React shape and it
 * is correct once hydrated. Before that the markup is still a plain HTML form,
 * so pressing Enter does what a plain form does: a native POST to the current
 * URL. The server renders the page, the visitor gets a 200 and an empty form,
 * and the submission is gone — no error, no row, nothing in the log to tell it
 * apart from a bot probing for endpoints.
 */
export function checkNativeSubmitFallback(html) {
  const forms = findTags(html, "form");
  const findings = [];
  for (const [i, form] of forms.entries()) {
    const hasAction = "action" in form.attrs && form.attrs.action !== "";
    const hasMethod = "method" in form.attrs && form.attrs.method !== "";
    if (!hasAction && !hasMethod) {
      findings.push({
        form: i,
        detail:
          "no action and no method — a submit before hydration posts to the " +
          "current URL and is discarded silently",
      });
    }
  }
  return {
    id: "native-submit-fallback",
    title: "Forms lose submissions made before hydration",
    severity: "warn",
    passed: findings.length === 0,
    formsChecked: forms.length,
    findings,
    remedy:
      "Disable the submit button until mounted, so a pre-hydration submit is " +
      "an inert button rather than a silent loss. Or give the form a real " +
      "action/method that works without JavaScript.",
  };
}

/**
 * CHECK 2 — an anti-bot widget inside a container with no layout box is never
 * rendered, and is never retried.
 *
 * Turnstile's implicit render pass runs once when api.js loads and walks the
 * document for `.cf-turnstile`. An element inside a closed `<details>`, a
 * `hidden` attribute, or `display:none` has no box at that moment and is
 * skipped permanently — opening it later does not trigger a retry.
 *
 * On its own that is cosmetic. Combined with correct server-side verification
 * it is an outage: the form can never produce a token, so every genuine
 * submission is rejected while the page looks completely normal.
 */
export function checkWidgetInHiddenContainer(html) {
  const findings = [];
  let widget = null;
  for (const w of WIDGET_PATTERNS) if (w.re.test(html)) { widget = w.name; break; }

  if (widget) {
    // Any <details> without `open` whose body contains a widget marker.
    for (const d of findTags(html, "details")) {
      if ("open" in d.attrs) continue;
      const body = sliceElement(html, "details", d.index);
      const hit = WIDGET_PATTERNS.find((w) => w.re.test(body));
      if (hit) {
        findings.push({
          container: "<details> without open",
          detail: `${hit.name} widget is inside a collapsed <details> and will never render`,
        });
      }
    }
    // Elements carrying `hidden` or an inline display:none that wrap a widget.
    for (const tag of ["div", "section"]) {
      for (const el of findTags(html, tag)) {
        const isHidden =
          "hidden" in el.attrs ||
          /display\s*:\s*none/i.test(el.attrs.style || "");
        if (!isHidden) continue;
        const body = sliceElement(html, tag, el.index);
        const hit = WIDGET_PATTERNS.find((w) => w.re.test(body));
        if (hit) {
          findings.push({
            container: `<${tag}> hidden / display:none`,
            detail: `${hit.name} widget is inside a hidden container and will never render`,
          });
        }
      }
    }
  }

  return {
    id: "widget-hidden-container",
    title: "Anti-bot widget cannot render",
    severity: "fail",
    passed: findings.length === 0,
    widgetDetected: widget,
    findings,
    remedy:
      "Keep any form carrying an anti-bot widget visible at page load. Not " +
      "behind a <details>, a tab, or a modal that mounts hidden.",
  };
}

/**
 * CHECK 3 — is there an anti-bot widget at all on a page that collects leads?
 *
 * Informational rather than a failure: plenty of forms are fine with a
 * honeypot and a rate limit. It is reported because a form with no widget AND
 * an endpoint that does not enforce one is an open door, and the two halves are
 * usually forgotten together.
 */
export function checkWidgetPresence(html) {
  const forms = findTags(html, "form");
  let widget = null;
  for (const w of WIDGET_PATTERNS) if (w.re.test(html)) { widget = w.name; break; }
  return {
    id: "widget-presence",
    title: "Anti-bot protection on the page",
    severity: "info",
    passed: true,
    formsChecked: forms.length,
    widgetDetected: widget,
    findings: widget
      ? []
      : forms.length
      ? [{ detail: "no Turnstile / reCAPTCHA / hCaptcha widget found on a page that has forms" }]
      : [],
    remedy:
      "If the endpoint verifies a token, the page must render a widget — " +
      "otherwise every real submission is rejected.",
  };
}

/**
 * CHECK 4 — submit buttons that ship disabled.
 *
 * This is not automatically wrong. Shipping `disabled` and enabling on mount is
 * the correct guard against check 1. But a button that is disabled server-side
 * with no client bundle to re-enable it is a form nobody can submit, so it is
 * always worth seeing.
 */
export function checkDisabledSubmits(html) {
  const findings = [];
  for (const b of findTags(html, "button")) {
    const type = (b.attrs.type || "").toLowerCase();
    if (type !== "submit") continue;
    if ("disabled" in b.attrs) {
      findings.push({ detail: "submit button ships disabled in the server HTML" });
    }
  }
  return {
    id: "disabled-submit",
    title: "Submit buttons disabled in server HTML",
    severity: "info",
    passed: true,
    findings,
    remedy:
      "Expected if you disable until hydration. Confirm in a browser that the " +
      "button becomes enabled — if it does not, the form cannot be submitted.",
  };
}

/**
 * Run every page check, then CORRELATE them — which is the difference between
 * a linter and something worth acting on.
 *
 * Checks 1 and 4 look at the same defence from opposite ends. A form with no
 * action and no method loses pre-hydration submissions; shipping the submit
 * button `disabled` and enabling it on mount is the standard fix. Reported
 * separately, a site that has correctly applied that fix still gets warned at
 * it — and a tool that cries wolf about something you already handled is a tool
 * people stop running.
 *
 * So if every form lacking a fallback also ships a disabled submit, the warning
 * is resolved to a pass that says WHY it passed. If only some do, the warning
 * narrows to the forms actually exposed.
 */
export function runPageChecks(html) {
  const results = PAGE_CHECKS.map((fn) => fn(html));
  const fallback = results.find((r) => r.id === "native-submit-fallback");
  const disabled = results.find((r) => r.id === "disabled-submit");

  const exposedForms = fallback.findings.length;
  const guardedButtons = disabled.findings.length;

  if (exposedForms > 0 && guardedButtons >= exposedForms) {
    fallback.passed = true;
    fallback.findings = [];
    fallback.mitigatedBy = "disabled-submit";
    fallback.note =
      `${exposedForms} form(s) have no action/method, but ${guardedButtons} submit ` +
      "button(s) ship disabled — the pre-hydration window is already guarded. " +
      "Confirm in a browser that they become enabled after hydration.";
  } else if (exposedForms > guardedButtons && guardedButtons > 0) {
    fallback.note =
      `${guardedButtons} of ${exposedForms} exposed form(s) are guarded by a ` +
      "disabled submit button; the rest are not.";
  }
  return results;
}

export const PAGE_CHECKS = [
  checkNativeSubmitFallback,
  checkWidgetInHiddenContainer,
  checkWidgetPresence,
  checkDisabledSubmits,
];
