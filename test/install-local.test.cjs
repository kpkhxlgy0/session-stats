"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const source = path.resolve(__dirname, "..");
const id = "com.kpk.session-stats";
const windows = { skip: process.platform !== "win32" };

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-stats-install-"));
    const home = path.join(root, "Codex++ data");
    const tweaks = path.join(home, "tweaks");
    const link = path.join(tweaks, id);
    const configFile = path.join(home, "config.json");
    fs.mkdirSync(tweaks, { recursive: true });
    const config = { codexPlusPlus: { autoUpdate: false }, tweaks: {
        "other.tweak": { enabled: false }, [id]: { enabled: false, retained: "value" },
    }, retained: [1, "中文"] };
    fs.writeFileSync(configFile, JSON.stringify(config));
    fs.mkdirSync(path.join(tweaks, "other.tweak"));
    fs.writeFileSync(path.join(tweaks, "other.tweak", "sentinel"), "keep");
    t.after(() => {
        assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
        if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
        fs.rmSync(root, { recursive: true });
        assert.equal(fs.existsSync(root), false);
    });
    return {
        root, home, link, configFile, config,
        run(action, ...args) {
            return spawnSync("pwsh", ["-NoProfile", "-File",
                path.join(source, `${action}-CodexPlusPlus.ps1`), ...args], {
                env: { ...process.env, CODEX_PLUSPLUS_HOME: home }, encoding: "utf8", timeout: 20000,
            });
        },
        readConfig: () => JSON.parse(fs.readFileSync(configFile, "utf8")),
    };
}

function succeeds(result) {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ""}`);
}

test("Inject links and enables only this tweak, is idempotent, and Uninject preserves its source", windows, (t) => {
    const f = fixture(t);
    succeeds(f.run("Inject"));
    assert.equal(fs.lstatSync(f.link).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(f.link).toLowerCase(), source.toLowerCase());
    const expected = structuredClone(f.config);
    expected.tweaks[id].enabled = true;
    assert.deepEqual(f.readConfig(), expected);
    const written = fs.readFileSync(f.configFile, "utf8");
    succeeds(f.run("Inject"));
    assert.equal(fs.readFileSync(f.configFile, "utf8"), written);
    succeeds(f.run("Uninject"));
    assert.equal(fs.existsSync(f.link), false);
    assert.equal(fs.existsSync(path.join(source, "manifest.json")), true);
    assert.deepEqual(f.readConfig(), f.config);
    assert.equal(fs.readFileSync(path.join(f.home, "tweaks", "other.tweak", "sentinel"), "utf8"), "keep");
    succeeds(f.run("Uninject"));
});

test("CheckOnly leaves both missing and existing installations unchanged", windows, (t) => {
    const f = fixture(t);
    const before = fs.readFileSync(f.configFile, "utf8");
    succeeds(f.run("Inject", "-CheckOnly"));
    succeeds(f.run("Uninject", "-CheckOnly"));
    assert.equal(fs.existsSync(f.link), false);
    assert.equal(fs.readFileSync(f.configFile, "utf8"), before);
    succeeds(f.run("Inject"));
    const enabled = fs.readFileSync(f.configFile, "utf8");
    succeeds(f.run("Uninject", "-CheckOnly"));
    assert.equal(fs.lstatSync(f.link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(f.configFile, "utf8"), enabled);
});

test("Store copy is enabled and disabled without deleting or replacing its files", windows, (t) => {
    const f = fixture(t);
    fs.mkdirSync(f.link);
    fs.writeFileSync(path.join(f.link, "manifest.json"), JSON.stringify({ id }));
    fs.writeFileSync(path.join(f.link, "sentinel"), "store source");
    succeeds(f.run("Inject"));
    assert.equal(f.readConfig().tweaks[id].enabled, true);
    assert.equal(fs.lstatSync(f.link).isSymbolicLink(), false);
    succeeds(f.run("Uninject"));
    assert.equal(f.readConfig().tweaks[id].enabled, false);
    assert.equal(fs.readFileSync(path.join(f.link, "sentinel"), "utf8"), "store source");
});

test("foreign junctions and unrelated directories are blocked without mutation", windows, (t) => {
    const f = fixture(t);
    const foreign = path.join(f.root, "foreign source");
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, "sentinel"), "keep");
    fs.symlinkSync(foreign, f.link, "junction");
    const before = fs.readFileSync(f.configFile, "utf8");
    for (const action of ["Inject", "Uninject"]) assert.equal(f.run(action).status, 2);
    assert.equal(fs.realpathSync(f.link), fs.realpathSync(foreign));
    assert.equal(fs.readFileSync(path.join(foreign, "sentinel"), "utf8"), "keep");
    fs.unlinkSync(f.link);
    fs.mkdirSync(f.link);
    fs.writeFileSync(path.join(f.link, "manifest.json"), JSON.stringify({ id: "other.tweak" }));
    for (const action of ["Inject", "Uninject"]) assert.equal(f.run(action).status, 2);
    assert.equal(fs.readFileSync(f.configFile, "utf8"), before);
});

test("invalid config is rejected before installing or removing a junction", windows, (t) => {
    const f = fixture(t);
    fs.writeFileSync(f.configFile, "{broken");
    assert.equal(f.run("Inject").status, 1);
    assert.equal(fs.existsSync(f.link), false);
    fs.symlinkSync(source, f.link, "junction");
    assert.equal(f.run("Uninject").status, 1);
    assert.equal(fs.lstatSync(f.link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(f.configFile, "utf8"), "{broken");
});

test("Inject creates missing config without requiring or modifying the Codex++ runtime", windows, (t) => {
    const f = fixture(t);
    fs.unlinkSync(f.configFile);
    succeeds(f.run("Inject"));
    assert.deepEqual(f.readConfig(), { tweaks: { [id]: { enabled: true } } });
    assert.equal(fs.existsSync(path.join(f.home, "runtime")), false);
    succeeds(f.run("Uninject"));
});
