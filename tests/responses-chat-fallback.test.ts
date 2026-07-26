import { describe, expect, test } from "bun:test"

import type { ResponsesApiResponse } from "~/routes/responses/types"

import { HTTPError } from "~/lib/error"
import {
  isUnsupportedChatModelError,
  isUnsupportedResponsesError,
  responsesSSE,
} from "~/routes/responses/chat-fallback"

describe("Responses Chat fallback", () => {
  test("only accepts explicit model or Responses protocol rejection", async () => {
    const unsupported = new HTTPError(
      "unsupported",
      new Response(
        JSON.stringify({
          error: {
            code: "model_not_supported",
            message: "gpt-5-mini is not supported via Responses API",
          },
        }),
        { status: 400 },
      ),
    )
    const malformed = new HTTPError(
      "malformed",
      new Response(JSON.stringify({ error: { message: "input required" } }), {
        status: 400,
      }),
    )

    expect(await isUnsupportedResponsesError(unsupported)).toBe(true)
    expect(await isUnsupportedResponsesError(malformed)).toBe(false)
  })

  test("emits the Responses event sequence required by Codex", () => {
    const response: ResponsesApiResponse = {
      id: "resp_123",
      object: "response",
      created_at: 1,
      model: "gpt-4.1-2025-04-14",
      output: [
        {
          id: "fc_123",
          type: "function_call",
          status: "completed",
          name: "get_weather",
          arguments: '{"city":"Shanghai"}',
          call_id: "call_123",
        },
      ],
      output_text: "",
      status: "completed",
    }

    const stream = responsesSSE(response)
    expect(stream).toContain("event: response.created")
    expect(stream).toContain("event: response.output_item.done")
    expect(stream).toContain("event: response.completed")
    expect(stream.indexOf("response.created")).toBeLessThan(
      stream.indexOf("response.completed"),
    )
  })

  test("only changes model when Chat explicitly rejects it", async () => {
    const unsupported = new HTTPError(
      "unsupported",
      new Response(
        JSON.stringify({
          error: {
            code: "unsupported_model",
            message: "model is not supported",
          },
        }),
        { status: 400 },
      ),
    )
    const timeout = new HTTPError(
      "timeout",
      new Response(
        JSON.stringify({
          error: { code: "user_request_timeout", message: "timed out" },
        }),
        { status: 408 },
      ),
    )
    expect(await isUnsupportedChatModelError(unsupported)).toBe(true)
    expect(await isUnsupportedChatModelError(timeout)).toBe(false)
  })
})
