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

      if (request.method !== 'POST' || url.pathname !== '/expense') {
        return json({
					ok: false,
					error: 'not_found'
				}, 404);
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

  const sheetPayload = {
    secret: env.GOOGLE_SCRIPT_SECRET,
    date: expense.date,
    merchant: expense.merchant,
    amount: expense.amount,
    category: expense.category,
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
You extract exactly one personal expense for a Google Sheets budget table.

Client datetime from the user's iPhone:
${clientDatetime || clientDate}

Manual text, if present:
${manualText || '(none)'}

Rules:
- Return data matching the provided JSON schema.
- Extract the final total amount paid (合計).
- Avoid getting the amout related to お釣り.
- Amount must be numeric only: no currency symbols and no commas.
- For Japanese receipts, prefer total labels such as 合計, お買上計, 現計, お支払金額, 領収金額.
- Ignore subtotal, tax-only values, points, cashback, change, and cash tendered.
- If the receipt has several values, choose the actual paid total.
- If the date is missing, use the client date: ${clientDate}.
- If the manual text says "ontem", "yesterday", "hoje", or "today", resolve it relative to the client date.
- Merchant is the store/vendor name. If unknown, use "Unknown".
- Category must be exactly one of the allowed enum values.
- Supermarket or grocery shopping should usually be "Groceries".
- Valor ホームセンタ goes into "Home maintenance".
- Cafe/restaurant meals should usually be "Restaurant".
- Train, metro, bus, taxi, transit should usually be "Public transportation".
- If category is unclear, use "Other".
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
    model: env.OPENAI_MODEL || 'gpt-4.1-mini',
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

function expenseSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'date',
      'merchant',
      'amount',
      'category',
      'confidence'
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
        description: 'Final total amount paid. Numeric only.'
      },
      category: {
        type: 'string',
        enum: CATEGORIES
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
