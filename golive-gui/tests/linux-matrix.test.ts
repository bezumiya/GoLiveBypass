import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd(), "..");
const matrix = fs.readFileSync(path.join(root, "tests/test-linux-matrix.sh"), "utf8");
const vm = fs.readFileSync(path.join(root, "tests/test-linux-vm.sh"), "utf8");
const loop = fs.readFileSync(path.join(root, "tests/run-linux-stability-loop.sh"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/linux-stability.yml"), "utf8");

describe("contrato do laboratorio Linux", () => {
  it("mantem a matriz atual/anterior e o snapshot Arch explicitos", () => {
    for (const image of [
      "docker.io/library/ubuntu:24.04",
      "docker.io/library/ubuntu:22.04",
      "docker.io/library/debian:13-slim",
      "docker.io/library/debian:12-slim",
      "docker.io/library/fedora:43",
      "docker.io/library/fedora:42",
      "docker.io/archlinux:base",
      "snapshot-2025-09-01",
    ]) {
      expect(matrix).toContain(image);
    }
    expect(matrix).toContain("archive.archlinux.org/repos");
  });

  it("mantem containers descartaveis e sem rede do host", () => {
    expect(matrix).toContain("--rm");
    expect(matrix).toContain("-v \"$ROOT:/repo:ro\"");
    expect(matrix).toContain("APPIMAGE_STRICT_LIBS");
    expect(matrix).not.toMatch(/--network(?:=|\s+)host/);
    expect(matrix).not.toMatch(/-v\s+\/(?:etc|run|sys|proc)(?:[:\s]|$)/);
  });

  it("separa a prova Premium por hook e verifica a rota do host", () => {
    expect(vm).toContain("PROTON_VM_HOOK");
    expect(vm).toContain("ip -o route show default");
    expect(vm).toContain("nao inicia VMs automaticamente");
    expect(vm).not.toMatch(/PROTON_SESSION|PRIVATE_KEY|WG_CONF/);
  });

  it("workflow de estabilidade nao publica releases", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("npm run build:linux");
    expect(workflow).toContain("./tests/test-linux-matrix.sh --quick");
    expect(workflow).not.toMatch(/publish:(?:win|linux|mac)/);
    expect(workflow).not.toContain("--publish always");
  });

  it("mantem o loop continuo sob sinal explicito de parada", () => {
    expect(loop).toContain('while [[ ! -e "$STOP_FILE" ]]');
    expect(loop).toContain("cycles.jsonl");
    expect(loop).toContain("--once");
    expect(loop).toContain("LAST_APPIMAGE_SIGNATURE");
    expect(loop).toContain("APPIMAGE_LDD_MISSING");
    expect(loop).not.toMatch(/MAX_CYCLES|MAX_ROUNDS/);
  });
});
