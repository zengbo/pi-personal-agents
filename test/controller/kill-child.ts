/**
 * Child process for the controller kill -9 test.
 * `crash` admits an ops exec and hangs inside it.
 * `recover` reopens the same data directory and resumes.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { startTestRig } from "./fixture.ts";
import { openTestSocket, waitForText } from "./http.ts";

const mode = process.argv[2];
const root = requiredEnv("PPA_ROOT");
const execLog = requiredEnv("PPA_EXEC_LOG");
const markerPath = requiredEnv("PPA_MARKER");
const submissionPath = requiredEnv("PPA_SUBMISSION");

try {
  const rig = await startWhenUnlocked();
  if (mode === "crash") {
    const submitted = await rig.controller.submit("ops", "root", "run the tests", "kill-1");
    writeFileSync(submissionPath, `${submitted.submissionId}\n`);
    await new Promise(() => {});
  } else if (mode === "recover") {
    const submitted = await rig.controller.submit("ops", "root", "run the tests", "kill-1");
    const socket = await openTestSocket(rig.controller.port, rig.token);
    socket.send(JSON.stringify({ type: "watch", bot: "ops", conversationId: "root" }));
    const text = await waitForText(socket, "recovered", 20_000);
    socket.close();
    const runs = readFileSync(execLog, "utf8")
      .split("\n")
      .filter((line) => line.length > 0).length;
    process.stdout.write(`${JSON.stringify({ submissionId: submitted.submissionId, runs, text })}\n`);
    await rig.close();
  } else {
    throw new Error(`unknown mode ${mode ?? ""}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
}

async function startWhenUnlocked() {
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await startTestRig({
        root,
        prepare: (faux) => {
          const ops = faux.get("ops");
          if (ops === undefined) {
            throw new Error("ops");
          }
          if (mode === "crash") {
            ops.setResponses([fauxAssistantMessage(fauxToolCall("exec", { command: "true" }), { stopReason: "toolUse" })]);
            return;
          }
          ops.setResponses([fauxAssistantMessage("recovered")]);
        },
        exec: async () => {
          appendFileSync(execLog, "exec\n");
          if (process.env.PPA_CRASH === "1") {
            writeFileSync(markerPath, "exec\n");
            await new Promise(() => {});
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
    } catch (error) {
      last = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/lock|busy|SQLITE_BUSY/.test(message)) {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  }
  throw last;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing ${name}`);
  }
  return value;
}
