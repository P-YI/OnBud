// Mac actions in plain English (2026-11-13). Requests to do something were answered with how-to text: rules matched
// one wording each, a router pick was dropped when the skill could not parse it, and the answer prompt can only
// describe. Now: politeness is stripped before the rules (plainRequest), more actions exist (volume up/down,
// brightness, lock, Wi-Fi/Bluetooth power, Trash, hidden files, quit, Finder folders), and an AFM pick from a closed
// action list catches the rest (controller, needs AFM: covered by the probes, not here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLocalSkill, finderFolder, launchTarget, plainRequest } from "../services/controller/local-skills.ts";
import { settingsPaneIntent } from "../services/controller/settings-pane.ts";
import { macControl } from "../services/controller/mac-tasks.ts";
import { isActionRequest, typedCommand } from "../services/controller/controller.ts";

process.env.ONBUD_DRY_ACTIONS = "1";

test("plainRequest strips politeness and padding", () => {
  assert.equal(plainRequest("Could you open Notes for me?"), "open Notes");
  assert.equal(plainRequest("Would you mind opening the Sound settings?"), "opening the Sound settings");
  assert.equal(plainRequest("Hey, please launch Xcode now."), "launch Xcode");
  assert.equal(plainRequest("I want to change my wallpaper"), "change my wallpaper");
});

test("apps: polite, compound and start/run wordings", () => {
  assert.equal(launchTarget("Could you open Notes for me?")?.name, "Notes");
  assert.equal(launchTarget("Open Calendar app and show today")?.name, "Calendar");
  assert.equal(launchTarget("Can you get Notes running?")?.name, "Notes");
  assert.equal(launchTarget("pop open Calculator")?.name, "Calculator");
  assert.equal(launchTarget("run npm test"), undefined);
  assert.equal(launchTarget("Please launch Xcode")?.explicit, true);   // not installed → say so, not a text answer
});

test("settings: singular words, other verbs, pane names alone, update checks", () => {
  const pane = (q: string) => settingsPaneIntent(q)?.pane?.en;
  assert.equal(pane("Open the setting app and show bluetooth setting"), "Bluetooth");
  assert.equal(pane("I want to change my wallpaper, open that setting"), "Wallpaper");
  assert.equal(pane("I need to see my network settings"), "Network");
  assert.equal(pane("Pull up the trackpad preferences"), "Trackpad");
  assert.equal(pane("I want the sound settings"), "Sound");
  assert.equal(pane("Where can I change my login items? open it"), "Login Items");
  assert.equal(pane("I'd like to check for macOS updates"), "Software Update");
  assert.equal(settingsPaneIntent("How do I change Bluetooth settings?"), undefined);
});

test("Finder folders", () => {
  const H = process.env.HOME ?? "";
  assert.equal(finderFolder("Open my Downloads folder"), `${H}/Downloads`);
  assert.equal(finderFolder("Let me see the Desktop folder"), `${H}/Desktop`);
  assert.equal(finderFolder("Show me the Applications folder"), "/Applications");
  assert.equal(finderFolder("Open a terminal in my Downloads folder"), undefined);
  assert.equal(finderFolder("summarize the Downloads folder"), undefined);
});

test("new Mac actions are detected and ask for approval with the right command", async () => {
  const run = async (q: string) => { assert.equal(detectLocalSkill(q, []), "mac_control", q); return macControl({ root: "", prompt: q, files: [], ko: false }); };
  assert.match((await run("Make it louder")).pendingCommand!, /\+ 15/);
  assert.match((await run("Turn down the brightness")).pendingCommand!, /key code 145/);   // not the volume
  assert.match((await run("Make my screen darker")).pendingCommand!, /key code 145/);
  assert.match((await run("Turn the volume all the way down")).pendingCommand!, /output volume 0/);
  assert.match((await run("Lock my screen")).pendingCommand!, /keystroke "q"/);
  assert.match((await run("Disconnect from wi-fi")).pendingCommand!, /setairportpower .* off$/);
  assert.match((await run("Wipe the trash")).answer, /cannot be undone/);
  assert.match((await run("Show hidden files")).pendingCommand!, /keystroke "\." using/);
  assert.match((await run("Silence my mac")).pendingCommand!, /muted/);
  assert.match((await run("Close Safari")).pendingCommand ?? "", /"Safari" to quit/);
  assert.match((await run("Kill Zzqxapp")).answer, /No installed app/);
  assert.equal(typedCommand("Make it louder"), undefined);   // detected before the `make` command, and not a sentence-command
});

test("action requests vs questions and developer work", () => {
  for (const q of ["Could you dim the screen a bit?", "Wipe the trash", "Can you capture my screen?", "Could you pull up Bluetooth for me?", "Toggle wifi off"]) assert.ok(isActionRequest(q), q);
  for (const q of ["How do I turn on Bluetooth?", "What is dark mode?", "Run the tests", "Show the git diff", "Summarize this file"]) assert.ok(!isActionRequest(q), q);
});
