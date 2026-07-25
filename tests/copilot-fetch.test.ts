import { afterEach, describe, expect, mock, test } from "bun:test"

import { copilotFetch } from "~/lib/copilot-fetch"
import { state } from "~/lib/state"

afterEach(() => {
  mock.restore()
  state.copilotToken = undefined
  state.githubToken = undefined
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

  test("refreshes a rejected Copilot token and retries once", async () => {
    state.copilotToken = "stale-token"
    state.githubToken = "github-token"

    const fetchMock = mock((url: string, init?: RequestInit) => {
      if (url.includes("/copilot_internal/v2/token")) {
        return Response.json({ token: "fresh-token" })
      }

      const authorization = new Headers(init?.headers).get("Authorization")
      if (authorization === "Bearer stale-token") {
        return new Response("forbidden", { status: 403 })
      }
      return new Response("ok", { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await copilotFetch(
      "https://api.githubcopilot.com/responses",
      {
        method: "POST",
        headers: { Authorization: "Bearer stale-token" },
        retryDelayMs: 0,
      },
    )

    expect(response.status).toBe(200)
    expect(state.copilotToken).toBe("fresh-token")
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test("does not retry likely context-overflow timeout throws", async () => {
    const fetchMock = mock(() => {
      throw new Error("The operation timed out.")
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    try {
      await copilotFetch("https://example.com", {
        method: "POST",
        body: "x".repeat(2_000_001),
        retryDelayMs: 0,
      })
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("The operation timed out.")
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
