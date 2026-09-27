import { loadAgentConfig } from "./config";
import { GrantAuthority } from "./grants";
import { startSyncAgent } from "./index";

async function readLaunchKey(): Promise<string> {
  return new Promise<string>((resolveKey, reject) => {
    let buffered = "";
    const timer = setTimeout(() => {
      reject(new Error("no launch key on stdin"));
    }, 10_000);
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      resolveKey(buffered.slice(0, newline).trim());
    };
    process.stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const fromStdin = process.argv.includes("--launch-key-stdin");
  const launchKey = fromStdin ? await readLaunchKey() : process.env.NAUTILUS_AGENT_LAUNCH_KEY;
  if (!launchKey || launchKey.length < 32) {
    throw new Error(
      "start the agent from the Nautilus desktop app, or set NAUTILUS_AGENT_LAUNCH_KEY (32+ characters) for development",
    );
  }
  const config = loadAgentConfig();
  await startSyncAgent(new GrantAuthority(Buffer.from(launchKey, "utf8")), config);
  if (fromStdin) {
    process.stdin.on("end", () => process.exit(0));
    process.stdin.resume();
  }
  process.stdout.write(`${JSON.stringify({ event: "ready", port: config.port })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "sync agent failed to start"}\n`,
  );

  process.exit(1);
});
