import { afterEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { handleCompletion } from "~/routes/messages/handler"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

afterEach(() => {
  mock.restore()
  state.models = undefined
})

function createApp(): Hono {
  const app = new Hono()
  app.post("/v1/messages", (c) => handleCompletion(c))
  return app
}

function setModels(models: Array<{ endpoints?: Array<string>; id: string }>) {
  state.models = {
    object: "list",
    data: models.map(({ endpoints, id }) => ({
      id,
      object: "model",
      name: id,
      model_picker_enabled: true,
      preview: false,
      vendor: "openai",
      version: "1",
      supported_endpoints: endpoints,
      capabilities: {
        family: id,
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
    })),
  } satisfies ModelsResponse
}

describe("Messages Responses bridge", () => {
  test("routes Responses-only models away from chat completions", async () => {
    setModels([{ id: "gpt-5.5", endpoints: ["/responses"] }])
    const app = createApp()
    const fetchMock = mock((url: string, opts: RequestInit) => {
      expect(url).toBe("https://api.githubcopilot.com/responses")
      expect(JSON.parse(opts.body as string)).toMatchObject({
        model: "gpt-5.5",
        input: [{ role: "user", content: "hello" }],
        max_output_tokens: 100,
        stream: false,
      })

      return new Response(
        JSON.stringify({
          id: "resp_123",
          object: "response",
          created_at: 0,
          model: "gpt-5.5",
          output: [
            {
              id: "msg_123",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "bridged" }],
            },
          ],
          output_text: "bridged",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          status: "completed",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
      }),
      headers: { "content-type": "application/json" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      type: "message",
      model: "gpt-5.5",
      content: [{ type: "text", text: "bridged" }],
      stop_reason: "end_turn",
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("keeps chat-capable models on chat completions", async () => {
    setModels([{ id: "chat-model", endpoints: ["/chat/completions"] }])
    const app = createApp()
    const fetchMock = mock((url: string) => {
      expect(url).toBe("https://api.githubcopilot.com/chat/completions")
      return new Response(
        JSON.stringify({
          id: "chatcmpl_123",
          object: "chat.completion",
          created: 0,
          model: "chat-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "chat" },
              logprobs: null,
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "chat-model",
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
      }),
      headers: { "content-type": "application/json" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      content: [{ type: "text", text: "chat" }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
