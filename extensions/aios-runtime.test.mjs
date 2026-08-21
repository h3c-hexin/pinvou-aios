import assert from "node:assert/strict";
import test from "node:test";

import registerAiosRuntime from "./aios-runtime.js";

test("main agent exposes one task facade instead of task RPC tools", () => {
  const tools = [];
  const commands = [];
  registerAiosRuntime({
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(name) {
      commands.push(name);
    },
  });

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["playwright_cli", "task", "artifact_modify_current"],
  );
  assert.deepEqual(commands, ["aios-task-event"]);

  const task = tools.find((tool) => tool.name === "task");
  assert.deepEqual(task.parameters.required, ["action"]);
  assert.deepEqual(task.parameters.properties.action.enum, ["create", "list", "get", "cancel"]);
  assert.equal(tools.some((tool) => tool.name.startsWith("task_")), false);
});

