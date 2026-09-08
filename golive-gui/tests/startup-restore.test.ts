import { describe, expect, it, vi } from "vitest";
import { restoreBypassOnStartup } from "../electron/startup-restore";

describe("restauração do bypass no autostart", () => {
  it("não ativa nem otimiza quando a preferência está desligada", async () => {
    const calls: string[] = [];
    const result = await restoreBypassOnStartup({
      enabled: false,
      isActive: async () => { calls.push("active"); return false; },
      optimize: async () => { calls.push("optimize"); return { success: true }; },
      activate: async () => { calls.push("activate"); },
    });

    expect(result.status).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("executa otimização antes da ativação", async () => {
    const calls: string[] = [];
    const result = await restoreBypassOnStartup({
      enabled: true,
      isActive: async () => false,
      optimize: async () => { calls.push("optimize"); return { success: true }; },
      activate: async () => { calls.push("activate"); },
    });

    expect(result).toMatchObject({ status: "activated", optimized: true, usedFallback: false });
    expect(calls).toEqual(["optimize", "activate"]);
  });

  it("ativa usando fallback quando a otimização falha", async () => {
    const calls: string[] = [];
    const result = await restoreBypassOnStartup({
      enabled: true,
      isActive: async () => false,
      optimize: async () => { calls.push("optimize"); return { success: false, error: "sem rede" }; },
      activate: async () => { calls.push("activate"); },
    });

    expect(result).toMatchObject({ status: "activated", optimized: false, usedFallback: true });
    expect(calls).toEqual(["optimize", "activate"]);
  });

  it("não repete a operação quando o túnel já está ativo", async () => {
    const optimize = vi.fn();
    const activate = vi.fn();
    const result = await restoreBypassOnStartup({
      enabled: true,
      isActive: async () => true,
      optimize,
      activate,
    });

    expect(result.status).toBe("already-active");
    expect(optimize).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it("cancela entre a otimização e a ativação", async () => {
    const controller = new AbortController();
    const activate = vi.fn();
    const result = await restoreBypassOnStartup({
      enabled: true,
      signal: controller.signal,
      isActive: async () => false,
      optimize: async () => {
        controller.abort();
        return { success: true };
      },
      activate,
    });

    expect(result.status).toBe("cancelled");
    expect(activate).not.toHaveBeenCalled();
  });
});
