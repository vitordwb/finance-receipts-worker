import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src";

function testEnv(overrides = {}) {
  return {
    OPENAI_API_KEY: "openai-test-key",
    SHORTCUT_TOKEN: "shortcut-test-token",
    GOOGLE_SCRIPT_URL: "https://script.example.test/exec",
    GOOGLE_SCRIPT_SECRET: "sheet-test-secret",
    RECEIPTS_BUCKET: {
      put: vi.fn(),
      get: vi.fn()
    },
    ...overrides
  };
}

async function fetchWorker(request, env = testEnv()) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);

  await waitOnExecutionContext(ctx);

  return response;
}

function stubExternalRequests(env, expense) {
  vi.stubGlobal("fetch", vi.fn(async url => {
    if (url === "https://api.openai.com/v1/responses") {
      return Response.json({
        output_text: JSON.stringify(expense)
      });
    }

    if (url === env.GOOGLE_SCRIPT_URL) {
      return Response.json({
        ok: true,
        row: 7
      });
    }

    return Response.json({ ok: false }, { status: 404 });
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("finance receipts worker", () => {
  it("responds to the health check", async () => {
    const response = await fetchWorker(new Request("http://example.com/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "finance-receipts-worker"
    });
  });

  it("rejects non-JSON expense payloads", async () => {
    const env = testEnv();
    const response = await fetchWorker(
      new Request("http://example.com/expense", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SHORTCUT_TOKEN}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: "text=coffee"
      }),
      env
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "Content-Type deve ser application/json."
    });
  });

  it("accepts manual expense payloads as JSON", async () => {
    const env = testEnv();

    stubExternalRequests(env, {
      date: "2026-06-03",
      merchant: "Test Store",
      amount: 12.34,
      category: "Groceries",
      confidence: 0.9
    });

    const response = await fetchWorker(
      new Request("http://example.com/expense", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SHORTCUT_TOKEN}`,
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
          text: "Test Store groceries 12.34",
          client_datetime: "2026-06-03T12:30:00+09:00"
        })
      }),
      env
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.expense).toMatchObject({
      date: "2026-06-03",
      merchant: "Test Store",
      amount: 12.34,
      category: "Groceries"
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("accepts Base64 photo values in JSON payloads", async () => {
    const env = testEnv();

    stubExternalRequests(env, {
      date: "2026-06-03",
      merchant: "Receipt Store",
      amount: 45.67,
      category: "Other",
      confidence: 0.8
    });

    const response = await fetchWorker(
      new Request("http://example.com/expense", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SHORTCUT_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          mode: "photo",
          photo: "aGVs\nbG8=",
          mime_type: "image/jpeg",
          client_datetime: "2026-06-03T12:30:00+09:00"
        })
      }),
      env
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.image_size).toBe(5);
    expect(env.RECEIPTS_BUCKET.put).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

  });

  it("corrects cash tendered when change returned is present", async () => {
    const env = testEnv();

    stubExternalRequests(env, {
      date: "2026-06-02",
      merchant: "SEIYU",
      amount: 3033,
      amount_label: "お預り",
      cash_tendered: 3033,
      change_returned: 500,
      category: "Groceries",
      confidence: 0.7
    });

    const response = await fetchWorker(
      new Request("http://example.com/expense", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SHORTCUT_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text: "SEIYU receipt: 合計 2533 お預り 3033 お釣り 500",
          client_datetime: "2026-06-02T19:32:00+09:00"
        })
      }),
      env
    );

    const body = await response.json();
    const sheetCall = globalThis.fetch.mock.calls.find(([url]) => {
      return url === env.GOOGLE_SCRIPT_URL;
    });
    const sheetPayload = JSON.parse(sheetCall[1].body);

    expect(response.status).toBe(200);
    expect(body.expense.amount).toBe(2533);
    expect(sheetPayload.amount).toBe(2533);
  });

  it("clears unsupported payment methods and photo notes for text-only expenses", async () => {
    const env = testEnv();
    stubExternalRequests(env, {
      date: "2026-06-03",
      merchant: "Cafe",
      amount: 450,
      category: "Restaurant",
      payment_method: "DEBIT_CARD",
      notes: "Invented photo summary",
      confidence: 0.8
    });
    const response = await fetchWorker(new Request("https://example.com/expense", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SHORTCUT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text: "Coffee 450 yen" })
    }), env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.expense.payment_method).toBe("");
    expect(body.expense.notes).toBe("");
    expect(body.image_url).toBe("");
    expect(env.RECEIPTS_BUCKET.put).not.toHaveBeenCalled();
  });

  it("sanitizes photo notes and serves the saved image through its public URL", async () => {
    const env = testEnv();
    const objects = new Map();
    env.RECEIPTS_BUCKET.put.mockImplementation(async (key, bytes) => {
      objects.set(key, bytes);
    });
    env.RECEIPTS_BUCKET.get.mockImplementation(async key => {
      const bytes = objects.get(key);
      return bytes ? { body: bytes } : null;
    });
    stubExternalRequests(env, {
      date: "2026-06-03",
      merchant: "Store",
      amount: 450,
      category: "Groceries",
      payment_method: "CASH",
      notes: "=Milk and bread",
      confidence: 0.8
    });
    const response = await fetchWorker(new Request("https://example.com/expense", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SHORTCUT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        photo: "aGVsbG8=",
        mime_type: "image/png",
        client_datetime: "2026-06-03T12:30:00+09:00"
      })
    }), env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.expense.notes).toBe("'=Milk and bread");
    expect(body.image_url).toBe(`https://example.com/${body.image_key}`);
    const image = await fetchWorker(new Request(body.image_url), env);
    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(image.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(image.headers.get("Cache-Control")).toBe("no-store");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new TextEncoder().encode("hello"));
  });

  it("returns 404 for missing receipts and rejects keys outside the receipt namespace", async () => {
    const env = testEnv();
    env.RECEIPTS_BUCKET.get.mockResolvedValue(null);
    const missing = await fetchWorker(new Request(
      "https://example.com/receipts/2026-06-03/00000000-0000-0000-0000-000000000000.jpg"
    ), env);
    expect(missing.status).toBe(404);
    env.RECEIPTS_BUCKET.get.mockClear();
    for (const path of [
      "/receipts/private.txt",
      "/receipts/2026-06-03/00000000-0000-0000-0000-000000000000.svg",
      "/receipts/%2e%2e%2fsecret.jpg"
    ]) {
      const response = await fetchWorker(new Request(`https://example.com${path}`), env);
      expect(response.status).toBe(404);
    }
    expect(env.RECEIPTS_BUCKET.get).not.toHaveBeenCalled();
  });
});
