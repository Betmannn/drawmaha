import { spawn } from "node:child_process";

const commands = [
  ["server", ["node_modules/tsx/dist/cli.mjs", "server/index.ts"]],
  ["client", ["node_modules/vite/bin/vite.js", "--host", "0.0.0.0"]]
];

const children = commands.map(([name, args]) => {
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });
  child.stdout.on("data", (data) => process.stdout.write(`[${name}] ${data}`));
  child.stderr.on("data", (data) => process.stderr.write(`[${name}] ${data}`));
  child.on("exit", (code) => {
    if (code && code !== 0) {
      process.exitCode = code;
      children.forEach((other) => other.kill("SIGTERM"));
    }
  });
  return child;
});

process.on("SIGINT", () => {
  children.forEach((child) => child.kill("SIGTERM"));
  process.exit(0);
});
