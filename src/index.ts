interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Oklahoma Statutes — state statutes by citation, full-text topic search,
 * amendment history, and historical (superseded) versions.
 *
 * SOURCE AND THE SURVEY TRAP (fleet #2742). The August state-law survey
 * (docs/state-law-probe.md) flagged Oklahoma as "published only as PDF" —
 * oklegislature.gov serves each of the 94 titles as one ~1.2 MB per-title
 * PDF, no per-section split. Looking past that trap the way CO/IN/NJ/GA/KY
 * did: OSCN, the Oklahoma State Courts Network (oscn.net), serves the full
 * "Oklahoma Statutes Citationized" (STOKST) as live HTML, keyless, bare-UA,
 * current through the 2025 legislative session plus at least one
 * 2026-effective 2025 amendment (verified live 2026-10-06 against 21 O.S. §
 * 701.7, whose own "Cite as" line reads "(OSCN 2026)"). This is a genuinely
 * BETTER source than the PDF-extraction packs in this family: OSCN runs a
 * real full-text search engine over statutory body text (not just
 * catchlines) AND keeps superseded prior versions of every amended section
 * on separate, directly linked pages — so Oklahoma gets all four
 * capabilities (citation lookup, topic/full-text search, amendment history,
 * and historical versions), none of them approximated.
 *
 * NAVIGATION SHAPE, two hops:
 *   1. Index.asp?ftdb=<title dbcode>&level=1 — the whole title's directory,
 *      FLATTENED: every section anchor (`<a name="CiteIDnnnn"
 *      href="DeliverDocument.asp?CiteID=nnnn">§ 701.7. Murder in the First
 *      Degree</a>`) appears on one page, because this database's directory
 *      tree is only Title -> Document; there is no intermediate per-chapter
 *      URL to fetch instead (confirmed live: chapter headers are inline
 *      `<h2 class="chapter">` markers within the same flattened page, not
 *      separate dbcodes). Title dbcodes are NOT derivable from the title
 *      number for the ~15 lettered titles (10A is `STOKSTA1`, not
 *      `STOKST10A`; 75A is `STOKSTB5`) — TITLES below is the full static
 *      map read directly off the master index page.
 *   2. deliverdocument.asp?citeid=<id>&PrintOnly=true — the section itself.
 *      Dropping `PrintOnly` would also work but costs ~20x more: the normal
 *      view re-embeds the ENTIRE title's navigation tree on every single
 *      section page (272 KB for one section of Title 21, confirmed live),
 *      where PrintOnly strips that tree and returns just the breadcrumb +
 *      statute text + history (14 KB for the same section). Always pass it.
 *
 * SIZE DISCIPLINE. Title index pages range from ~65 KB (Title 85) to ~610 KB
 * (Title 74, State Government) — this is plain HTML parsed with a handful of
 * regexes, not a binary PDF needing font/stream decoding, so unlike the
 * per-title PDF fallback this task was built to avoid, there is no local
 * shard to build: OSCN's own structural minimum (one title) is the smallest
 * unit it offers, verified live, and is cheap to parse even at its largest.
 * ok_statute still does only ONE such fetch per call (resolve citation ->
 * CiteID) plus one small PrintOnly fetch — never a second title fetch for
 * the same call.
 *
 * AMENDMENT HISTORY AND HISTORICAL VERSIONS. Every amended section's
 * PrintOnly page ends with a `<b><i>Historical Data</i></b>` marker followed
 * by one paragraph chaining every amending Act, e.g. "Amended by Laws 2025,
 * HB 2104, c. 486, § 1, eff. January 1, 2026 (superseded document
 * available)." Each "(superseded document available)" is a direct link to
 * that PRIOR version's own CiteID — fetching IT through the same
 * deliverdocument.asp?citeid=...&PrintOnly=true route returns the statute
 * exactly as it read before that amendment, headed "Superceded On:
 * <date>" (OSCN's own spelling). ok_statute surfaces these as
 * `historical_versions`; pass one of their `citeid` values back in as
 * `version_citeid` to retrieve that version's text directly, skipping
 * citation resolution entirely.
 *
 * SEARCH. Search.asp?ftdb=STOKST&quick=true&query=<q> is a real full-text
 * search over statutory body text, not a catchline/caption index — verified
 * live: "landlord" returns 25 hits including sections whose caption never
 * says "landlord" (e.g. "Termination of Tenancy", 41 O.S. § 111). Each hit
 * carries its own `deliverdocument.asp?id=<id>` link, usable the same way as
 * a CiteID.
 *
 * Keyless, no signup, no session/cookie state across the two hops.
 */

const UA = 'pipeworx-mcp-oklahoma-code/1.0 (+https://pipeworx.io)';
const UPSTREAM = 'Oklahoma State Courts Network (oscn.net)';
const BASE = 'https://www.oscn.net/applications/oscn';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, UPSTREAM);
}

/** Title number (as it appears in a citation, e.g. "21", "10A", "85A") ->
 *  OSCN's internal dbcode for that title's STOKST directory. Read directly
 *  off https://www.oscn.net/applications/oscn/index.asp?ftdb=STOKST
 *  (verified live 2026-10-06) — the lettered titles are NOT a derivable
 *  pattern (10A is STOKSTA1, 12A is STOKSTA2, 14A is STOKSTA4, 27A is
 *  STOKSTA9, 37A is STOKSTA3, 43A is STOKSTA7, 75A is STOKSTB5, 85A is
 *  STOKSTB1 — sequential assignment, not title-derived), so this is a
 *  verbatim static table rather than a formula.
 */
const TITLES: Record<string, { name: string; dbcode: string }> = {
  '1': { name: 'Abstracting', dbcode: 'STOKST01' },
  '2': { name: 'Agriculture', dbcode: 'STOKST02' },
  '3': { name: 'Aerospace, Aircraft, and Aviation Infrastructure', dbcode: 'STOKST03' },
  '3A': { name: 'Amusements and Sports', dbcode: 'STOKST3A' },
  '4': { name: 'Animals', dbcode: 'STOKST04' },
  '5': { name: 'Attorneys and the State Bar', dbcode: 'STOKST05' },
  '6': { name: 'Banks and Trust Companies', dbcode: 'STOKST06' },
  '7': { name: 'Blind Persons', dbcode: 'STOKST07' },
  '8': { name: 'Cemeteries', dbcode: 'STOKST08' },
  '9': { name: 'Census', dbcode: 'STOKST09' },
  '10': { name: 'Children', dbcode: 'STOKST10' },
  '10A': { name: 'Children and Juvenile Code', dbcode: 'STOKSTA1' },
  '11': { name: 'Cities and Towns', dbcode: 'STOKST11' },
  '12': { name: 'Civil Procedure', dbcode: 'STOKST12' },
  '12A': { name: 'Uniform Commercial Code', dbcode: 'STOKSTA2' },
  '13': { name: 'Common Carriers', dbcode: 'STOKST13' },
  '14': { name: 'Congressional and Legislative Districts', dbcode: 'STOKST14' },
  '14A': { name: 'Consumer Credit Code', dbcode: 'STOKSTA4' },
  '15': { name: 'Contracts', dbcode: 'STOKST15' },
  '16': { name: 'Conveyances', dbcode: 'STOKST16' },
  '17': { name: 'Corporation Commission', dbcode: 'STOKST17' },
  '18': { name: 'Corporations', dbcode: 'STOKST18' },
  '19': { name: 'Counties and County Officers', dbcode: 'STOKST19' },
  '20': { name: 'Courts', dbcode: 'STOKST20' },
  '21': { name: 'Crimes and Punishments', dbcode: 'STOKST21' },
  '22': { name: 'Criminal Procedure', dbcode: 'STOKST22' },
  '23': { name: 'Damages', dbcode: 'STOKST23' },
  '24': { name: 'Debtor and Creditor', dbcode: 'STOKST24' },
  '25': { name: 'Definitions and General Provisions', dbcode: 'STOKST25' },
  '26': { name: 'Elections', dbcode: 'STOKST26' },
  '27': { name: 'Eminent Domain', dbcode: 'STOKST27' },
  '27A': { name: 'Environment and Natural Resources', dbcode: 'STOKSTA9' },
  '28': { name: 'Fees', dbcode: 'STOKST28' },
  '29': { name: 'Game and Fish', dbcode: 'STOKST29' },
  '30': { name: 'Guardian and Ward', dbcode: 'STOKST30' },
  '31': { name: 'Homestead and Exemptions', dbcode: 'STOKST31' },
  '32': { name: 'Husband and Wife', dbcode: 'STOKST32' },
  '33': { name: 'Inebriates', dbcode: 'STOKST33' },
  '34': { name: 'Initiative and Referendum', dbcode: 'STOKST34' },
  '35': { name: 'Insane and Feeble Minded Persons', dbcode: 'STOKST35' },
  '36': { name: 'Insurance', dbcode: 'STOKST36' },
  '37': { name: 'Intoxicating Liquors', dbcode: 'STOKST37' },
  '37A': { name: 'Alcoholic Beverages', dbcode: 'STOKSTA3' },
  '38': { name: 'Jurors', dbcode: 'STOKST38' },
  '39': { name: 'Justices and Constables', dbcode: 'STOKST39' },
  '40': { name: 'Labor', dbcode: 'STOKST40' },
  '41': { name: 'Landlord and Tenant', dbcode: 'STOKST41' },
  '42': { name: 'Liens', dbcode: 'STOKST42' },
  '43': { name: 'Marriage', dbcode: 'STOKST43' },
  '43A': { name: 'Mental Health', dbcode: 'STOKSTA7' },
  '44': { name: 'Militia', dbcode: 'STOKST44' },
  '45': { name: 'Mines and Mining', dbcode: 'STOKST45' },
  '46': { name: 'Mortgages', dbcode: 'STOKST46' },
  '47': { name: 'Motor Vehicles', dbcode: 'STOKST47' },
  '48': { name: 'Negotiable Instruments', dbcode: 'STOKST48' },
  '49': { name: 'Notaries Public', dbcode: 'STOKST49' },
  '50': { name: 'Nuisances', dbcode: 'STOKST50' },
  '51': { name: 'Officers', dbcode: 'STOKST51' },
  '52': { name: 'Oil and Gas', dbcode: 'STOKST52' },
  '53': { name: 'Oklahoma Historical Societies and Associations', dbcode: 'STOKST53' },
  '54': { name: 'Partnership', dbcode: 'STOKST54' },
  '55': { name: 'Pledges', dbcode: 'STOKST55' },
  '56': { name: 'Poor Persons', dbcode: 'STOKST56' },
  '57': { name: 'Prisons and Reformatories', dbcode: 'STOKST57' },
  '58': { name: 'Probate Procedure', dbcode: 'STOKST58' },
  '59': { name: 'Professions and Occupations', dbcode: 'STOKST59' },
  '60': { name: 'Property', dbcode: 'STOKST60' },
  '61': { name: 'Public Buildings and Public Works', dbcode: 'STOKST61' },
  '62': { name: 'Public Finance', dbcode: 'STOKST62' },
  '63': { name: 'Public Health and Safety', dbcode: 'STOKST63' },
  '64': { name: 'Public Lands', dbcode: 'STOKST64' },
  '65': { name: 'Public Libraries', dbcode: 'STOKST65' },
  '66': { name: 'Railroads', dbcode: 'STOKST66' },
  '67': { name: 'Records', dbcode: 'STOKST67' },
  '68': { name: 'Revenue and Taxation', dbcode: 'STOKST68' },
  '69': { name: 'Roads, Bridges, and Ferries', dbcode: 'STOKST69' },
  '70': { name: 'Schools', dbcode: 'STOKST70' },
  '71': { name: 'Securities', dbcode: 'STOKST71' },
  '72': { name: 'Soldiers and Sailors', dbcode: 'STOKST72' },
  '73': { name: 'State Capital and Capitol Building', dbcode: 'STOKST73' },
  '74': { name: 'State Government', dbcode: 'STOKST74' },
  '75': { name: 'Statutes and Reports', dbcode: 'STOKST75' },
  '75A': { name: 'Technology', dbcode: 'STOKSTB5' },
  '76': { name: 'Torts', dbcode: 'STOKST76' },
  '77': { name: 'Townships and Township Officers', dbcode: 'STOKST77' },
  '78': { name: 'Trade Marks and Labels', dbcode: 'STOKST78' },
  '79': { name: 'Trusts and Pools', dbcode: 'STOKST79' },
  '80': { name: 'United States', dbcode: 'STOKST80' },
  '81': { name: 'Warehouses', dbcode: 'STOKST81' },
  '82': { name: 'Waters and Water Rights', dbcode: 'STOKST82' },
  '83': { name: 'Weights and Measures', dbcode: 'STOKST83' },
  '84': { name: 'Wills and Succession', dbcode: 'STOKST84' },
  '85': { name: "Workers' Compensation", dbcode: 'STOKST85' },
  '85A': { name: "Workers' Compensation", dbcode: 'STOKSTB1' },
};

/** "21-701.7", "21 O.S. 701.7", "21 O.S. § 701.7", "Title 21, Section
 *  701.7" -> { title: "21", section: "701.7" }. Returns null when nothing
 *  recognizable splits into a title and a section. */
function parseCitation(raw: string): { title: string; section: string } | null {
  let s = raw.trim();
  s = s.replace(/^title\s+/i, '');
  s = s.replace(/§/g, ' ');
  s = s.replace(/\bO\.?\s*S\.?\s*A?\.?\b/gi, ' ');
  s = s.replace(/\bsec(?:tion)?\.?\b/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // Now s should look like "21 701.7", "21-701.7", "21, 701.7", or "21:701.7".
  const m = /^(\d+[A-Z]?)\s*[-,:]?\s*([0-9]+[A-Z]?(?:\.[0-9]+[A-Z]?)?)$/i.exec(s);
  if (!m) return null;
  return { title: m[1]!.toUpperCase(), section: m[2]! };
}

interface PrintOnlyDoc {
  heading: string | null;
  chapterPath: string[];
  citeAs: string | null;
  text: string;
  history: string | null;
  historicalVersions: Array<{ citeid: number; amendment: string }>;
  supersededOn: string | null;
}

/** Parse the output of deliverdocument.asp?citeid=...&PrintOnly=true. */
function parsePrintOnly(html: string): PrintOnlyDoc {
  const headingMatch = /<FONT SIZE=1>Section&nbsp;([^<]+)<BR>/i.exec(html)
    ?? /Section&nbsp;([^<]+?)(?:<BR>|$)/i.exec(html);
  const heading = headingMatch ? stripMarkup(headingMatch[1]!).trim() || null : null;

  const chapterPath: string[] = [];
  const pathRe = /WDFolderOpen\.gif["'][^>]*>(?:<\/a>)?\s*([^<]+?)<BR>/gi;
  for (let m = pathRe.exec(html); m; m = pathRe.exec(html)) {
    const label = stripMarkup(m[1]!).trim();
    if (label && !/^Oklahoma Statutes Citationized$/i.test(label)) chapterPath.push(label);
  }

  const citeAsMatch = /Cite as:\s*([^<]+)</i.exec(html);
  const citeAs = citeAsMatch ? stripMarkup(citeAsMatch[1]!).trim() : null;

  const supersededMatch = /Superceded On:\s*([0-9/]+)/i.exec(html);
  const supersededOn = supersededMatch ? supersededMatch[1]! : null;

  const beginIdx = html.indexOf('BEGIN DOCUMENT-->');
  const endIdx = html.indexOf('END DOCUMENT');
  const body = beginIdx >= 0 && endIdx > beginIdx ? html.slice(beginIdx + 'BEGIN DOCUMENT-->'.length, endIdx) : '';

  const paragraphs: string[] = [];
  const pRe = /<p>([\s\S]*?)<\/p>/gi;
  for (let m = pRe.exec(body); m; m = pRe.exec(body)) paragraphs.push(m[1]!);

  let historyIdx = -1;
  for (let i = 0; i < paragraphs.length; i++) {
    if (/^\s*<b>\s*<i>\s*Historical Data\s*<\/i>\s*<\/b>\s*$/i.test(paragraphs[i]!)) {
      historyIdx = i;
      break;
    }
  }

  const textParas = historyIdx >= 0 ? paragraphs.slice(0, historyIdx) : paragraphs;
  const text = textParas
    .map((p) => stripMarkup(p).trim())
    .filter(Boolean)
    .join('\n\n');

  let history: string | null = null;
  const historicalVersions: Array<{ citeid: number; amendment: string }> = [];
  if (historyIdx >= 0) {
    const historyParas = paragraphs.slice(historyIdx + 1);
    const rawHistory = historyParas.join(' ');
    history = stripMarkup(rawHistory).trim() || null;

    const linkRe = /<a href="DeliverDocument\.asp\?citeid=(\d+)">superseded document available<\/a>/gi;
    let lastEnd = 0;
    for (let m = linkRe.exec(rawHistory); m; m = linkRe.exec(rawHistory)) {
      const citeid = Number(m[1]);
      const segment = rawHistory.slice(lastEnd, m.index);
      const semiIdx = segment.lastIndexOf(';');
      const amendment = stripMarkup(segment.slice(semiIdx + 1)).trim().replace(/^[.;]\s*/, '').replace(/\s*\($/, '');
      historicalVersions.push({ citeid, amendment: amendment || '(amendment description unavailable)' });
      lastEnd = m.index + m[0].length;
    }
  }

  return { heading, chapterPath, citeAs, text, history, historicalVersions, supersededOn };
}

async function fetchPrintOnly(citeid: number): Promise<PrintOnlyDoc> {
  const url = `${BASE}/deliverdocument.asp?citeid=${citeid}&PrintOnly=true`;
  const res = await pwFetch(url);
  if (!res.ok) throw await httpError(res, UPSTREAM);
  const buf = await res.arrayBuffer();
  const html = new TextDecoder('iso-8859-1').decode(buf);
  return parsePrintOnly(html);
}

/** Resolve a title+section citation to its OSCN CiteID by scanning that
 *  title's flattened index page. One fetch — see the file header for why
 *  there is no smaller unit to fetch instead. */
async function resolveCiteId(title: string, section: string): Promise<{ citeid: number; titleName: string } | { error: 'unknown_title' } | { error: 'section_not_found'; titleName: string; near: string[] }> {
  const titleInfo = TITLES[title];
  if (!titleInfo) return { error: 'unknown_title' };

  const url = `${BASE}/Index.asp?ftdb=${titleInfo.dbcode}&level=1`;
  const res = await pwFetch(url);
  if (!res.ok) throw await httpError(res, UPSTREAM);
  const buf = await res.arrayBuffer();
  const html = new TextDecoder('iso-8859-1').decode(buf);

  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // "\xa7" is the section-sign byte OSCN uses as a literal prefix in its own
  // ISO-8859-1 markup, decoded by TextDecoder above.
  const headingRe = new RegExp(`name="CiteID(\\d+)"[^>]*>\\s*\\xa7\\s*${escaped}\\.[^<]*<`, 'i');
  const m = headingRe.exec(html);
  if (m) return { citeid: Number(m[1]), titleName: titleInfo.name };

  // Nothing exact — collect a few nearby section numbers for the "near" hint.
  const allRe = /\xa7\s*([0-9]+[A-Z]?(?:\.[0-9]+[A-Z]?)?)\./g;
  const seen = new Set<string>();
  const prefix = section.split('.')[0]!;
  for (let a = allRe.exec(html); a && seen.size < 8; a = allRe.exec(html)) {
    if (a[1]!.startsWith(prefix)) seen.add(a[1]!);
  }
  return { error: 'section_not_found', titleName: titleInfo.name, near: Array.from(seen) };
}

async function okStatute(args: Record<string, unknown>) {
  const versionCiteId = args.version_citeid !== undefined && args.version_citeid !== null && args.version_citeid !== ''
    ? Number(args.version_citeid)
    : null;

  const rawCitation = String(args.citation ?? '').trim();

  if (versionCiteId !== null) {
    if (!Number.isInteger(versionCiteId) || versionCiteId <= 0) {
      return {
        found: false, reason: 'bad_version_citeid',
        message: `"${args.version_citeid}" is not a valid version_citeid — pass the integer "citeid" field from a previous result's historical_versions array.`,
      };
    }
    const doc = await fetchPrintOnly(versionCiteId);
    if (!doc.text) {
      return {
        found: false, reason: 'version_not_found', version_citeid: versionCiteId,
        message: `OSCN returned no statutory text for citeid ${versionCiteId}.`,
        source: `${UPSTREAM}, keyless`,
      };
    }
    return {
      found: true,
      citation: rawCitation || undefined,
      heading: doc.heading,
      chapter_path: doc.chapterPath,
      cite_as: doc.citeAs,
      text: doc.text,
      text_chars: doc.text.length,
      is_historical: true,
      superseded_on: doc.supersededOn,
      history: doc.history,
      version_citeid: versionCiteId,
      url: `${BASE}/deliverdocument.asp?citeid=${versionCiteId}`,
      source: `${UPSTREAM}, superseded version, keyless`,
      attribution: 'Oklahoma statutes are public record.',
      data_as_of: new Date().toISOString(),
    };
  }

  if (!rawCitation) {
    return {
      found: false, reason: 'empty_citation',
      message: 'ok_statute needs a "citation", e.g. "21-701.7" (murder) or "41-111" (termination of tenancy).',
    };
  }
  const parsed = parseCitation(rawCitation);
  if (!parsed) {
    return {
      found: false, reason: 'unparsed_citation',
      message: `"${rawCitation}" is not an Oklahoma Statutes citation.`,
      hint: 'Oklahoma citations are title-section, e.g. "21-701.7" or "21 O.S. 701.7" (Title 21 Crimes and Punishments, Section 701.7). Call ok_titles to see the 94 titles, or ok_search to find a citation by topic.',
    };
  }

  const resolved = await resolveCiteId(parsed.title, parsed.section);
  if ('error' in resolved && resolved.error === 'unknown_title') {
    return {
      found: false, reason: 'unknown_title', title: parsed.title,
      message: `Title ${parsed.title} is not one of Oklahoma's 94 statute titles.`,
      hint: 'Call ok_titles for the full list of titles and their official names.',
    };
  }
  if ('error' in resolved && resolved.error === 'section_not_found') {
    return {
      found: false, reason: 'section_not_found', title: parsed.title, section: parsed.section,
      title_name: resolved.titleName,
      message: `No Section ${parsed.section} found in Title ${parsed.title} (${resolved.titleName}).`,
      near: resolved.near,
      hint: resolved.near.length
        ? 'Section numbers are not contiguous — repealed or renumbered sections are normal. "near" lists other section numbers sharing the same prefix found in this title.'
        : 'Call ok_search with a topic instead if you do not have an exact citation.',
      data_as_of: new Date().toISOString(),
    };
  }
  const { citeid, titleName } = resolved as { citeid: number; titleName: string };

  const doc = await fetchPrintOnly(citeid);
  if (!doc.text) {
    return {
      found: true,
      citation: `${parsed.title} O.S. § ${parsed.section}`,
      title: parsed.title,
      title_name: titleName,
      section: parsed.section,
      heading: doc.heading,
      text: null,
      reason: 'empty_text',
      message: 'OSCN returned the document page but no statutory text could be extracted — the section may be reserved or repealed.',
      citeid,
      url: `${BASE}/deliverdocument.asp?citeid=${citeid}`,
      source: `${UPSTREAM}, keyless`,
      data_as_of: new Date().toISOString(),
    };
  }

  return {
    found: true,
    citation: `${parsed.title} O.S. § ${parsed.section}`,
    title: parsed.title,
    title_name: titleName,
    section: parsed.section,
    heading: doc.heading,
    chapter_path: doc.chapterPath,
    cite_as: doc.citeAs,
    text: doc.text,
    text_chars: doc.text.length,
    history: doc.history,
    historical_versions: doc.historicalVersions.length
      ? doc.historicalVersions
      : 'none — this section has not been amended since enactment, or OSCN does not list a prior superseded version for it',
    historical_versions_hint: doc.historicalVersions.length
      ? 'Call ok_statute again with version_citeid set to one of these citeid values to retrieve that prior version\'s text.'
      : undefined,
    citeid,
    url: `${BASE}/deliverdocument.asp?citeid=${citeid}`,
    source: `${UPSTREAM} (Oklahoma Statutes Citationized), keyless`,
    attribution: 'Oklahoma statutes are public record.',
    data_as_of: new Date().toISOString(),
  };
}

async function okTitles() {
  const entries = Object.entries(TITLES).sort((a, b) => {
    const na = Number(a[0].replace(/[A-Z]+$/, ''));
    const nb = Number(b[0].replace(/[A-Z]+$/, ''));
    return na !== nb ? na - nb : a[0].localeCompare(b[0]);
  });
  return {
    titles: entries.map(([title, info]) => ({ title, name: info.name })),
    count: entries.length,
    hint: 'Pass "<title>-<section>" (e.g. "21-701.7") to ok_statute, or a topic to ok_search.',
    source: `${UPSTREAM}, master title index, keyless`,
    data_as_of: new Date().toISOString(),
  };
}

interface SearchHit { title: string; citation: string; effective: string | null; relevancy: number; citeid: number }

function parseSearchResults(html: string): { total: number; hits: SearchHit[] } {
  const totalMatch = /Documents Found:\s*(\d+)/i.exec(html);
  const total = totalMatch ? Number(totalMatch[1]) : 0;

  const hits: SearchHit[] = [];
  const blockRe = /<TR><TD WIDTH=5%>[\s\S]*?<\/TR>/gi;
  for (let m = blockRe.exec(html); m; m = blockRe.exec(html)) {
    const block = m[0];
    const titleMatch = /<font size = 2>([^<]+)<\/font>/i.exec(block);
    const citeMatch = /Statute Citation:\s*([^<]+)<BR>/i.exec(block);
    const effMatch = /Effective:\s*([^<]*)<BR>/i.exec(block);
    const relMatch = /Relevancy \(Number of Hits\):(\d+)/i.exec(block);
    const idMatch = /deliverdocument\.asp\?id=(\d+)/i.exec(block);
    if (!titleMatch || !citeMatch || !idMatch) continue;
    hits.push({
      title: stripMarkup(titleMatch[1]!).trim(),
      citation: stripMarkup(citeMatch[1]!).trim(),
      effective: effMatch && effMatch[1]!.trim() ? effMatch[1]!.trim() : null,
      relevancy: relMatch ? Number(relMatch[1]) : 0,
      citeid: Number(idMatch[1]),
    });
  }
  return { total, hits };
}

async function okSearch(args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim();
  if (!query) {
    return {
      found: false, reason: 'empty_query',
      message: 'ok_search needs a "query" — a topic or a few keywords, e.g. "landlord" or "concealed carry permit".',
      hint: 'To look up a known citation directly, use ok_statute instead.',
    };
  }
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));

  const url = new URL(`${BASE}/Search.asp`);
  url.searchParams.set('ftdb', 'STOKST');
  url.searchParams.set('quick', 'true');
  url.searchParams.set('query', query);
  url.searchParams.set('hidesuperseded', 'Yes');
  url.searchParams.set('dbCodeText', 'STOKST');
  url.searchParams.set('SUBMITTED', 'true');

  const res = await pwFetch(url);
  if (!res.ok) throw await httpError(res, UPSTREAM);
  const buf = await res.arrayBuffer();
  const html = new TextDecoder('iso-8859-1').decode(buf);
  const { total, hits } = parseSearchResults(html);

  if (!hits.length) {
    return {
      found: false, query,
      message: `No Oklahoma statute matched "${query}".`,
      hint: 'This is a real full-text search over statutory body text (not just captions) — try fewer or more literal terms.',
      source: `${UPSTREAM} full-text search, keyless`,
      data_as_of: new Date().toISOString(),
    };
  }

  return {
    found: true,
    query,
    total_matched: total,
    returned: Math.min(limit, hits.length),
    results: hits.slice(0, limit).map((h) => ({
      citation: h.citation,
      heading: h.title,
      effective: h.effective,
      relevancy: h.relevancy,
      citeid: h.citeid,
    })),
    hint: 'Call ok_statute with the citation from a result for the full text, amendment history, and any historical versions.',
    source: `${UPSTREAM} full-text search over the Oklahoma Statutes Citationized, keyless`,
    data_as_of: new Date().toISOString(),
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'ok_statute',
    description:
      'Get the FULL TEXT of a section of the Oklahoma Statutes by citation, e.g. "21-701.7" (Murder in the First Degree) or "41-111" (termination of tenancy). Accepts "21-701.7", "21 O.S. 701.7", or "21 O.S. § 701.7". Returns the current statutory text, its chapter breadcrumb, the "Cite as" line, its full amendment history (every amending Act), and a historical_versions list of every prior (superseded) version with a citeid you can pass back as version_citeid to retrieve that EXACT prior text. Keyless. Use for "what does 21 O.S. 701.7 say", "Oklahoma murder statute", or to check an Oklahoma statute a case or contract relies on, including how it read before a given amendment.',
    inputSchema: {
      type: 'object',
      properties: {
        citation: {
          type: 'string',
          description: 'Section citation as title-section, e.g. "21-701.7" or "41-111". The title is the part before the dash/space and may carry a letter suffix (e.g. "10A-1" or "85A-45").',
        },
        version_citeid: {
          type: 'number',
          description: 'Optional. A "citeid" value from a previous result\'s historical_versions array — fetches that superseded version\'s exact text instead of the current one. When set, "citation" is optional (used only to label the response).',
        },
      },
      required: ['citation'],
    },
  },
  {
    name: 'ok_search',
    description:
      'Search the Oklahoma Statutes by TOPIC or keyword rather than citation, e.g. "landlord", "concealed carry permit", "DUI per se limit". Real full-text search over statutory body text (not just captions) — a query like "landlord" surfaces sections whose heading never says "landlord" (e.g. "Termination of Tenancy", 41 O.S. § 111). Returns matching citations, headings, effective dates, and relevancy. Call ok_statute with a result\'s citation for the full text. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or keywords, e.g. "landlord security deposit".' },
        limit: { type: 'number', description: 'Max results to return, default 10, max 50.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ok_titles',
    description:
      'List all 94 titles of the Oklahoma Statutes with their official names, e.g. Title 21 is Crimes and Punishments, Title 41 is Landlord and Tenant. Routing help for when you know the subject but not the title number — call this or ok_search before guessing a citation. Keyless.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ok_statute': return okStatute(args);
    case 'ok_search': return okSearch(args);
    case 'ok_titles': return okTitles();
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
