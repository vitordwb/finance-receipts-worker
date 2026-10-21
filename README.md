# Finance Receipts Worker

## Purpose

A JavaScript Cloudflare Worker that turns receipt photos or manually entered text into one structured personal expense. Designed for requests from iOS Shortcuts, with extraction rules tailored to Japanese receipts.

For each accepted expense, the Worker:

1. Authenticates the request with a shared bearer token.
2. Stores an attached receipt image in Cloudflare R2.
3. Sends the text and/or image to the OpenAI Responses API for structured extraction.
4. Normalizes the result, including correcting cash-tendered/change amounts when applicable.
5. Posts the expense to a Google Apps Script endpoint intended to save it in Google Sheets.

The repository contains the Worker, Wrangler configuration, Vitest tests, and a complete [Google Apps Script](apps-script/Code.gs). It does not contain an exported iOS Shortcut.

## Setup

### Prerequisites

- Node.js **22.12 or later** and npm. The locked Wrangler requires Node.js 22+, and the locked Vite requires at least 22.12 on the Node.js 22 release line.
- A Cloudflare account with Workers and R2 access for deployment.
- An OpenAI API key with access to the configured model.
- A deployed Google Apps Script web app implementing the contract below.

From the repository root:

```sh
npm ci
```

Create a local `.dev.vars` file with the values listed under Configuration, then start Wrangler:

```sh
npm run dev
```

`npm run dev` listens on all network interfaces (`0.0.0.0`); `npm start` runs the same command. Use `http://localhost:8787` on this machine or `http://100.101.141.104:8787` from another authorized device on its Tailscale network. macOS firewall and Tailscale access rules must allow port 8787. The Tailscale address is machine-specific. This also exposes the server on the local network; for loopback-only development, run `npm run dev -- --ip 127.0.0.1`. Binding directly to this Mac's Tailscale address failed with `EADDRNOTAVAIL`, so the script uses the wildcard address instead.

Local Wrangler development uses local R2 storage by default; an expense request still makes real outbound requests to OpenAI and the configured Apps Script. Use a development spreadsheet and expect API usage charges. The health endpoint does not call these services.

### Tests

```sh
npm test -- --run
```

`npm test` starts Vitest without the one-shot flag. Tests use the Cloudflare Workers pool configured in `vitest.config.js` and substitute external HTTP requests, R2, and spreadsheet services. They cover expense handling, normalization, public receipt retrieval, and Apps Script column/note behavior; they do not establish that live integrations or AI extraction accuracy work.

## Configuration

`wrangler.jsonc` defines the Worker name (`finance-receipts-worker`), entrypoint (`src/index.js`), compatibility date (`2026-06-01`), `nodejs_compat`, observability, source map uploads, model, and R2 binding.

| Name | Required for | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | Every expense request | API key sent to the OpenAI Responses API. |
| `SHORTCUT_TOKEN` | Every expense request | Shared token expected in `Authorization: Bearer <token>`. |
| `GOOGLE_SCRIPT_URL` | Every expense request | URL of the deployed Apps Script web app. |
| `GOOGLE_SCRIPT_SECRET` | Every expense request | Shared secret included in the JSON sent to Apps Script. |
| `OPENAI_MODEL` | Optional | Model name; defaults to `gpt-4o` in both configuration and source. |
| `RECEIPTS_BUCKET` | Photo upload and public retrieval | R2 binding, configured to use bucket `finance-receipts`. |

Local development and production use the same `OPENAI_MODEL` value from `wrangler.jsonc` (`gpt-4o`). Do not define `OPENAI_MODEL` in `.env` or `.dev.vars`, since local values override that shared configuration. Structured extraction requires JSON Schema Structured Outputs support; the older `gpt-4o-2024-05-13` snapshot is incompatible. Restart development after changing local environment variables.

Example **local** `.dev.vars` contents; replace every placeholder with your own value:

```dotenv
OPENAI_API_KEY="<openai-api-key>"
SHORTCUT_TOKEN="<private-shortcut-token>"
GOOGLE_SCRIPT_URL="https://script.google.com/macros/s/<deployment-id>/exec"
GOOGLE_SCRIPT_SECRET="<private-script-secret>"
```

`.dev.vars*` and `.env*` are ignored by Git, except their `.example` variants. Never put real secrets in `wrangler.jsonc`, the README, or client-visible logs. Configure production secrets separately from local values.

### Google Apps Script contract

The Worker sends an HTTP POST with `Content-Type: application/json` and these fields:

| Field | Value |
| --- | --- |
| `secret` | `GOOGLE_SCRIPT_SECRET` |
| `date` | Expense date, `YYYY-MM-DD` |
| `merchant` | Normalized vendor name |
| `amount` | Positive numeric expense total |
| `category` | One of `CATEGORIES` in `src/index.js` |
| `payment_method` | AI-inferred `CREDIT_CARD`, `CASH`, or an empty string when unknown/unsupported |
| `notes` | English photo item/service summary (up to 1000 characters); blank for text-only requests |
| `image_url` | Public absolute receipt URL, or an empty string for text-only input |
| `image_key` | R2 object key, or an empty string for text-only input |
| `source` | `ios_shortcut_photo_base64` or `ios_shortcut_text` |
| `confidence` | Extracted numeric confidence |

The endpoint must return JSON with a truthy `ok` for success; the Worker uses `row` in its confirmation message. For example:

```json
{"ok": true, "row": 7}
```

For an application failure, return JSON such as `{"ok": false, "error": "reason"}`. The Worker checks the JSON `ok` field rather than the HTTP status of this endpoint. The supplied Apps Script implements the contract; its live deployment and spreadsheet behavior still require verification in your Google account.

### Spreadsheet layout and cutover

The supplied script targets the `Expenses` tab, starting at row 8, and retains the original spreadsheet ID. Review `CONFIG` before deploying to another spreadsheet.

| Column | Content |
| --- | --- |
| B | Date, stored as a Sheets serial and displayed as `MM-dd-yyyy` |
| C | Merchant |
| D | Amount, with the receipt URL in a cell note |
| E | Expense Category |
| F | Payment Method: `CREDIT_CARD`, `CASH`, or blank |
| G | Notes: English item/service summary for photos |

Before using the new script:

1. Insert a new column F between Expense Category and the existing Notes column; name it `Payment Method`. Existing Notes moves to G.
2. Configure F validation to accept `CREDIT_CARD`, `CASH`, and blank. Remove any old URL-only validation from G. The script copies the previous row's formatting and validation across B:G, so the template row must match this layout.
3. Copy `apps-script/Code.gs` into your Apps Script project. In **Project Settings → Script properties**, configure `APPEND_SECRET` with the same secret as the Worker's `GOOGLE_SCRIPT_SECRET`. No secret is embedded in the script. Rotate the previously shared secret in both places before production use.
4. Publish an updated Apps Script web-app version and deploy the matching Worker. Pause submissions during the cutover so the old and new contracts are not mixed.

The script changes **new entries only**. It does not move existing receipt references from G into D notes or backfill historical payment methods/summaries. Existing references remain in their shifted cells until you migrate them separately.

Amount notes contain an absolute HTTP(S) URL, not an R2 key or a threaded comment. Google Sheets controls how links in notes are displayed/opened; hyperlink interaction in the live Sheets UI has not been verified. Text-only entries clear any existing Amount note on the target row.

## Usage

### Health check

```sh
curl http://localhost:8787/health
```

Expected JSON:

```json
{"ok": true, "service": "finance-receipts-worker"}
```

`GET /health` requires no authentication or secrets. It confirms the Worker responds, not that OpenAI, R2, or Sheets is healthy.

### Submit an expense

Set `SHORTCUT_TOKEN` in your shell to the same value configured for the Worker. Wrangler's local variables are not automatically exported to your shell.

```sh
curl --fail-with-body http://localhost:8787/expense \
  -H "Authorization: Bearer ${SHORTCUT_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"text":"Coffee at Example Cafe, 450 yen","client_datetime":"2026-06-03T12:30:00+09:00"}'
```

This request can incur OpenAI charges and write a spreadsheet row. Replace the local origin with your deployed Worker URL when calling production.

`POST /expense` accepts JSON with these fields:

| Field | Meaning |
| --- | --- |
| `text` | Manual expense description. Supply this, `photo`, or both. |
| `photo` | Base64 image bytes, not a file path or multipart upload. A `data:image/...;base64,...` URL is also accepted. |
| `mime_type` | Image MIME type; defaults to `image/jpeg`. `mimeType` is an alias. |
| `client_datetime` | Client timestamp. Its leading `YYYY-MM-DD` supplies the client date; without one, the Worker uses the current UTC date. `clientDatetime` is an alias. |
| `mode` | Optional descriptive value, such as `photo`; it does not select or enforce a processing mode. |

For iOS Shortcuts, send a dictionary as a JSON request body with the bearer header. For a photo, Base64-encode the image and put that string in `photo`; set `mime_type` to match. JPEG, PNG, WebP, and GIF MIME types are recognized. The decoded image limit is **10 MiB** (`10 * 1024 * 1024` bytes); resize larger images before encoding. Base64 whitespace and URL-safe characters are normalized.

Successful responses contain `ok`, `message`, `expense`, `sheet`, `image_key`, `image_url`, and `image_size`. `expense` includes the date, merchant, amount, category, confidence, `payment_method`, `notes`, and extraction details (`amount_label`, `cash_tendered`, `change_returned`). Text-only requests return empty image key/URL, blank notes, and zero image size. There is no currency field or currency conversion.

Payment is inferred by the AI, not a client-supplied payment field. Missing or unclear evidence stays blank; it never defaults to cash. Explicit debit cards, electronic money, QR payments, and mixed payments also stay blank because they are outside the two supported methods. Several sample receipts say `DEBIT MASTERCARD` alongside a generic credit label; the explicit debit indication takes precedence.

Cash settlement labels `現計` and `現金合計` are explicit evidence for `CASH`, including exact-payment receipts showing zero change. Zero change by itself does not identify the payment method.

Photo summaries translate readable purchased items into English, grouping similar items without inventing unreadable products. Service receipts summarize the paid service (for example, a pension contribution). Unreadable items are reported as `Items unreadable`. English output is instructed through the AI prompt; it has not been evaluated through paid model calls against the sample images.

Extraction rules distinguish transaction/payment dates from promotional dates, deadlines, and contribution periods, and convert explicitly marked Reiwa dates to Gregorian dates. They recognize Japanese and English total/tender labels, avoid double-counting attached card slips, and distinguish Valor supermarkets from home centers. National pension slips use the identified service provider and `Pension` category; general retailers are categorized by readable purchased goods. These rules were reviewed visually against all 11 local sample receipts, not benchmarked through live model calls.

### Public receipt links

Photo keys use `receipts/<client-date>/<uuid>.<extension>`. The Worker returns `image_url` using the request's origin and serves `GET /receipts/<client-date>/<uuid>.<extension>` without authentication. Submit expenses through the stable public Worker URL to create links that remain reachable; local-development URLs are not publicly reachable.

The R2 bucket itself does not need public access. The Worker streams only receipt-path JPG/PNG/WebP/GIF objects, returns 404 for missing or unsupported keys, and sends no-store/noindex headers. Anyone with a URL can view the receipt, including sensitive information in the original image. Random UUIDs are not authentication. Existing objects matching this route are also accessible if their keys are known. No bucket-listing endpoint is provided.

### Errors and operational limitations

| HTTP status | Meaning |
| --- | --- |
| `400` | Malformed JSON, missing text/photo, or certain invalid Base64 inputs. |
| `401` | Bearer token does not match `SHORTCUT_TOKEN`, after required secrets have been checked. |
| `404` | Unsupported method/path (including `DELETE /expense`), missing receipt, or invalid receipt key. |
| `413` | Decoded image exceeds 10 MiB. |
| `415` | Request content type is not `application/json`. |
| `500` | Missing configuration, other decoding errors, extraction/validation failures, storage errors, or downstream failures. |

Errors return JSON with `ok: false` and an `error` message; some include diagnostic fields. Many messages are in Portuguese.

- Photos are stored **before** extraction and spreadsheet submission. A later failure can leave an R2 object without a spreadsheet row.
- There is no idempotency mechanism; resubmitting a request can create duplicate expenses. Inspect the spreadsheet before retrying an uncertain submission.
- Request logging includes the first 300 characters of the body and a photo prefix. Treat observability output as potentially sensitive receipt data.
- Expense deletion is not available through the exposed routes.

## Deployment

Deployment changes Cloudflare resources. The steps below are operator instructions; **dependency installation, Wrangler execution, and live cloud integrations were not run or verified while preparing this README**. Commands defined in `package.json` and the Worker configuration were checked against repository files.

1. Install dependencies with `npm ci` and authenticate Wrangler for your Cloudflare account using your normal Cloudflare workflow.
2. Ensure the target account has an R2 bucket named `finance-receipts`, or update `r2_buckets` in `wrangler.jsonc` to your intended bucket. Keep the binding name `RECEIPTS_BUCKET`.
3. Follow the spreadsheet cutover instructions above, deploy `apps-script/Code.gs`, and confirm it accepts the documented payload, validates the shared secret, and writes to the intended spreadsheet.
4. Set production secrets using Wrangler's secret commands (run each and enter the value when prompted):

   ```sh
   npx wrangler secret put OPENAI_API_KEY
   npx wrangler secret put SHORTCUT_TOKEN
   npx wrangler secret put GOOGLE_SCRIPT_URL
   npx wrangler secret put GOOGLE_SCRIPT_SECRET
   ```

5. Review `OPENAI_MODEL`, account selection, observability, and source map settings in `wrangler.jsonc`, then publish:

   ```sh
   npm run deploy
   ```

6. Use the Worker URL printed by Wrangler to request `/health`. Submit a controlled photo expense and confirm F contains the inferred payment (or blank), G contains an English summary, and the Amount cell note contains the public URL. Open that URL without authentication to check the image. Also verify text-only Notes and Amount notes are blank. Live AI accuracy and Sheets note-link interaction still require this end-to-end verification.
