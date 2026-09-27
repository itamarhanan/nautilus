import { ApiError } from "./api";

export function friendlyError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission denied/i.test(message)) {
    return new Error(
      "The runner rejected the SSH key. Run `lightning ssh configure` again or check the key path.",
    );
  }
  if (/no such file|identity file .* not accessible/i.test(message)) {
    return new Error("The SSH key file was not found at the configured path.");
  }
  if (/could not resolve|name or service not known/i.test(message)) {
    return new Error("The SSH host name could not be resolved. Check your network.");
  }
  if (/host key verification failed/i.test(message)) {
    return new Error(
      "The runner's SSH host key changed. Check ~/.ssh/known_hosts before reconnecting.",
    );
  }
  if (/did not become ready/i.test(message)) {
    return new Error(
      "SSH connected, but the runner's control API did not answer. Is the Studio running?",
    );
  }
  if (/runner_offline|not reachable/i.test(message)) {
    return new Error("The runner is not reachable. Is the Studio running?");
  }
  return error instanceof Error ? error : new Error(message);
}

export function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.code === "runner_offline")
    return "The runner is not reachable.";
  if (error instanceof ApiError && error.code === "agent_offline")
    return "The sync agent is not running.";
  return error instanceof Error && error.message ? error.message : fallback;
}
