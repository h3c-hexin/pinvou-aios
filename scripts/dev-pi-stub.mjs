import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function messageText(message) {
  return String(message || "").trim();
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let command;
  try {
    command = JSON.parse(line);
  } catch (error) {
    send({ type: "response", success: false, error: `invalid JSON: ${error.message}` });
    return;
  }

  if (command.type === "get_state") {
    send({
      type: "response",
      id: command.id,
      command: "get_state",
      success: true,
      data: { model: { id: "dev-stub" } },
    });
    return;
  }

  if (command.type === "get_messages") {
    send({
      type: "response",
      id: command.id,
      command: "get_messages",
      success: true,
      data: { messages: [] },
    });
    return;
  }

  if (command.type === "prompt") {
    const text = messageText(command.message);
    const reply = text
      ? `已收到：${text}`
      : "已收到。";
    send({ type: "agent_start" });
    send({ type: "message_start", message: { role: "assistant" } });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: reply },
    });
    send({ type: "message_end", message: { role: "assistant", content: reply } });
    send({ type: "agent_settled" });
    return;
  }

  if (command.type === "abort") {
    send({ type: "agent_settled" });
    return;
  }

  send({
    type: "response",
    id: command.id,
    command: command.type || "unknown",
    success: false,
    error: `unsupported command: ${command.type || "unknown"}`,
  });
});
