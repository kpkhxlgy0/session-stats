"use strict";

const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const root = resolve(__dirname, "..");
const cli = resolve(root, "../codex-plusplus/bin/codexplusplus.js");
const [command, ...args] = process.argv.slice(2);
if (command !== "validate-tweak" && command !== "dev") {
    throw new Error("Use validate-tweak or dev");
}
async function main() {
    if (command === "dev") {
        // 1.0.6 的 CLI 参数解析拒绝 --no-watch，直接复用安装器的一次性链接实现。
        const file = resolve(root, "../codex-plusplus/packages/installer/dist/commands/dev-tweak.js");
        const { devTweak } = await import(pathToFileURL(file).href);
        await devTweak(root, { watch: false });
        return;
    }
    const result = spawnSync(process.execPath, [cli, command, root, ...args], { stdio: "inherit", cwd: root });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
