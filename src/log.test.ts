import { expect, it, vi } from "vitest";
import { localTimestamp, log } from "./log.js";

it.each([[-330, "+05:30"], [420, "-07:00"], [-345, "+05:45"], [0, "+00:00"]])(
  "formats local ISO timestamps with offset %s", (offset, suffix) => {
    const date = new Date(2026, 9, 20, 12, 34, 56, 123);
    vi.spyOn(date, "getTimezoneOffset").mockReturnValue(offset as number);
    expect(localTimestamp(date)).toBe(`2026-10-20T12:34:56.123${suffix}`);
  }
);
it("prefixes every physical line including blank lines and CRLF messages", () => {
  const date = new Date(2026, 9, 20, 12, 34, 56, 123);
  vi.spyOn(date, "getTimezoneOffset").mockReturnValue(-330);
  const stream = { write: vi.fn() };
  log("Starting\r\n\nWebhook failed\rstack line\n", stream, date);
  expect(stream.write.mock.calls.map(([line]) => line)).toEqual([
    "[2026-10-20T12:34:56.123+05:30] Starting\n",
    "[2026-10-20T12:34:56.123+05:30] \n",
    "[2026-10-20T12:34:56.123+05:30] Webhook failed\n",
    "[2026-10-20T12:34:56.123+05:30] stack line\n"
  ]);
});
