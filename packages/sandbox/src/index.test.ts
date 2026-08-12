import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectSandboxPlatform,
  buildDockerExecArgs,
  buildDockerBuildArgs,
  buildDockerImageInspectArgs,
  buildDockerRunArgs,
  buildDockerSupervisedArgv,
  createProcess,
  DOCKER_CONFIG_HASH_LABEL,
  DOCKER_WORKSPACE_LABEL,
  dockerContainerName,
  dockerReusableContainerName,
  dockerSandboxConfigHash,
  dockerNetworkMode,
  hostPathToContainerPath,
  getDockerAvailability,
  getSandboxAvailability,
  getSrtAvailability,
  shellJoin,
  normalizeSandboxConfig,
  resolveContainerShellArgv,
  resolveShellArgv,
  resetHostShellCacheForTests,
  SandboxAdapter,
  validateSandboxPath,
  wrapCommandForSrt,
  SandboxUnavailableError,
  startSandboxRuntime,
  getActiveSandboxSession,
  isSandboxSessionActive,
  setActiveSandboxSession,
  toContainerWorkspacePath,
} from "./index.js";

describe("SandboxAdapter", () => {
  it("isAvailable returns false when sandbox is not configured", () => {
    const adapter = new SandboxAdapter();
    expect(adapter.isAvailable()).toBe(false);
  });

  it("execute runs through the shared shell path", async () => {
    const adapter = new SandboxAdapter();
    const result = await adapter.execute("echo adapter-ok");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("adapter-ok");
  }, 20_000);
});

describe("normalizeSandboxConfig", () => {
  it("fills defaults and preserves nested overrides", () => {
    const config = normalizeSandboxConfig({
      enabled: true,
      backend: "docker",
      filesystem: { allowWrite: ["src"] },
      network: { mode: "bridge" },
      docker: { image: "custom:latest" },
    });

    expect(config.enabled).toBe(true);
    expect(config.backend).toBe("docker");
    expect(config.filesystem.allowRead).toEqual(["."]);
    expect(config.filesystem.allowWrite).toEqual(["src"]);
    expect(config.network.mode).toBe("bridge");
    expect(config.network.deniedDomains).toEqual([]);
    expect(config.docker.image).toBe("custom:latest");
    expect(config.docker.autoBuildImage).toBe(true);
  });

  it("accepts legacy runtime aliases", () => {
    expect(normalizeSandboxConfig({ enabled: true, runtime: "docker" }).backend).toBe("docker");
  });
});

describe("detectSandboxPlatform", () => {
  it("detects WSL from Linux release or env", () => {
    expect(detectSandboxPlatform({ platform: "linux", release: "microsoft-standard" })).toBe("wsl");
    expect(detectSandboxPlatform({ platform: "linux", release: "generic", env: { WSL_DISTRO_NAME: "Ubuntu" } })).toBe("wsl");
  });

  it("maps native platforms", () => {
    expect(detectSandboxPlatform({ platform: "win32" })).toBe("windows");
    expect(detectSandboxPlatform({ platform: "darwin" })).toBe("macos");
    expect(detectSandboxPlatform({ platform: "linux", release: "generic", env: {} })).toBe("linux");
  });
});

describe("sandbox availability", () => {
  it("reports disabled sandbox", () => {
    expect(getSandboxAvailability({ enabled: false })).toMatchObject({
      enabled: false,
      available: false,
      active: false,
      reason: "sandbox is disabled",
    });
  });

  it("rejects native Windows for srt", () => {
    const availability = getSrtAvailability(
      { enabled: true, backend: "srt" },
      { platform: "windows", which: () => "tool" },
    );

    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("native Windows");
  });

  it("requires srt and bwrap on linux", () => {
    const missingSrt = getSrtAvailability(
      { enabled: true, backend: "srt" },
      { platform: "linux", which: () => undefined },
    );
    expect(missingSrt.reason).toContain("sandbox runtime CLI not found");

    const missingBwrap = getSrtAvailability(
      { enabled: true, backend: "srt" },
      { platform: "linux", which: (cmd) => cmd === "srt" ? "/bin/srt" : undefined },
    );
    expect(missingBwrap.reason).toContain("bwrap");
  });

  it("reports srt available when dependencies exist", () => {
    const availability = getSrtAvailability(
      { enabled: true, backend: "srt" },
      { platform: "linux", which: (cmd) => `/bin/${cmd}` },
    );

    expect(availability).toMatchObject({
      enabled: true,
      available: true,
      active: true,
      backend: "srt",
      command: "/bin/srt",
    });
  });

  it("allows native Windows for Docker Desktop", () => {
    const availability = getDockerAvailability(
      { enabled: true, backend: "docker" },
      { platform: "windows", which: () => "docker", dockerInfo: () => true },
    );

    expect(availability).toMatchObject({
      available: true,
      active: true,
      backend: "docker",
      platform: "windows",
    });
  });

  it("allows Docker bridge mode while marking domain policy as degraded", () => {
    const availability = getDockerAvailability(
      {
        enabled: true,
        backend: "docker",
        network: { mode: "bridge", allowedDomains: ["github.com"] },
      },
      { platform: "linux", which: () => "/bin/docker", dockerInfo: () => true },
    );

    expect(availability.available).toBe(true);
    expect(availability.degraded).toBe(true);
    expect(availability.reason).toContain("does not enforce domain policy");
  });

  it("requires proxy env for Docker proxy network mode", () => {
    const availability = getDockerAvailability(
      { enabled: true, backend: "docker", network: { mode: "proxy" } },
      { platform: "linux", which: () => "/bin/docker", dockerInfo: () => true },
    );

    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("requires HTTP_PROXY or HTTPS_PROXY");
  });

  it("allows Docker proxy mode when proxy env is configured", () => {
    const availability = getDockerAvailability(
      {
        enabled: true,
        backend: "docker",
        network: { mode: "proxy", allowedDomains: ["github.com"] },
        docker: { extraEnv: { HTTPS_PROXY: "http://proxy.local:7890" } },
      },
      { platform: "linux", which: () => "/bin/docker", dockerInfo: () => true },
    );

    expect(availability.available).toBe(true);
    expect(availability.degraded).toBe(true);
    expect(availability.reason).toContain("does not enforce domain policy");
  });

  it("fails closed for strict Docker domain policy on bridge mode", () => {
    const availability = getDockerAvailability(
      {
        enabled: true,
        backend: "docker",
        network: {
          mode: "bridge",
          allowedDomains: ["github.com"],
          strictDomainPolicy: true,
        },
      },
      { platform: "linux", which: () => "/bin/docker" },
    );

    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("strict domain policy");
  });

  it("checks Docker daemon when a dockerInfo probe is provided", () => {
    const availability = getDockerAvailability(
      { enabled: true, backend: "docker" },
      { platform: "linux", which: () => "/bin/docker", dockerInfo: () => false },
    );

    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("daemon");
  });
});

describe("sandbox runtime lifecycle", () => {
  const settings = {
    model: "m",
    apiFormat: "openai" as const,
    maxTurns: 1,
    permission: { mode: "default" as const },
  };

  it("returns off status when sandbox is disabled", async () => {
    const runtime = await startSandboxRuntime({
      settings: { ...settings, sandbox: { enabled: false } },
      cwd: process.cwd(),
      sessionId: "test",
    });

    expect(runtime.status).toMatchObject({
      state: "off",
      enabled: false,
      active: false,
      backend: "srt",
    });
  });

  it("reports active srt status without starting a long-lived session", async () => {
    const runtime = await startSandboxRuntime({
      settings: { ...settings, sandbox: { enabled: true, backend: "srt" } },
      cwd: process.cwd(),
      sessionId: "test",
      deps: { platform: "linux", which: (cmd) => `/bin/${cmd}` },
    });

    expect(runtime.status).toMatchObject({
      state: "active",
      enabled: true,
      active: true,
      backend: "srt",
      platform: "linux",
    });
  });

  it("throws when srt is unavailable in strict mode", async () => {
    await expect(
      startSandboxRuntime({
        settings: {
          ...settings,
          sandbox: { enabled: true, backend: "srt", failIfUnavailable: true },
        },
        cwd: process.cwd(),
        sessionId: "test",
        deps: { platform: "linux", which: () => undefined },
      }),
    ).rejects.toThrow(SandboxUnavailableError);
  });

  it("reports unavailable Docker status without strict mode", async () => {
    const events: string[] = [];
    const runtime = await startSandboxRuntime({
      settings: { ...settings, sandbox: { enabled: true, backend: "docker" } },
      cwd: process.cwd(),
      sessionId: "test",
      deps: { platform: "linux", which: () => undefined },
      reporter: (event) => events.push(event.type),
    });

    expect(runtime.status).toMatchObject({
      state: "unavailable",
      enabled: true,
      active: false,
      backend: "docker",
    });
    expect(runtime.status.reason).toContain("Docker CLI not found");
    expect(events).toEqual(["start", "check-availability", "unavailable"]);
  });
});

describe("sandbox active session registry", () => {
  afterEach(() => {
    setActiveSandboxSession(null);
  });

  function makeSession(cwd: string) {
    return {
      backend: "docker" as const,
      cwd: resolve(cwd),
      active: true,
      start: async () => {},
      stop: async () => {},
      stopSync: () => {},
    };
  }

  it("tracks active sessions by cwd", () => {
    const first = makeSession("D:/repo-a");
    const second = makeSession("D:/repo-b");

    setActiveSandboxSession(first);
    setActiveSandboxSession(second);

    expect(getActiveSandboxSession(first.cwd)).toBe(first);
    expect(getActiveSandboxSession(second.cwd)).toBe(second);
    expect(isSandboxSessionActive(first.cwd)).toBe(true);
    expect(isSandboxSessionActive(second.cwd)).toBe(true);
    expect(getActiveSandboxSession()).toBe(second);
  });

  it("isolates active sandboxes by sessionId within the same cwd", () => {
    const cwd = resolve("D:/shared-repo");
    const sessionA = makeSession(cwd);
    const sessionB = makeSession(cwd);
    const cwdOnly = makeSession(cwd);

    setActiveSandboxSession(sessionA, { cwd, sessionId: "s-a" });
    setActiveSandboxSession(sessionB, { cwd, sessionId: "s-b" });
    setActiveSandboxSession(cwdOnly, cwd);

    expect(getActiveSandboxSession({ cwd, sessionId: "s-a" })).toBe(sessionA);
    expect(getActiveSandboxSession({ cwd, sessionId: "s-b" })).toBe(sessionB);
    expect(getActiveSandboxSession(cwd)).toBe(cwdOnly);
    expect(getActiveSandboxSession({ cwd, sessionId: "s-a" })).not.toBe(
      getActiveSandboxSession({ cwd, sessionId: "s-b" }),
    );

    setActiveSandboxSession(null, { cwd, sessionId: "s-a" });
    expect(getActiveSandboxSession({ cwd, sessionId: "s-a" })).toBeNull();
    expect(getActiveSandboxSession({ cwd, sessionId: "s-b" })).toBe(sessionB);
    expect(getActiveSandboxSession(cwd)).toBe(cwdOnly);
  });
});

describe("srt adapter", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "oh-srt-test-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("quotes argv as a single shell command", () => {
    expect(shellJoin(["bash", "-lc", "echo 'hi there'"])).toBe(
      "bash -lc 'echo '\\''hi there'\\'''",
    );
  });

  it("writes srt settings and returns wrapped argv", async () => {
    const wrapped = await wrapCommandForSrt(
      ["bash", "-lc", "echo hi"],
      {
        enabled: true,
        backend: "srt",
        network: { allowedDomains: ["github.com"] },
        filesystem: { allowWrite: [".", "/tmp"], denyRead: ["~/.ssh"] },
        srt: { runtimeCommand: "/bin/srt" },
      },
      { tmpRoot: tempRoot },
    );

    expect(wrapped.argv.slice(0, 4)).toEqual([
      "/bin/srt",
      "--settings",
      wrapped.settingsPath,
      "-c",
    ]);
    expect(wrapped.argv[4]).toBe("bash -lc 'echo hi'");

    const settings = JSON.parse(await readFile(wrapped.settingsPath, "utf-8"));
    expect(settings.network.allowedDomains).toEqual(["github.com"]);
    expect(settings.filesystem.allowWrite).toEqual([".", "/tmp"]);
    expect(settings.filesystem.denyRead).toEqual(["~/.ssh"]);

    await wrapped.cleanup();
    await expect(stat(wrapped.settingsPath)).rejects.toThrow();
  });
});

describe("docker backend argv builders", () => {
  it("builds docker run args with bridge networking and resource limits", () => {
    const argv = buildDockerRunArgs({
      sessionId: "abc/123",
      cwd: "D:/repo",
      dockerCommand: "/bin/docker",
      config: {
        enabled: true,
        backend: "docker",
        network: { mode: "bridge" },
        docker: {
          image: "custom:latest",
          cpuLimit: 2,
          memoryLimit: "4g",
          dns: ["1.1.1.1"],
          extraMounts: ["/cache:/cache"],
          extraEnv: { A: "B" },
        },
      },
    });

    expect(argv.slice(0, 2)).toEqual(["/bin/docker", "run"]);
    expect(argv).toContain("--network");
    expect(argv[argv.indexOf("--network") + 1]).toBe("bridge");
    expect(argv[argv.indexOf("--name") + 1]).toBe("openharness-sandbox-abc-123");
    expect(argv).toContain("--label");
    expect(argv).toContain(`${DOCKER_WORKSPACE_LABEL}=${resolve("D:/repo")}`);
    expect(argv[argv.indexOf("--cpus") + 1]).toBe("2");
    expect(argv[argv.indexOf("--memory") + 1]).toBe("4g");
    expect(argv[argv.indexOf("--dns") + 1]).toBe("1.1.1.1");
    expect(argv[argv.indexOf("-w") + 1]).toBe(toContainerWorkspacePath(resolve("D:/repo")));
    expect(argv).toContain("/cache:/cache");
    expect(argv).toContain("A=B");
    expect(argv.at(-4)).toBe("custom:latest");
  });

  it("defaults docker networking to none", () => {
    const argv = buildDockerRunArgs({
      sessionId: "s",
      cwd: "D:/repo",
      config: { enabled: true, backend: "docker" },
    });

    expect(argv[argv.indexOf("--network") + 1]).toBe("none");
  });

  it("omits --rm and uses a project container name for reusable docker containers", () => {
    const cwd = "D:/repo";
    const argv = buildDockerRunArgs({
      sessionId: "s",
      cwd,
      config: {
        enabled: true,
        backend: "docker",
        docker: { reuseContainer: true },
      },
    });

    expect(argv).not.toContain("--rm");
    expect(argv[argv.indexOf("--name") + 1]).toBe(dockerReusableContainerName(resolve(cwd)));
    expect(argv).toContain(`${DOCKER_CONFIG_HASH_LABEL}=${dockerSandboxConfigHash(
      normalizeSandboxConfig({ enabled: true, backend: "docker", docker: { reuseContainer: true } }),
      resolve(cwd),
    )}`);
  });

  it("maps docker proxy mode to bridge networking and injects proxy env", () => {
    const argv = buildDockerRunArgs({
      sessionId: "proxy",
      cwd: "D:/repo",
      config: {
        enabled: true,
        backend: "docker",
        network: { mode: "proxy" },
        docker: {
          extraEnv: {
            HTTP_PROXY: "http://host.docker.internal:7890",
            HTTPS_PROXY: "http://host.docker.internal:7890",
            NO_PROXY: "localhost,127.0.0.1",
          },
        },
      },
    });

    expect(dockerNetworkMode("proxy")).toBe("bridge");
    expect(argv[argv.indexOf("--network") + 1]).toBe("bridge");
    expect(argv).toContain("HTTP_PROXY=http://host.docker.internal:7890");
    expect(argv).toContain("HTTPS_PROXY=http://host.docker.internal:7890");
    expect(argv).toContain("NO_PROXY=localhost,127.0.0.1");
  });

  it("fails closed for docker proxy mode without proxy env", () => {
    expect(() =>
      buildDockerRunArgs({
        sessionId: "proxy",
        cwd: "D:/repo",
        config: { enabled: true, backend: "docker", network: { mode: "proxy" } },
      }),
    ).toThrow("requires HTTP_PROXY or HTTPS_PROXY");
  });

  it("fails closed for strict domain policy on bridge networking", () => {
    expect(() =>
      buildDockerRunArgs({
        sessionId: "s",
        cwd: "D:/repo",
        config: {
          enabled: true,
          backend: "docker",
          network: {
            mode: "bridge",
            allowedDomains: ["github.com"],
            strictDomainPolicy: true,
          },
        },
      }),
    ).toThrow(SandboxUnavailableError);
  });

  it("builds docker exec args with cwd, env, and child argv", () => {
    const root = resolve("D:/repo");
    const cwd = resolve("D:/repo/src");
    const argv = buildDockerExecArgs({
      dockerCommand: "/bin/docker",
      containerName: "oh-s",
      cwd,
      workspaceRoot: root,
      env: { X: "1" },
      argv: ["bash", "-lc", "echo hi"],
    });

    expect(argv.slice(0, 3)).toEqual(["/bin/docker", "exec", "-i"]);
    expect(argv[argv.indexOf("-w") + 1]).toBe(hostPathToContainerPath(cwd, root));
    expect(argv).toContain("X=1");
    expect(argv.slice(-4)).toEqual(["oh-s", "bash", "-lc", "echo hi"]);
  });

  it("maps host paths to Docker workspace paths", () => {
    const root = resolve("D:/repo");
    const file = resolve("D:/repo/src/a.ts");
    if (process.platform === "win32") {
      expect(hostPathToContainerPath(root, root)).toBe("/workspace");
      expect(hostPathToContainerPath(file, root)).toBe("/workspace/src/a.ts");
      expect(() => hostPathToContainerPath(resolve("D:/other/a.ts"), root)).toThrow("outside the workspace");
    } else {
      expect(hostPathToContainerPath(file, root)).toBe(file);
    }
  });

  it("keeps docker command argv intact inside the process supervisor", () => {
    const argv = buildDockerSupervisedArgv(
      ["node", "-e", "console.log('a b')"],
      "exec-123",
    );

    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(argv).toContain("/tmp/openharness-exec/exec-123.pid");
    expect(argv).toContain("/tmp/openharness-exec/exec-123.cancel");
    expect(argv.slice(-3)).toEqual(["node", "-e", "console.log('a b')"]);
  });

  it("builds docker image inspect args", () => {
    expect(buildDockerImageInspectArgs("openharness-sandbox:latest", "/bin/docker")).toEqual([
      "/bin/docker",
      "image",
      "inspect",
      "openharness-sandbox:latest",
    ]);
  });

  it("builds docker image build args", () => {
    expect(buildDockerBuildArgs({
      dockerCommand: "/bin/docker",
      image: "openharness-sandbox:latest",
      dockerfile: "/repo/packages/sandbox/Dockerfile",
      context: "/repo/packages/sandbox",
    })).toEqual([
      "/bin/docker",
      "build",
      "-t",
      "openharness-sandbox:latest",
      "-f",
      "/repo/packages/sandbox/Dockerfile",
      "/repo/packages/sandbox",
    ]);
  });

  it("sanitizes docker container names", () => {
    expect(dockerContainerName("a/b c")).toBe("openharness-sandbox-a-b-c");
    expect(dockerContainerName("")).toBe("openharness-sandbox-session");
  });

  it("generates stable reusable docker container names per project", () => {
    const first = dockerReusableContainerName("D:/repo");
    const second = dockerReusableContainerName("D:/repo");
    const other = dockerReusableContainerName("D:/other");

    expect(first).toBe(second);
    expect(first).toMatch(/^openharness-sandbox-repo-[a-f0-9]{12}$/);
    expect(first).not.toBe(other);
  });

  it("changes docker config hash when container-affecting settings change", () => {
    const base = normalizeSandboxConfig({
      enabled: true,
      backend: "docker",
      network: { mode: "bridge" },
      docker: { image: "node:22-bookworm" },
    });
    const changed = normalizeSandboxConfig({
      enabled: true,
      backend: "docker",
      network: { mode: "none" },
      docker: { image: "node:22-bookworm" },
    });

    expect(dockerSandboxConfigHash(base, "D:/repo")).toBe(dockerSandboxConfigHash(base, "D:/repo"));
    expect(dockerSandboxConfigHash(base, "D:/repo")).not.toBe(dockerSandboxConfigHash(changed, "D:/repo"));
  });
});

describe("validateSandboxPath", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "oh-sandbox-root-"));
    outside = await mkdtemp(join(tmpdir(), "oh-sandbox-outside-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.txt"), "hello");
    await writeFile(join(outside, "secret.txt"), "nope");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("allows paths inside the sandbox root", async () => {
    const result = await validateSandboxPath(join(root, "src", "a.txt"), {
      sandboxRoot: root,
      operation: "read",
    });

    expect(result.allowed).toBe(true);
    expect(result.resolvedPath).toBe(resolve(root, "src", "a.txt"));
  });

  it("rejects traversal outside the sandbox root", async () => {
    const result = await validateSandboxPath(join(root, "..", "outside.txt"), {
      sandboxRoot: root,
      operation: "write",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside the sandbox boundary");
  });

  it("allows explicitly configured extra roots", async () => {
    const result = await validateSandboxPath(join(outside, "secret.txt"), {
      sandboxRoot: root,
      operation: "read",
      extraAllowedRoots: [outside],
    });

    expect(result.allowed).toBe(true);
  });

  it("applies deny rules before allow rules", async () => {
    const result = await validateSandboxPath(join(root, "src", "a.txt"), {
      sandboxRoot: root,
      operation: "read",
      config: {
        enabled: true,
        filesystem: {
          allowRead: ["."],
          denyRead: ["src"],
        },
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("denied by sandbox rule");
  });
});

describe("resolveShellArgv", () => {
  beforeEach(() => {
    resetHostShellCacheForTests();
  });

  it("uses non-login -c for posix host shell", () => {
    if (process.platform === "win32") return;
    expect(resolveShellArgv("echo hi")).toEqual(["/bin/sh", "-c", "echo hi"]);
  });

  it("caches host shell detection across calls", () => {
    if (process.platform === "win32") return;
    const first = resolveShellArgv("one");
    const second = resolveShellArgv("two");
    expect(first[0]).toBe(second[0]);
    expect(first[1]).toBe("-c");
    expect(second[1]).toBe("-c");
  });

  it("uses bash.exe -c (not -lc) when bash is selected on Windows", () => {
    if (process.platform !== "win32") return;
    const argv = resolveShellArgv("echo hi");
    if (argv[0] === "bash.exe") {
      expect(argv).toEqual(["bash.exe", "-c", "echo hi"]);
    } else {
      expect(["-Command", "/c"]).toContain(argv[argv.length - 2]);
      expect(argv.at(-1)).toBe("echo hi");
    }
  });
});

describe("createProcess", () => {
  afterEach(() => {
    setActiveSandboxSession(null);
  });

  it("runs argv directly when sandbox is disabled", async () => {
    const child = await createProcess(
      [process.execPath, "-e", "process.stdout.write('argv-ok')"],
      {
        cwd: process.cwd(),
        settings: {
          model: "test",
          apiFormat: "openai",
          maxTurns: 1,
          permission: { mode: "default" },
          sandbox: { enabled: false },
        },
      },
    );
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    await new Promise<void>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", () => resolvePromise());
    });
    expect(output).toBe("argv-ok");
  });

  it("routes argv to the active Docker session selected by cwd and sessionId", async () => {
    const cwd = resolve("D:/shared-create-process");
    const seen: string[][] = [];
    const expected = new Error("captured");
    setActiveSandboxSession({
      backend: "docker",
      cwd,
      active: true,
      start: async () => {},
      stop: async () => {},
      execCommand: async (argv) => {
        seen.push(argv);
        throw expected;
      },
    }, { cwd, sessionId: "session-a" });

    await expect(createProcess(["node", "script.js"], {
      cwd,
      sessionId: "session-a",
      settings: {
        model: "test",
        apiFormat: "openai",
        maxTurns: 1,
        permission: { mode: "default" },
        sandbox: { enabled: true, backend: "docker", failIfUnavailable: true },
      },
    })).rejects.toBe(expected);
    expect(seen).toEqual([["node", "script.js"]]);
  });

  it("fails closed when strict Docker mode has no matching active session", async () => {
    await expect(createProcess(["node", "script.js"], {
      cwd: process.cwd(),
      sessionId: "missing",
      settings: {
        model: "test",
        apiFormat: "openai",
        maxTurns: 1,
        permission: { mode: "default" },
        sandbox: { enabled: true, backend: "docker", failIfUnavailable: true },
      },
    })).rejects.toThrow("Docker sandbox session is not running");
  });

  it("rejects an empty argv", async () => {
    await expect(createProcess([], { cwd: process.cwd() })).rejects.toThrow("non-empty argv");
  });
});

describe("createShellProcess host shell policy", () => {
  it("uses the system shell without changing command quoting", async () => {
    const { createShellProcess } = await import("./index.js");
    const command = `"${process.execPath}" -e "process.stdout.write('system-shell-ok')"`;
    const child = await createShellProcess(command, {
      cwd: process.cwd(),
      hostShell: "system",
      settings: {
        model: "test",
        apiFormat: "openai",
        maxTurns: 1,
        permission: { mode: "default" },
        sandbox: { enabled: false },
      },
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    await new Promise<void>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", () => resolvePromise());
    });
    expect(output).toBe("system-shell-ok");
  });
});

describe("resolveContainerShellArgv", () => {
  it("always uses Linux /bin/sh -c regardless of host platform", () => {
    expect(resolveContainerShellArgv("echo hi")).toEqual(["/bin/sh", "-c", "echo hi"]);
  });
});
