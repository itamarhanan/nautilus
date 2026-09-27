import { expect, test } from "vitest";
import { formatLocation, parseLocation } from "@/lib/location";

test("round-trips a full location", () => {
  const location = { projectId: "p1", sessionId: "s1", view: "preview" as const, isInfoOpen: true };
  const search = formatLocation(location);
  expect(search).toBe("?project=p1&session=s1&view=preview&info");
  expect(parseLocation(search)).toEqual(location);
});

test("leaves defaults out of the address", () => {
  expect(
    formatLocation({ projectId: "p1", sessionId: null, view: "chat", isInfoOpen: false }),
  ).toBe("?project=p1");
  expect(
    formatLocation({ projectId: null, sessionId: null, view: "chat", isInfoOpen: false }),
  ).toBe("");
});

test("ignores a session without a project and an unknown view", () => {
  expect(parseLocation("?session=s1&view=terminal")).toEqual({
    projectId: null,
    sessionId: null,
    view: "chat",
    isInfoOpen: false,
  });
});

test("ignores unrelated parameters such as a pairing code", () => {
  expect(parseLocation("?pair=ABCD&project=p1").projectId).toBe("p1");
});
