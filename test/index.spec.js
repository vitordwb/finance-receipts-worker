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
      put: vi.fn()
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

    const openAiCall = globalThis.fetch.mock.calls.find(([url]) => {
      return url === "https://api.openai.com/v1/responses";
    });
    const openAiPayload = JSON.parse(openAiCall[1].body);
    const prompt = openAiPayload.input[0].content.find(part => {
      return part.type === "input_text";
    }).text;

    expect(prompt).toContain("お釣り");
    expect(prompt).toContain("お預り");
    expect(prompt).toContain("合計 ¥1,149");
    expect(prompt).toContain("amount must be 1149");
    expect(prompt).toContain("The value 8851 is change");
    expect(prompt).toContain("合計 ¥2,533");
    expect(prompt).toContain("amount must be 2533");
    expect(prompt).toContain("The value 3033 is cash tendered");
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
});
