// lib/plugins/manual.js - assistant built-in fallback (plan §3.1): start from config,
// stop by port (pid lookup + TERM->KILL), status by port. Not an npm package.
"use strict";

const { stopByPort, spawnOpts } = require("../proc");

function createManualPlugin(ctx) {
  // ctx: { log(), onLine(), ptyModule }
  const children = new Map(); // name -> {pid, handle, ptyHandle, mode}

  return {
    id: "manual",
    platforms: ["linux", "darwin", "win32"],
    detect: async () => true,

    async install(spec) {
      // manual manager has nothing to register with the OS: stateless by design
      return { skipped: "manual manager registers nothing" };
    },
    async uninstall(name) { return { skipped: "manual manager" }; },

    // spec: {name, cmd, args, cwd, env, port, pty}
    async start(spec) {
      const { spawnParent } = require("../proc");
      const parent = spawnParent(
        { cmd: spec.cmd, args: spec.args, cwd: spec.cwd, env: spec.env, pty: spec.pty },
        ctx.onLine,
        ctx.ptyModule,
      );
      children.set(spec.name, parent);
      ctx.log("info", `[manual] started "${spec.name}" pid=${parent.pid} mode=${parent.mode}`);
      return { pid: parent.pid, mode: parent.mode };
    },

    async stop(name, spec) {
      const s = spec || {};
      const child = children.get(name);
      if (child) {
        children.delete(name);
        if (child.ptyHandle) {
          try { child.ptyHandle.kill(); } catch (_) { /* ignore */ }
          return { stopped: true, via: "pty" };
        }
        if (child.handle) {
          const { killPid } = require("../util");
          await killPid(child.pid, { graceMs: s.graceMs || 5000, tree: false });
          return { stopped: true, via: "child" };
        }
      }
      // fall back to byPort (works across assistant restarts)
      if (!s.port) throw new Error(`manual stop needs a port (or a tracked child)`);
      const r = await stopByPort(s.port, s.graceMs || 5000, ctx.onLine);
      if (!r.stopped) throw new Error(`stopByPort failed: ${r.reason}`);
      return { stopped: true, via: "byPort", pid: r.pid };
    },

    async restart(name, spec) {
      await this.stop(name, spec);
      await sleepImpl(400);
      return this.start(spec);
    },

    async updateEnv(name) {
      // manual form env comes from config at spawn time; there is no service definition to rewrite
      return { skipped: "manual form env is config-driven (restart applies it)" };
    },

    async status(name, spec) {
      if (spec && spec.port) {
        const { findPidByPort } = require("../util");
        const pid = await findPidByPort(spec.port);
        return pid ? "running" : "stopped";
      }
      const child = children.get(name);
      if (child) {
        const { isAlive } = require("../util");
        return isAlive(child.pid) ? "running" : "stopped";
      }
      return "unknown";
    },

    async logs(name, tail) { return ""; },

    // interactive stdin (plan §3.3): pty preferred, plain pipe fallback
    input(name, data) {
      const child = children.get(name);
      if (!child) return false;
      return writeParentInput(child, data);
    },
  };
}

function sleepImpl(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { createManualPlugin, spawnOpts };
