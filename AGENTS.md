# Repository Guidelines

## Project Overview

Cloudflare Worker that turns manual expense text or receipt photos into structured expenses, stores receipt images in R2, and sends expense records to Google Apps Script for spreadsheet persistence. OpenAI performs extraction and categorization.

## Architecture & Data Flow

- `src/index.js` is a single ES module: the default `fetch(request, env, ctx)` handler routes requests; local functions implement parsing, extraction, normalization, and persistence. No application framework or service-container layer.
- `GET /health` is public. `POST /expense` requires `Authorization: Bearer <SHORTCUT_TOKEN>` and JSON input. Other routes/methods return 404; the existing DELETE branch is unreachable and is not a supported API.
- Expense flow: validate configuration/authentication → parse JSON → optionally decode/upload photo to R2 → call OpenAI Responses API with a strict JSON schema → normalize expense → POST to Google Apps Script → return JSON.
- Inputs include `text`, Base64 `photo` (raw or data URL), `mime_type`/`mimeType`, and `client_datetime`/`clientDatetime`. `mode` is parsed but does not select a separate processing path. Decoded images are limited to 10 MiB, not the entire incoming request body.
- Dependencies arrive through `env`; outbound HTTP uses global `fetch`. Operations are sequentially awaited, with no background processing or mutable cross-request state. R2 and the external spreadsheet hold persistent state.
- There is no transaction, rollback, retry, or idempotency mechanism: a downstream failure can leave an uploaded image, and resubmission can duplicate records.

## Key Directories

- `src/`: Worker implementation and extraction/domain helpers.
- `test/`: Worker-handler tests with mocked external services.
- `receipts_samples/`: ignored local receipt JPEGs, not automated test fixtures; do not assume they exist in another checkout or commit personal receipts.
- `.wrangler/`: ignored generated local runtime state; do not edit it as application source.

## Development Commands

Use the existing npm scripts and lockfile:

| Command | Purpose |
| --- | --- |
| `npm ci` | Install dependencies from `package-lock.json` |
| `npm run dev` or `npm start` | Run the local Worker through Wrangler |
| `npm test` | Run Vitest |
| `npm test -- --run` | Run tests once, without watch mode |
| `npm run deploy` | Deploy through Wrangler; only with explicit deployment authorization |

There are no dedicated build, lint, or formatting scripts. Wrangler handles Worker bundling; do not invent a separate build pipeline.

## Code Conventions & Common Patterns

- Use plain JavaScript ES modules, `async`/`await`, camelCase helper names, and uppercase constants such as `CATEGORIES` and `MAX_IMAGE_BYTES`. Keep changes within the existing local-helper architecture unless the task requires otherwise.
- `.prettierrc` specifies tabs, single quotes, semicolons, and a 140-column print width. `.editorconfig` specifies UTF-8, LF, final newlines, and trimmed trailing whitespace; `*.yml` uses spaces. Existing source indentation is mixed: avoid unrelated formatting churn.
- Reuse `json()` for responses and `requireEnv()` for required configuration. Request validation returns explicit JSON errors; uncaught failures are logged and converted to JSON 500 responses by the entry point.
- Keep extraction schema, prompt, `CATEGORIES`, and normalization consistent. Preserve positive finite amount validation, unknown-category fallback to `Other`, and cash-tendered-minus-change correction rather than treating tendered cash as the receipt total.
- Preserve `cleanText()` spreadsheet-formula protection for text beginning with `=`, `+`, `-`, or `@`. Date fallback uses the current UTC date; do not silently introduce local-time semantics.
- Request previews and upstream error details can reach logs or responses. Treat them as potentially sensitive; never include secrets or real receipt contents in diagnostics or committed fixtures.

## Important Files

- `src/index.js`: routing, `handleExpense`, `readRequestBody`, OpenAI integration, schema/normalization, Base64/image handling, and shared response/sanitization helpers.
- `wrangler.jsonc`: Worker entry point, compatibility settings, model variable, R2 binding, observability, and source-map uploads.
- `package.json` / `package-lock.json`: scripts, development dependencies, and reproducible npm dependency resolution.
- `vitest.config.js` / `test/index.spec.js`: Workers-pool configuration and existing test helpers/cases.
- `.prettierrc`, `.editorconfig`, `.gitignore`: formatting conventions and local/generated-file exclusions.

## Runtime/Tooling Preferences

- Target the Cloudflare Workers runtime, not a standalone Node server. Wrangler config uses compatibility date `2026-06-01` and `nodejs_compat`; this is not a Node version requirement.
- Prefer npm to match `package-lock.json` (lockfile v3). No Node engine, package-manager version, or Bun requirement is declared.
- Tooling is Wrangler 4, Vitest 3.2, and `@cloudflare/vitest-pool-workers`; use the lockfile rather than assuming dependency ranges are installed versions. Prettier configuration exists, but Prettier is not a declared dependency.
- Expense requests require `OPENAI_API_KEY`, `SHORTCUT_TOKEN`, `GOOGLE_SCRIPT_URL`, and `GOOGLE_SCRIPT_SECRET`. Photo uploads additionally use the `RECEIPTS_BUCKET` R2 binding, configured for bucket `finance-receipts`.
- `OPENAI_MODEL` defaults to `gpt-4o`. Keep credentials in Worker secrets or ignored local environment files; `.env*` and `.dev.vars*` are ignored except example files. Never commit secret values.

## Testing & QA

- Vitest runs in Cloudflare's Workers pool using `wrangler.jsonc`, not a generic Node test environment.
- Follow `testEnv(overrides)`, `fetchWorker()`, and `stubExternalRequests()` in `test/index.spec.js`: inject bindings, mock outbound `fetch`, await `waitOnExecutionContext(ctx)`, and restore globals with `vi.unstubAllGlobals()`.
- Existing cases cover health, rejection of form-encoded input, manual JSON input, newline-containing photo Base64, and cash/change correction. The photo fixture is synthetic bytes, not OCR verification.
- External HTTP and R2 writes are mocked; passing unit tests do not prove live OpenAI, Apps Script, or R2 integration. Authentication failures, malformed inputs, and upstream/storage failures are not currently covered.
- No coverage threshold is configured. Verify changed behavior with focused tests and an appropriate local smoke run; do not contact paid/external services or deploy without authorization.
