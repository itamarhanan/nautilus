// The runner loads this into every Node process of a project's dev server
// through NODE_OPTIONS. A dev server that asks for a port the runner owns, or
// one something else already holds, listens on a free port instead of taking
// the runner's or exiting with EADDRINUSE; the runner finds it wherever it
// ends up. The runner's ports arrive in this module's URL, because task
// runners such as turbo pass NODE_OPTIONS on but drop most other variables.
import net from "node:net";

// A runner hosted by another runner adds its own ports to the ones it
// inherited, so every copy of this module shares one set and patches once.
const shared = Symbol.for("nautilus.devPortShim");
const state = (globalThis[shared] ??= { reserved: new Set(), installed: false });
for (const port of (new URL(import.meta.url).searchParams.get("reserved") ?? "").split(",")) {
  if (Number(port) > 0) state.reserved.add(Number(port));
}

function toPort(value) {
  const port = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function portOf(args) {
  const [first] = args;
  if (typeof first === "object" && first !== null) {
    return first.path === undefined ? toPort(first.port) : undefined;
  }
  return toPort(first);
}

function withPort(args, port) {
  const [first, ...rest] = args;
  return typeof first === "object" && first !== null
    ? [{ ...first, port }, ...rest]
    : [port, ...rest];
}

function report(port, reason) {
  process.stderr.write(`nautilus: port ${String(port)} is ${reason}, listening on a free port\n`);
}

if (!state.installed) {
  state.installed = true;
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    const port = portOf(args);
    if (port === undefined) return listen.apply(this, args);
    if (state.reserved.has(port)) {
      report(port, "used by nautilus");
      return listen.apply(this, withPort(args, 0));
    }
    // A failed listen reports EADDRINUSE through an 'error' event, so the
    // event is caught before any handler of the dev server sees it, and the
    // listen is tried once more on a free port. Its callback is already
    // waiting for 'listening'.
    const server = this;
    const ownEmit = Object.hasOwn(server, "emit");
    const emit = server.emit;
    const retry = args.filter((arg) => typeof arg !== "function");
    const restore = () => {
      if (ownEmit) server.emit = emit;
      else delete server.emit;
    };
    server.emit = function (event, ...rest) {
      if (event === "error" && rest[0]?.code === "EADDRINUSE") {
        restore();
        report(port, "in use");
        listen.apply(server, withPort(retry, 0));
        return true;
      }
      if (event === "error" || event === "listening") restore();
      return emit.call(this, event, ...rest);
    };
    return listen.apply(this, args);
  };
}
