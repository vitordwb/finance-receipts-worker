/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const CATEGORIES = [
  'Car maintenance',
  'Car payment',
  'Pension',
  'Clothing',
  'Education',
  'Debt',
  'Electronics',
  'Entertainment',
  'Gas',
  'Gifts',
  'Going out',
  'Groceries',
  'Gym',
  'Home maintenance',
  'Insurance',
  'Medical',
  'Mortgage',
  'Other',
  'Public transportation',
  'Rent',
  'Restaurant',
  'Telecom',
  'Travel',
  'Utilities',
  'Work'
];

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/health') {
        return json({
					ok: true,
					service: 'finance-receipts-worker'
				});
      }

      if (request.method === 'GET' && url.pathname.startsWith('/receipts/')) {
        return await serveReceipt(url, env);
      }

      if (request.method !== 'POST' || url.pathname !== '/expense') {
        return json({
					ok: false,
					error: 'not_found'
				}, 404);
      }

			if (request.method === 'DELETE') {
				return await deleteLastExpense();
			}

      return await handleExpense(request, env);

    } catch (err) {
      console.error(err);

      return json({
        ok: false,
        error: String(err && err.message ? err.message : err)
      }, 500);
    }
  }
};

async function serveReceipt(url, env) {
  const key = url.pathname.slice(1);
  if (!/^receipts\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/.test(key)) {
    return json({ ok: false, error: 'not_found' }, 404);
  }

  const object = await env.RECEIPTS_BUCKET.get(key);
  if (!object) {
    return json({ ok: false, error: 'not_found' }, 404);
  }

  const extension = key.slice(key.lastIndexOf('.') + 1);
  const headers = new Headers({
    'Content-Type': extension === 'jpg' ? 'image/jpeg' : `image/${extension}`,
    'Content-Disposition': 'inline',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow'
  });
  return new Response(object.body, { headers });
}

async function handleExpense(request, env) {
  requireEnv(env, [
    'OPENAI_API_KEY',
    'SHORTCUT_TOKEN',
    'GOOGLE_SCRIPT_URL',
    'GOOGLE_SCRIPT_SECRET'
  ]);

  const auth = request.headers.get('Authorization') || '';

  if (auth !== `Bearer ${env.SHORTCUT_TOKEN}`) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const parsed = await readRequestBody(request);

  if (parsed.error) {
    return json({
      ok: false,
      error: parsed.error,
      received: {
        content_type: parsed.contentType,
        parse_error: parsed.parseError,
        raw_body_preview: parsed.rawBodyPreview
      }
    }, parsed.status || 400);
  }

  const mode = parsed.mode;
  const manualText = parsed.text;
  const clientDatetime = parsed.clientDatetime;
  const clientDate = deriveClientDate(clientDatetime);

  let imageBase64 = '';
  let imageMime = normalizeMimeType(parsed.mimeType || 'image/jpeg');
  let imageKey = '';
  let imageSize = 0;

  if (parsed.photo) {
    const photoData = parsePhotoBase64(parsed.photo);

    imageBase64 = photoData.base64;

    if (photoData.mimeType) {
      imageMime = normalizeMimeType(photoData.mimeType);
    }

    let imageBuffer;

    try {
      imageBuffer = base64ToArrayBuffer(imageBase64);
    } catch (err) {
      return json({
        ok: false,
        error: 'Campo photo não contém Base64 válido.',
        detail: String(err && err.message ? err.message : err),
        received: {
          content_type: parsed.contentType,
          mode,
          photo_length: parsed.photo.length,
          photo_preview: parsed.photo.slice(0, 40)
        }
      }, 400);
    }

    imageSize = imageBuffer.byteLength;

    if (imageSize > MAX_IMAGE_BYTES) {
      return json({
        ok: false,
        error: 'Imagem maior que 10 MB. Reduza no Shortcut antes de enviar.',
        image_size: imageSize
      }, 413);
    }

    const ext = extensionForMime(imageMime);
    imageKey = `receipts/${clientDate}/${crypto.randomUUID()}.${ext}`;

    await env.RECEIPTS_BUCKET.put(imageKey, imageBuffer, {
      httpMetadata: {
        contentType: imageMime
      },
      customMetadata: {
        client_date: clientDate,
        source: 'ios_shortcut'
      }
    });
  }

  if (!manualText && !imageBase64) {
    return json({
      ok: false,
      error: 'Envie uma foto do recibo em Base64 no campo photo ou um texto manual no campo text.',
      received: {
        content_type: parsed.contentType,
        mode,
        text_length: manualText.length,
        has_photo_base64: Boolean(imageBase64),
        photo_length: parsed.photo.length,
        client_datetime: clientDatetime,
        raw_body_preview: parsed.rawBodyPreview
      }
    }, 400);
  }

  const expense = await extractExpense({
    env,
    manualText,
    imageBase64,
    imageMime,
    clientDatetime,
    clientDate
  });

  normalizeAndValidateExpense(expense, clientDate);
  expense.payment_method = ['CREDIT_CARD', 'CASH'].includes(expense.payment_method)
    ? expense.payment_method
    : '';
  expense.notes = imageBase64 && typeof expense.notes === 'string'
    ? cleanText(expense.notes, 1000)
    : '';
  const imageUrl = imageKey ? new URL(`/${imageKey}`, request.url).href : '';

  const sheetPayload = {
    secret: env.GOOGLE_SCRIPT_SECRET,
    date: expense.date,
    merchant: expense.merchant,
    amount: expense.amount,
    category: expense.category,
    payment_method: expense.payment_method,
    notes: expense.notes,
    image_url: imageUrl,
    image_key: imageKey,
    source: imageKey ? 'ios_shortcut_photo_base64' : 'ios_shortcut_text',
    confidence: expense.confidence
  };

  const sheetRes = await fetch(env.GOOGLE_SCRIPT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(sheetPayload)
  });

  const sheetText = await sheetRes.text();

  let sheetJson;

  try {
    sheetJson = JSON.parse(sheetText);
  } catch {
    throw new Error('Resposta inválida do Apps Script: ' + sheetText.slice(0, 300));
  }

  if (!sheetJson.ok) {
    throw new Error('Google Sheets: ' + (sheetJson.error || 'falha ao salvar'));
  }

  const message =
    `✅ ${expense.merchant} — ${formatAmount(expense.amount)} — ${expense.category} — linha ${sheetJson.row}`;

  return json({
    ok: true,
    message,
    expense,
    sheet: sheetJson,
    image_key: imageKey,
    image_url: imageUrl,
    image_size: imageSize
  });
}

async function readRequestBody(request) {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();

  if (!contentType.includes('application/json')) {
    logReceivedRequest(request, {
      contentType,
      parseError: 'unsupported_content_type'
    });

    return {
      contentType,
      error: 'Content-Type deve ser application/json.',
      status: 415,
      parseError: '',
      rawBodyPreview: ''
    };
  }

  const rawBody = await request.text();
  let body = {};

  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch (err) {
    logReceivedRequest(request, {
      contentType,
      rawBody,
      parseError: String(err && err.message ? err.message : err)
    });

    return {
      contentType,
      error: 'JSON inválido no corpo da requisição.',
      status: 400,
      parseError: String(err && err.message ? err.message : err),
      rawBodyPreview: rawBody.slice(0, 300)
    };
  }

  logReceivedRequest(request, {
    contentType,
    rawBody,
    body
  });

  return {
    contentType,
    mode: String(body.mode || '').toLowerCase().trim(),
    text: String(body.text || '').trim(),
    photo: String(body.photo || '').trim(),
    mimeType: String(body.mime_type || body.mimeType || 'image/jpeg').trim(),
    clientDatetime: String(body.client_datetime || body.clientDatetime || '').trim(),
    rawBodyPreview: rawBody.slice(0, 300)
  };
}

function logReceivedRequest(request, { contentType, rawBody = '', body = {}, parseError = '' }) {
  const url = new URL(request.url);
  const photo = String(body.photo || '');
  const text = String(body.text || '');

  console.log('[expense-request]', {
    method: request.method,
    path: url.pathname,
    contentType,
    contentLength: request.headers.get('content-length') || '',
    rawBodyLength: rawBody.length,
    rawBodyPreview: rawBody.slice(0, 300),
    parseError,
    parsed: {
      mode: String(body.mode || ''),
      hasText: Boolean(text),
      textLength: text.length,
      hasPhoto: Boolean(photo),
      photoLength: photo.length,
      photoPreview: photo.slice(0, 40),
      mimeType: String(body.mime_type || body.mimeType || ''),
      clientDatetime: String(body.client_datetime || body.clientDatetime || '')
    }
  });
}

async function extractExpense({
  env,
  manualText,
  imageBase64,
  imageMime,
  clientDatetime,
  clientDate
}) {
  const prompt = `
You extract exactly one personal expense from a receipt image, usually a Japanese POS receipt.

Client datetime from the user's iPhone:
${clientDatetime || clientDate}

Manual text, if present:
${manualText || '(none)'}

Rules:
- Analyse the photo as OCR. If the receipt is rotated or skewed, mentally rotate it before reading.
- Return data matching the provided JSON schema.
- Amount must be numeric only: no currency symbols and no commas.

Total amount extraction:
- Extract ONLY the final total amount charged to the customer.
- Highest priority labels for the expense amount: 合計, お買上計, 現計, お支払金額, 領収金額, 税込合計.
- Match each amount to the Japanese label on the same row. Do not use the amount from the row above or below the total label.
- NEVER use amounts next to お預り, お預かり, 預り, 預かり, 現金預り. These are cash tendered to the cashier, not the expense.
- NEVER use amounts next to お釣り, おつり, 釣銭, つり銭, 返金, change. These are change returned to the customer, not the expense.
- Ignore subtotal, tax-only values, points, cashback, discounts, item counts, barcode numbers, receipt numbers, store numbers, telephone numbers, cash tendered, and change.
- If the receipt shows cash tendered and change, validate the total with: cash tendered minus change equals total charged. Return the total charged, not the cash tendered.
- Example: 合計 ¥1,149, お預り ¥10,000, お釣り ¥8,851 means amount must be 1149. The value 8851 is change and must never be returned.
- Example: 合計 ¥2,533, お預り ¥3,033, お釣り ¥500 means amount must be 2533. The value 3033 is cash tendered and must never be returned.
- If several large numbers appear, choose the one attached to the total label, not the most visually prominent amount.
- Also return amount_label with the label used for amount, cash_tendered from お預り/お預かり if present, and change_returned from お釣り if present.
- If the date is missing, use the client date: ${clientDate}.
- If the manual text says "ontem", "yesterday", "hoje", or "today", resolve it relative to the client date.
- Merchant is the store/vendor name. If unknown, use "Unknown".
- Category must be exactly one of the allowed enum values.
- Supermarket or grocery shopping should usually be "Groceries".
- Valor ホームセンタ goes into "Home maintenance".
- Cafe/restaurant meals should usually be "Restaurant".
- Train, metro, bus, taxi, transit should usually be "Public transportation".
- If category is unclear, use "Other".

Payment method:
- Infer payment_method only from explicit payment evidence in the receipt or manual text.
- Use CREDIT_CARD for explicitly identified credit-card payment (クレジット, credit card).
- Use CASH for explicitly identified cash payment (現金, cash), or a cash-tendered/change transaction.
- A card logo, card number, or a zero change line alone does not establish a credit-card payment.
- If explicitly marked DEBIT (including DEBIT MASTERCARD), electronic money, QR payment, mixed payment, missing, or unclear, return an empty string. Never guess CASH or CREDIT_CARD.

Receipt item summary:
- A receipt photo is ${imageBase64 ? 'present' : 'absent'}.
- For a photo, summarize the purchased items or paid service concisely in English in notes, at most 1000 characters.
- Translate Japanese item names into English, group similar items, and include quantities only when legible.
- Include only readable purchase information, not card numbers, personal details, totals, tax, change, advertising, or invented products.
- A pension or other service-payment receipt should name the service rather than inventing shopping items.
- If items are unreadable, use "Items unreadable". For text-only expenses always return an empty notes string.
`;

  const content = [
    {
      type: 'input_text',
      text: prompt
    }
  ];

  if (imageBase64) {
    content.push({
      type: 'input_image',
      image_url: `data:${imageMime};base64,${imageBase64}`,
      detail: 'high'
    });
  }

  const payload = {
    model: env.OPENAI_MODEL || 'gpt-4o',
    input: [
      {
        role: 'user',
        content
      }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'expense_extraction',
        strict: true,
        schema: expenseSchema()
      }
    }
  };

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const responseText = await res.text();

  if (!res.ok) {
    throw new Error('OpenAI API error: ' + responseText.slice(0, 500));
  }

  let responseJson;

  try {
    responseJson = JSON.parse(responseText);
  } catch {
    throw new Error('OpenAI returned non-JSON response');
  }

  const outputText = extractOutputText(responseJson);

  if (!outputText) {
    throw new Error('OpenAI response missing output text');
  }

  try {
    return JSON.parse(outputText);
  } catch {
    throw new Error('OpenAI returned invalid JSON: ' + outputText.slice(0, 500));
  }
}

async function deleteLastExpense(env) {
  requireEnv(env, [
    'SHORTCUT_TOKEN',
    'GOOGLE_SCRIPT_URL',
    'GOOGLE_SCRIPT_SECRET'
  ]);

	console.log('Not implemented yet');
}


function expenseSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'date',
      'merchant',
      'amount',
      'amount_label',
      'cash_tendered',
      'change_returned',
      'category',
      'confidence',
      'payment_method',
      'notes'
    ],
    properties: {
      date: {
        type: 'string',
        description: 'Expense date in YYYY-MM-DD format.'
      },
      merchant: {
        type: 'string',
        description: 'Store, vendor, or merchant name. Use Unknown if not identifiable.'
      },
      amount: {
        type: ['number', 'null'],
        description: 'Total purchase cost charged by the merchant (合計). Numeric only. Use the sale total after discounts/coupons and tax. Do not use cash tendered, amount received, change, points, cashback, or payment/tender amounts.'
      },
      amount_label: {
        type: 'string',
        description: 'Receipt label used for amount, for example 合計.'
      },
      cash_tendered: {
        type: ['number', 'null'],
        description: 'Cash tendered/received amount from labels like お預り, if present. Never use as expense amount.'
      },
      change_returned: {
        type: ['number', 'null'],
        description: 'Change returned amount from labels like お釣り, if present. Never use as expense amount.'
      },
      category: {
        type: 'string',
        enum: CATEGORIES
      },
      payment_method: {
        type: 'string',
        enum: ['CREDIT_CARD', 'CASH', ''],
        description: 'Evidence-based payment method; empty if unknown or a different payment type.'
      },
      notes: {
        type: 'string',
        description: 'Concise English summary of purchased items or service from the photo; empty for text-only input.'
      },
      confidence: {
        type: 'number',
        description: 'Estimated confidence from 0 to 1.'
      }
    }
  };
}

function normalizeAndValidateExpense(expense, clientDate) {
  if (!expense.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(expense.date))) {
    expense.date = clientDate;
  }

  if (expense.amount === null || expense.amount === undefined || expense.amount === '') {
    throw new Error('Não consegui identificar o valor total.');
  }

  expense.amount = Number(expense.amount);
  expense.amount_label = cleanText(expense.amount_label || '', 40);
  expense.cash_tendered = optionalNumber(expense.cash_tendered);
  expense.change_returned = optionalNumber(expense.change_returned);

  const correctedAmount = amountFromCashAndChange(expense);

  if (correctedAmount !== null) {
    expense.amount = correctedAmount;
  }

  if (!Number.isFinite(expense.amount) || expense.amount <= 0) {
    throw new Error('Valor total inválido.');
  }

  expense.merchant = cleanText(expense.merchant || 'Unknown', 80);

  if (!expense.merchant) {
    expense.merchant = 'Unknown';
  }

  if (!CATEGORIES.includes(expense.category)) {
    expense.category = 'Other';
  }

  expense.confidence = Number(expense.confidence || 0);
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function amountFromCashAndChange(expense) {
  const cashTendered = expense.cash_tendered;
  const changeReturned = expense.change_returned;

  if (cashTendered === null || changeReturned === null || cashTendered <= changeReturned) {
    return null;
  }

  const total = Math.round((cashTendered - changeReturned) * 100) / 100;

  if (total <= 0) {
    return null;
  }

  const label = String(expense.amount_label || '').toLowerCase();

  if (
    approximatelyEqual(expense.amount, cashTendered) ||
    approximatelyEqual(expense.amount, changeReturned) ||
    /お預|預|釣|change|cash/.test(label)
  ) {
    return total;
  }

  return null;
}

function approximatelyEqual(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.01;
}

function extractOutputText(responseJson) {
  if (typeof responseJson.output_text === 'string') {
    return responseJson.output_text;
  }

  const parts = [];

  for (const item of responseJson.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }

  return parts.join('\n').trim();
}

function parsePhotoBase64(value) {
  let text = String(value || '').trim();

  if (!text) {
    return {
      base64: '',
      mimeType: ''
    };
  }

  const dataUrlMatch = text.match(/^data:([^;]+);base64,(.*)$/s);

  if (dataUrlMatch) {
    return {
      mimeType: dataUrlMatch[1],
      base64: normalizeBase64(dataUrlMatch[2])
    };
  }

  return {
    mimeType: '',
    base64: normalizeBase64(text)
  };
}

function normalizeBase64(value) {
  let text = String(value || '').trim();

  text = text.replace(/\s/g, '');

  // Suporta Base64 URL-safe também.
  text = text.replace(/-/g, '+').replace(/_/g, '/');

  const remainder = text.length % 4;

  if (remainder === 2) {
    text += '==';
  } else if (remainder === 3) {
    text += '=';
  } else if (remainder === 1) {
    throw new Error('Comprimento de Base64 inválido.');
  }

  return text;
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

function normalizeMimeType(mime) {
  const normalized = String(mime || '').toLowerCase();

  if (normalized.includes('png')) return 'image/png';
  if (normalized.includes('webp')) return 'image/webp';
  if (normalized.includes('gif')) return 'image/gif';

  return 'image/jpeg';
}

function deriveClientDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  return new Date().toISOString().slice(0, 10);
}

function extensionForMime(mime) {
  const normalized = String(mime || '').toLowerCase();

  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';

  return 'jpg';
}

function cleanText(value, maxLength) {
  let text = String(value || '').trim();

  if (/^[=+\-@]/.test(text)) {
    text = "'" + text;
  }

  return text.slice(0, maxLength);
}

function formatAmount(amount) {
  return Number(amount).toLocaleString('en-US', {
    maximumFractionDigits: 2
  });
}

function requireEnv(env, names) {
  const missing = names.filter(name => !env[name]);

  if (missing.length) {
    throw new Error('Missing env vars/secrets: ' + missing.join(', '));
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}
