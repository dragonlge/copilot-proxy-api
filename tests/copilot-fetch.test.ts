import { afterEach, describe, expect, mock, test } from "bun:test"

import { copilotFetch } from "~/lib/copilot-fetch"

afterEach(() => {
  mock.restore()
})

describe("copilotFetch", () => {
  test("retries transient upstream responses", async () => {
    const fetchMock = mock(() => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response("busy", { status: 503 })
      }
      return new Response("ok", { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await copilotFetch("https://example.com", {
      method: "POST",
      retryDelayMs: 0,
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("does not retry likely context-overflow large payload failures", async () => {
    const fetchMock = mock(() => new Response("timed out", { status: 500 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await copilotFetch("https://example.com", {
      method: "POST",
      body: "x".repeat(2_000_001),
      retryDelayMs: 0,
    })

    expect(response.status).toBe(500)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("retries transient network failures", async () => {
    const fetchMock = mock(() => {
      if (fetchMock.mock.calls.length === 1) {
        throw new Error("socket closed")
      }
      return new Response("ok", { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await copilotFetch("https://example.com", {
      method: "POST",
      retryDelayMs: 0,
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
