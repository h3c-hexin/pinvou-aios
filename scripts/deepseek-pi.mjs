#!/usr/bin/env node

import { exec as execCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { runPlaywrightCli } from "../browser/runner.js";

const exec = promisify(execCallback);
const baseUrl = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
const model = process.env.PINVOU_PI_MODEL || "deepseek-v4-flash";
const apiKey = process.env.DEEPSEEK_API_KEY || "";
const tcpAddr = process.env.PINVOU_AIOS_TCP_ADDR || "127.0.0.1:57931";
const agentRole = process.env.PINVOU_AGENT_ROLE || "main";
const taskId = process.env.PINVOU_TASK_ID || "";

const argv = process.argv.slice(2);
const systemPrompt = readOption("--system-prompt") || "You are Pinvou, a concise AI assistant.";
const enabledTools = new Set((readOption("--tools") || "").split(",").map((value) => value.trim()).filter(Boolean));
const history = [];

let stdinBuffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let newline = stdinBuffer.indexOf("\n");
  while (newline >= 0) {
    const line = stdinBuffer.slice(0, newline).trim();
    stdinBuffer = stdinBuffer.slice(newline + 1);
    if (line) {
      void handleLine(line);
    }
    newline = stdinBuffer.indexOf("\n");
  }
});

process.stdin.on("end", () => {
  if (stdinBuffer.trim()) {
    void handleLine(stdinBuffer.trim());
  }
});

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (error) {
    emit({ type: "extension_error", error: `invalid JSON command: ${error.message}` });
    return;
  }

  const id = msg.id;
  const command = msg.command || msg.type;
  const payload = msg.payload || msg;

  try {
    if (command === "get_state") {
      emitResponse(id, command, true, {
        provider: "deepseek",
        model: { id: model },
        role: agentRole,
      });
      return;
    }

    if (command === "get_messages") {
      emitResponse(id, command, true, { messages: [] });
      return;
    }

    if (command === "abort") {
      emitResponse(id, command, true, {});
      emit({ type: "agent_settled" });
      return;
    }

    if (command === "prompt") {
      emitResponse(id, command, true, {});
      await handlePrompt(payload);
      return;
    }

    emitResponse(id, command, false, null, `unsupported command: ${command}`);
  } catch (error) {
    emitResponse(id, command, false, null, error.message);
    emit({ type: "extension_error", error: error.message });
    emit({ type: "agent_settled" });
  }
}

async function handlePrompt(payload) {
  const text = String(payload.message || payload.prompt || "").trim();
  if (!text) {
    emit({ type: "extension_error", error: "empty prompt" });
    emit({ type: "agent_settled" });
    return;
  }

  if (await handleTaskEventCommand(text)) {
    emit({ type: "agent_settled" });
    return;
  }

  if (!apiKey) {
    emit({ type: "extension_error", error: "DEEPSEEK_API_KEY is missing" });
    emit({ type: "agent_settled" });
    return;
  }

  emit({ type: "agent_start" });

  if (agentRole === "worker" && taskId) {
    await daemonRpc("task.progress", {
      taskId,
      message: "DeepSeek 正在处理任务",
      percent: 35,
    }).catch(() => {});
  }

  const messageId = `deepseek-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  emit({
    type: "message_start",
    id: messageId,
    message: {
      id: messageId,
      role: "assistant",
    },
  });

  try {
    history.push({ role: "user", content: text });
    const reply = await callDeepSeek();
    history.push({ role: "assistant", content: reply });

    emit({
      type: "message_update",
      id: messageId,
      assistantMessageEvent: {
        type: "text_start",
      },
    });
    emit({
      type: "message_update",
      id: messageId,
      assistantMessageEvent: {
        type: "text_delta",
        delta: reply,
      },
    });
    emit({
      type: "message_end",
      id: messageId,
      message: {
        id: messageId,
        role: "assistant",
        content: reply,
      },
    });

    if (agentRole === "worker" && taskId) {
      await daemonRpc("task.complete", {
        taskId,
        result: reply,
      }).catch(() => {});
    }
  } catch (error) {
    emit({ type: "extension_error", error: error.message });

    if (agentRole === "worker" && taskId) {
      await daemonRpc("task.complete", {
        taskId,
        result: `任务执行失败：${error.message}`,
        summary: "任务执行失败",
      }).catch(() => {});
    }
  } finally {
    emit({ type: "agent_settled" });
  }
}

async function handleTaskEventCommand(text) {
  const match = text.match(/^\/aios-task-event\s+(\S+)$/);
  if (!match) {
    return false;
  }

  try {
    const event = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    if (event.eventType === "task.completed" && event.eventId) {
      await daemonRpc("notification.ack", { eventId: event.eventId });
    }
  } catch (error) {
    emit({ type: "extension_error", error: `failed to acknowledge task event: ${error.message}` });
  }

  return true;
}

async function callDeepSeek() {
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.slice(-16),
  ];
  const tools = toolDefinitions();

  for (let turn = 0; turn < 8; turn += 1) {
    const data = await requestChatCompletion({
      model,
      messages,
      tools: tools.length ? tools : undefined,
      temperature: 0.6,
      stream: false,
    });

    const message = data?.choices?.[0]?.message;
    if (!message) {
      throw new Error("DeepSeek returned an empty response");
    }

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!toolCalls.length) {
      const content = message.content;
      if (!content) {
        throw new Error("DeepSeek returned an empty response");
      }
      return content;
    }

    messages.push({
      role: "assistant",
      content: message.content || "",
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      const name = toolCall?.function?.name;
      const rawArgs = toolCall?.function?.arguments || "{}";
      let args;
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = {};
      }

      let result;
      try {
        result = await executeTool(name, args);
      } catch (error) {
        result = { error: error.message };
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  throw new Error("DeepSeek tool loop exceeded the maximum number of turns");
}

async function requestChatCompletion(requestBody) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  const bodyText = await response.text();
  let data;
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    data = { raw: bodyText };
  }

  if (!response.ok) {
    const message = data?.error?.message || data?.message || bodyText || `HTTP ${response.status}`;
    throw new Error(`DeepSeek request failed: ${message}`);
  }

  return data;
}

async function executeTool(name, args) {
  if (!enabledTools.has(name)) {
    throw new Error(`tool is not enabled: ${name}`);
  }

  switch (name) {
    case "playwright_cli": {
      const result = await runPlaywrightCli(args.args || []);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
      };
    }
    case "task_create":
      return daemonRpc("task.create", args);
    case "artifact_modify_current":
      return daemonRpc("artifact.modify_current", args);
    case "task_list":
      return daemonRpc("task.list", {});
    case "task_status":
      return daemonRpc("task.status", args);
    case "task_cancel":
      return daemonRpc("task.cancel", args);
    case "task_progress":
      return daemonRpc("task.progress", { taskId, ...args });
    case "task_complete":
      return daemonRpc("task.complete", { taskId, ...args });
    case "read":
      return readWorkspaceFile(args.path);
    case "write":
      return writeWorkspaceFile(args.path, args.content || "");
    case "edit":
      return editWorkspaceFile(args.path, args.oldText || args.old_text || "", args.newText || args.new_text || "");
    case "bash":
      return runWorkspaceCommand(args.command || "");
    default:
      throw new Error(`unsupported tool: ${name}`);
  }
}

async function readWorkspaceFile(inputPath) {
  const file = resolveWorkspacePath(inputPath);
  return { path: file, content: await fs.readFile(file, "utf8") };
}

async function writeWorkspaceFile(inputPath, content) {
  const file = resolveWorkspacePath(inputPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
  return { path: file, bytes: Buffer.byteLength(content, "utf8") };
}

async function editWorkspaceFile(inputPath, oldText, newText) {
  if (!oldText) {
    throw new Error("oldText is required");
  }
  const file = resolveWorkspacePath(inputPath);
  const current = await fs.readFile(file, "utf8");
  if (!current.includes(oldText)) {
    throw new Error("oldText was not found");
  }
  const next = current.replace(oldText, newText);
  await fs.writeFile(file, next, "utf8");
  return { path: file, replacements: 1 };
}

async function runWorkspaceCommand(command) {
  if (!command.trim()) {
    throw new Error("command is required");
  }
  const { stdout, stderr } = await exec(command, {
    cwd: process.cwd(),
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  return { stdout, stderr };
}

function resolveWorkspacePath(inputPath) {
  if (!inputPath) {
    throw new Error("path is required");
  }
  const resolved = path.resolve(process.cwd(), inputPath);
  const root = `${path.resolve(process.cwd())}${path.sep}`;
  if (resolved !== process.cwd() && !resolved.startsWith(root)) {
    throw new Error("path must stay inside the agent workspace");
  }
  return resolved;
}

function toolDefinitions() {
  const all = {
    playwright_cli: tool("playwright_cli", "Operate the shared AIOS Chromium browser through playwright-cli arguments.", {
      args: { type: "array", items: { type: "string" }, minItems: 1 },
    }),
    task_create: tool("task_create", "Create a background worker task for long-running or parallel work.", {
      title: { type: "string" },
      objective: { type: "string" },
    }),
    artifact_modify_current: tool("artifact_modify_current", "Modify the currently opened task HTML artifact.", {
      instruction: { type: "string" },
    }),
    task_list: tool("task_list", "List background tasks.", {}, []),
    task_status: tool("task_status", "Get one background task status.", {
      taskId: { type: "string" },
    }),
    task_cancel: tool("task_cancel", "Cancel one background task.", {
      taskId: { type: "string" },
    }),
    task_progress: tool("task_progress", "Report worker progress.", {
      message: { type: "string" },
      percent: { type: "number" },
    }),
    task_complete: tool("task_complete", "Complete the current worker task.", {
      summary: { type: "string" },
      result: { type: "string" },
    }),
    read: tool("read", "Read a UTF-8 file in the current workspace.", {
      path: { type: "string" },
    }),
    write: tool("write", "Write a UTF-8 file in the current workspace.", {
      path: { type: "string" },
      content: { type: "string" },
    }),
    edit: tool("edit", "Replace exact text in a UTF-8 file in the current workspace.", {
      path: { type: "string" },
      oldText: { type: "string" },
      newText: { type: "string" },
    }),
    bash: tool("bash", "Run a shell command in the current workspace.", {
      command: { type: "string" },
    }),
  };

  return [...enabledTools].map((name) => all[name]).filter(Boolean);
}

function tool(name, description, properties, required = Object.keys(properties)) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

async function daemonRpc(method, params) {
  const net = await import("node:net");
  const [host, portText] = tcpAddr.split(":");
  const port = Number(portText);
  if (!host || !port) {
    throw new Error(`invalid PINVOU_AIOS_TCP_ADDR: ${tcpAddr}`);
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = "";
    const request = {
      jsonrpc: "2.0",
      id: Math.random().toString(16).slice(2),
      method,
      params,
    };

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = buffer.slice(0, newline);
      socket.end();
      try {
        const response = JSON.parse(line);
        if (response.ok === false) {
          reject(new Error(response.error || "daemon RPC failed"));
        } else if (response.error) {
          reject(new Error(response.error.message || response.error || "daemon RPC failed"));
        } else {
          resolve(response.result);
        }
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}

function readOption(name) {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) {
    return "";
  }
  return argv[index + 1];
}

function emitResponse(id, command, success, data, error) {
  emit({
    type: "response",
    id,
    command,
    success,
    data,
    error,
  });
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
