import { afterEach, expect, mock, test } from "bun:test"

import type { ResponsesApiRequest } from "~/routes/responses/types"

import { state } from "~/lib/state"
import { createResponses } from "~/services/copilot/create-responses"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"
state.models = {
  object: "list",
  data: [
    {
      id: "gpt-5.5",
      object: "model",
      name: "GPT 5.5",
      model_picker_enabled: true,
      preview: false,
      vendor: "openai",
      version: "1",
      capabilities: {
        family: "gpt-5.5",
        limits: {
          max_context_window_tokens: 400_000,
          max_output_tokens: 16_000,
          max_prompt_tokens: 272_000,
        },
        object: "model_capabilities",
        supports: {},
        tokenizer: "o200k_base",
        type: "chat",
      },
    },
  ],
}

afterEach(() => {
  mock.restore()
})

function bodyToString(body: unknown): string {
  if (typeof body !== "string") {
    throw new TypeError("expected fetch body to be a string")
  }
  return body
}

test("strips old Responses images when payload exceeds upstream byte limit", async () => {
  const imageUrl = `data:image/png;base64,${"a".repeat(1_000_000)}`
  const payload: ResponsesApiRequest = {
    model: "unknown-vision-model",
    input: Array.from({ length: 6 }, (_, index) => ({
      role: "user",
      content: [
        { type: "input_text", text: `Image ${index}` },
        { type: "input_image", image_url: imageUrl },
      ],
    })),
  }

  const fetchMock = mock((_url: string, opts: RequestInit) => {
    const body = bodyToString(opts.body)
    return new Response(JSON.stringify({ id: "resp_123" }), {
      status: body.length > 5_000_000 ? 413 : 200,
      headers: { "content-type": "application/json" },
    })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createResponses(payload)
  const sentBody = bodyToString(fetchMock.mock.calls[0][1].body)
  const forwarded = JSON.parse(sentBody) as ResponsesApiRequest

  expect(response.status).toBe(200)
  expect(sentBody.length).toBeLessThanOrEqual(5_000_000)
  expect(JSON.stringify(forwarded.input)).toContain(
    "image removed to stay under upstream payload limit",
  )
  expect(JSON.stringify(forwarded.input)).toContain("data:image/png;base64")
})

test("drops old Responses input history when payload exceeds model token budget", async () => {
  const payload: ResponsesApiRequest = {
    model: "gpt-5.5",
    instructions: "Keep the latest task context.",
    input: Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Turn ${index}\n${"x".repeat(180_000)}`,
    })),
  }

  const fetchMock = mock((_url: string, opts: RequestInit) => {
    const body = bodyToString(opts.body)
    return new Response(JSON.stringify({ id: "resp_456" }), {
      status: body.length > 924_000 ? 400 : 200,
      headers: { "content-type": "application/json" },
    })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createResponses(payload)
  const sentBody = bodyToString(fetchMock.mock.calls[0][1].body)
  const forwarded = JSON.parse(sentBody) as ResponsesApiRequest

  expect(response.status).toBe(200)
  expect(sentBody.length).toBeLessThanOrEqual(924_000)
  expect(JSON.stringify(forwarded.input)).toContain(
    "older response input omitted to stay under context limit",
  )
  expect(JSON.stringify(forwarded.input)).toContain("Turn 7")
})

test("maps remaining upstream Responses 413 to prompt-too-long error", async () => {
  const payload: ResponsesApiRequest = {
    model: "gpt-5.5",
    input: "x".repeat(5_100_000),
    max_output_tokens: 1000,
  }

  const fetchMock = mock(
    () =>
      new Response(
        JSON.stringify({ error: { message: "failed to parse request" } }),
        { status: 413, headers: { "content-type": "application/json" } },
      ),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  let caught: unknown
  try {
    await createResponses(payload)
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).message).toBe("Prompt too long")
})
