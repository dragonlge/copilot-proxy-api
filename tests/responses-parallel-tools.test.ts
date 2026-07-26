import { expect, test } from "bun:test"

import type { ResponsesApiRequest } from "~/routes/responses/types"

import { translateResponsesToChat } from "~/routes/responses/translation"

test("coalesces parallel Responses function calls before tool outputs", () => {
  const request: ResponsesApiRequest = {
    model: "gpt-5-mini",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: '{"path":"one.java"}',
      },
      { type: "reasoning", summary: [] },
      {
        type: "function_call",
        call_id: "call_2",
        name: "read_file",
        arguments: '{"path":"two.java"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "one" },
      { type: "function_call_output", call_id: "call_2", output: "two" },
    ],
  }

  const chat = translateResponsesToChat(request)
  expect(chat.messages).toHaveLength(3)
  expect(chat.messages[0].role).toBe("assistant")
  expect(chat.messages[0].tool_calls).toHaveLength(2)
  expect(chat.messages[1]).toMatchObject({
    role: "tool",
    tool_call_id: "call_1",
    content: "one",
  })
  expect(chat.messages[2]).toMatchObject({
    role: "tool",
    tool_call_id: "call_2",
    content: "two",
  })
})
