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
        return json({ ok: true, service: 'finance-receipts-worker' });
      }

      if (request.method !== 'POST' || url.pathname !== '/expense') {
        return json({ ok: false, error: 'not_found' }, 404);
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

  const form = await request.formData();

  const mode = String(form.get('mode') || '').toLowerCase();
  const manualText = String(form.get('text') || '').trim();
  const clientDatetime = String(form.get('client_datetime') || '').trim();
  const clientDate = deriveClientDate(clientDatetime);

  let imageBase64 = null;
  let imageMime = null;
  let imageKey = '';
  let imageSize = 0;

  const photo = form.get('photo');

  if (photo && typeof photo.arrayBuffer === 'function') {
    imageMime = photo.type || 'image/jpeg';

    const imageBuffer = await photo.arrayBuffer();
    imageSize = imageBuffer.byteLength;

    if (imageSize > MAX_IMAGE_BYTES) {
      return json({
        ok: false,
        error: 'Imagem maior que 10 MB. Reduza no Shortcut antes de enviar.'
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

    imageBase64 = arrayBufferToBase64(imageBuffer);
  }

  if (!manualText && !imageBase64) {
    return json({
      ok: false,
      error: 'Envie uma foto do recibo ou um texto manual.'
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
    source: imageKey ? 'ios_shortcut_photo' : 'ios_shortcut_text',
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
- Extract the final total amount paid.
- Amount must be numeric only: no currency symbols and no commas.
- For Japanese receipts, prefer total labels such as 合計, お買上計, 現計, お支払金額, 領収金額.
- Ignore subtotal, tax-only values, points, cashback, change, and cash tendered.
- If the receipt has several values, choose the actual paid total.
- If the date is missing, use the client date: ${clientDate}.
- If the manual text says "ontem", "yesterday", "hoje", or "today", resolve it relative to the client date.
- Merchant is the store/vendor name. If unknown, use "Unknown".
- Category must be exactly one of the allowed enum values.
- Supermarket or grocery shopping should usually be "Groceries".
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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;

  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
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

