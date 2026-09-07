#!/usr/bin/env node
/**
 * E2E controlado do login Proton/CAPTCHA.
 *
 * O Electron, renderer, preload, IPC e BrowserWindow são os artefatos reais.
 * A única fronteira simulada é o endpoint oficial do CAPTCHA e o processo
 * proton-confgen, que é um executável Go separado e fica no caminho legítimo
 * usado por electron/proton.ts.
 *
 * Uso: xvfb-run -a node scripts/captcha-login-e2e.mjs [--case success]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const gui = path.resolve(here, "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const selected = arg("--case", "suite");
const allowedCases = new Set(["suite","success","double-click","retry","close","destroy","early-response","invalid-immediate-valid","invalid","loadfailure","missing-helper","missing-preload","corrupt-preload","timeout"]);
if (!allowedCases.has(selected)) { console.error(`caso desconhecido: ${selected}`); process.exit(2); }
const sourceDir = path.resolve(arg("--source-dir", gui));
const requestedAppDir = arg("--app-dir", "");
const outputRoot = path.resolve(arg("--output-root", path.join(os.tmpdir(), "golive-captcha-e2e-results")));
const repeat = Math.max(1, Number(arg("--repeat", "5")) || 5);
const timeoutMs = 120_000;

const helperSource = fs.readFileSync(path.join(here, "fixtures", "proton-captcha-helper", "main.go"), "utf8");

function fail(message) { throw new Error(message); }
function copyTree(from, to) { fs.cpSync(from, to, { recursive: true, force: true }); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); }

function makeFixture(root, caseName, options = {}) {
  const appDir = path.join(root, "golive-gui");
  fs.mkdirSync(appDir, { recursive: true });
  copyTree(path.join(sourceDir, "dist"), path.join(appDir, "dist"));
  copyTree(path.join(sourceDir, "dist-electron"), path.join(appDir, "dist-electron"));
  const tools = path.join(root, "tools", "proton-confgen", "build");
  fs.mkdirSync(tools, { recursive: true });
  const goFile = path.join(root, "captcha-helper.go");
  fs.writeFileSync(goFile, helperSource);
  const binary = path.join(tools, process.platform === "win32" ? "proton-confgen.exe" : "proton-confgen");
  const built = spawnSync("go", ["build", "-o", binary, goFile], { encoding: "utf8" });
  if (built.status !== 0) fail(`falha ao compilar helper Go: ${built.stderr || built.stdout}`);
  if (options.missingHelper) fs.rmSync(binary, { force: true });
  const preload = path.join(appDir, "dist-electron", "proton-captcha-preload.cjs");
  if (options.missingPreload) fs.rmSync(preload, { force: true });
  if (options.corruptPreload) fs.writeFileSync(preload, "module.exports = ;\n");
  const bootstrap = path.join(root, "bootstrap.cjs");
  fs.copyFileSync(path.join(here, "captcha-login-bootstrap.cjs"), bootstrap);
  fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "golive-e2e-fixture", version: "1.0.0", type: "module", main: "../bootstrap.cjs" }));
  return { appDir, binary, bootstrap };
}

let cycleIndex = 0;
async function runCase(caseName, action, options={}) {
  const rootBase = requestedAppDir ? path.resolve(requestedAppDir) : fs.mkdtempSync(path.join(os.tmpdir(), "golive-captcha-e2e-"));
  const root = requestedAppDir ? path.join(rootBase, `cycle-${++cycleIndex}`) : rootBase;
  const out = path.join(root, "artifacts"); fs.mkdirSync(out, { recursive: true });
  const state = path.join(out, "helper-state.json"); const events = path.join(out, "events.ndjson"); const result = path.join(out, "result.json"); const config = path.join(out, "config.json");
  writeJson(config, { caseId: caseName, scenario: action === "retry" ? "retry" : "success", expectedUsername: "e2e@example.invalid", action, expectSuccess: options.expectSuccess ?? ["success", "double-click", "retry", "early-response", "invalid-immediate-valid"].includes(action), loadFailure: action === "loadfailure" }); writeJson(state, {}); fs.writeFileSync(events, "");
  const fixture = makeFixture(root, caseName, options); const env = { ...process.env, GOLIVE_CAPTCHA_E2E_CONFIG: config, GOLIVE_CAPTCHA_E2E_STATE: state, GOLIVE_CAPTCHA_E2E_EVENTS: events, GOLIVE_CAPTCHA_E2E_RESULT: result, GOLIVE_CAPTCHA_E2E_USER_DATA: path.join(out, "user-data"), XDG_CONFIG_HOME: path.join(out, "xdg-config"), XDG_DATA_HOME: path.join(out, "xdg-data"), XDG_CACHE_HOME: path.join(out, "xdg-cache"), APPDATA: path.join(out, "appdata"), LOCALAPPDATA: path.join(out, "localappdata") };
  for (const value of [env.XDG_CONFIG_HOME,env.XDG_DATA_HOME,env.XDG_CACHE_HOME,env.APPDATA,env.LOCALAPPDATA]) fs.mkdirSync(value,{recursive:true});
  const electron = path.join(sourceDir, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron"); if(!fs.existsSync(electron)) fail(`Electron não encontrado em ${electron}`);
  const electronFlags = ["--no-sandbox"]; if (process.platform === "linux") electronFlags.push("--disable-gpu", "--ozone-platform=x11");
  const child = spawn(electron, [...electronFlags, fixture.appDir], { cwd: root, env, stdio: ["ignore","pipe","pipe"] }); let stderr=""; child.stdout.resume(); child.stderr.on("data",d=>{stderr+=d.toString()});
  let spawnError; child.on("error", e=>{spawnError=e}); const limit=action==='timeout'?155000:35000; const code = await new Promise(resolve=>{ let done=false; const timer=setTimeout(()=>{ if(!done){done=true; child.kill('SIGKILL'); resolve(124); }},limit); child.on("close", c=>{if(!done){done=true;clearTimeout(timer);resolve(c);}}); }); let data={}; try{data=JSON.parse(fs.readFileSync(result,"utf8"))}catch{}
  data.artifacts=out; data.exitCode=code; data.stderr=stderr.slice(-4000); if(spawnError) data.spawnError=String(spawnError); writeJson(path.join(out,"summary.json"),data); if(code!==0 || data.result!=="PASS") fail(`caso ${caseName}/${action} falhou; artefatos: ${out}`); return data;
}

const cases = selected === "suite" ? [{name:"success",action:"success"},{name:"double",action:"double-click"},{name:"retry",action:"retry"},{name:"cancel",action:"close",expectSuccess:false},{name:"destroy",action:"destroy",expectSuccess:false},{name:"early",action:"early-response"},{name:"immediate",action:"invalid-immediate-valid"},{name:"invalid",action:"invalid",expectSuccess:false},{name:"loadfailure",action:"loadfailure",expectSuccess:false},{name:"missing-helper",action:"missing-helper",expectSuccess:false,missingHelper:true},{name:"missing-preload",action:"missing-preload",expectSuccess:false,missingPreload:true},{name:"corrupt-preload",action:"corrupt-preload",expectSuccess:false,corruptPreload:true},{name:"timeout",action:"timeout",expectSuccess:false}] : [{name:selected,action:selected,expectSuccess:["success","double-click","retry","early-response","invalid-immediate-valid"].includes(selected),missingHelper:selected==='missing-helper',missingPreload:selected==='missing-preload',corruptPreload:selected==='corrupt-preload'}];
const results=[];
try { fs.mkdirSync(outputRoot,{recursive:true}); if(!fs.existsSync(path.join(sourceDir,"dist-electron","main.js"))) fail(`artefato ausente: ${sourceDir}/dist-electron/main.js`); for(const c of cases) for(let i=0;i<(c.action==='timeout'?1:repeat);i++) results.push(await runCase(c.name+`-${i+1}`,c.action,c)); writeJson(path.join(outputRoot,"summary.json"),{result:"PASS",cases:results.length,artifacts:results.map(r=>r.artifacts)}); console.log(JSON.stringify({result:"PASS",cases:results.length,outputRoot},null,2)); } catch (error) { writeJson(path.join(outputRoot,"summary.json"),{result:"FAIL",cases:results.length,artifacts:results.map(r=>r.artifacts),error:String(error.message||error)}); console.error(error.stack||error); process.exitCode=1; }
