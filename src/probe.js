/*
 * Endpoint probing — the server half.
 *
 * The page checks in checks.js can only see markup. They cannot tell you
 * whether the server actually enforces the anti-bot token it is displaying a
 * widget for, and that combination is where the expensive failures live:
 *
 *   widget renders + server does not verify  ->  the widget is decoration; a
 *                                               bot posts straight to the API
 *   widget missing + server verifies         ->  every real submission is
 *                                               rejected with a 403
 *
 * SAFETY, which matters more here than anywhere else in this tool.
 *
 * This probe POSTs to somebody's live lead endpoint. Done carelessly that
 * writes junk rows into a real CRM, and the person running the check is often
 * not the person who has to clean it up.
 *
 * So the default probe sends `{}` — an empty object, which any correct endpoint
 * rejects at validation before touching a database. It cannot create a row.
 *
 * The enforcement probe (--probe-enforcement) is opt-in precisely because it
 * CAN: it sends a well-formed payload with no anti-bot token, and if the server
 * turns out not to enforce one, that payload is accepted and stored. That is
 * the finding, and the row is the proof. Every field is therefore marked so the
 * row is unmistakable and trivially deletable — see PROBE_MARKER.
 */

export const PROBE_MARKER = "leadcheck-probe";

/** Deliberately invalid for every schema. Cannot be stored. */
const EMPTY_PAYLOAD = {};

/**
 * Well-formed enough to pass validation, and unmistakable if it lands.
 * .invalid is reserved by RFC 2606 and can never be a real address.
 */
function markedPayload() {
  return {
    name: `${PROBE_MARKER} (safe to delete)`,
    firstName: PROBE_MARKER,
    lastName: "safe-to-delete",
    email: `${PROBE_MARKER}@example.invalid`,
    message: `Automated ${PROBE_MARKER} check. No action needed. Safe to delete.`,
    subject: `${PROBE_MARKER}`,
    consentText: PROBE_MARKER,
  };
}

async function post(url, body, timeoutMs) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let text = "";
    try { text = (await res.text()).slice(0, 300); } catch { /* body optional */ }
    return { status: res.status, ms: Date.now() - started, body: text };
  } catch (err) {
    return { status: null, ms: Date.now() - started, error: String(err?.message ?? err) };
  }
}

/**
 * PROBE 1 — does the endpoint validate before it stores?
 *
 * An empty object should produce a 4xx. A 5xx means the handler threw on
 * malformed input, which is both a reliability problem and often an
 * information leak. A 2xx on `{}` is worse: it suggests the endpoint stores
 * whatever it is given.
 */
export async function probeValidation(url, { timeoutMs = 10000 } = {}) {
  const r = await post(url, EMPTY_PAYLOAD, timeoutMs);
  let passed, note;
  if (r.status === null) { passed = false; note = `request failed: ${r.error}`; }
  else if (r.status >= 400 && r.status < 500) { passed = true; note = "rejected malformed input, as expected"; }
  else if (r.status >= 500) { passed = false; note = "server error on malformed input — the handler threw rather than validating"; }
  else { passed = false; note = "accepted an EMPTY payload — the endpoint may store unvalidated input"; }

  return {
    id: "endpoint-validation",
    title: "Endpoint validates malformed input",
    severity: "fail",
    passed,
    status: r.status,
    ms: r.ms,
    findings: passed ? [] : [{ detail: note }],
    remedy: "Validate the request body and return 400 before touching storage.",
  };
}

/**
 * PROBE 2 — is the anti-bot token actually enforced? (opt-in)
 *
 * A 403 here is a PASS: the server refused a well-formed submission that
 * carried no token, which is exactly right. A 2xx is the finding — and it means
 * a marked row was just created. See the safety note at the top of this file.
 */
export async function probeEnforcement(url, { timeoutMs = 10000 } = {}) {
  const r = await post(url, markedPayload(), timeoutMs);
  const enforced = r.status === 401 || r.status === 403;
  const created = typeof r.status === "number" && r.status >= 200 && r.status < 300;

  return {
    id: "endpoint-enforcement",
    title: "Anti-bot token is enforced server-side",
    severity: "fail",
    passed: enforced,
    status: r.status,
    ms: r.ms,
    createdRow: created,
    findings: enforced
      ? []
      : created
      ? [{
          detail:
            "accepted a well-formed submission with NO anti-bot token — the " +
            `widget is decoration. A row marked "${PROBE_MARKER}" was created; delete it.`,
        }]
      : [{ detail: `unexpected status ${r.status} — could not determine whether the token is enforced` }],
    remedy:
      "Verify the token server-side before writing. The widget on the page " +
      "stops nothing: a bot posts directly to the API and never runs your JavaScript.",
  };
}
