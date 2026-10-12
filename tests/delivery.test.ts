import { describe, expect, it } from "vitest";
import { classifySmtpFailure } from "../src/domain/delivery";
describe("SMTP failure classification", () => {
  it("treats a server refusal or a failed login as not sent", () => {
    expect(
      classifySmtpFailure({
        command: "DATA",
        responseCode: 550,
        response: "550 5.7.1 Sender domain not verified",
      }),
    ).toEqual({
      outcome: "transport_rejected",
      command: "DATA",
      responseCode: 550,
      status: "5.7.1",
    });
    expect(classifySmtpFailure({ command: "RCPT TO", responseCode: 451 }).outcome).toBe(
      "transport_rejected",
    );
    expect(classifySmtpFailure({ code: "EAUTH", command: "AUTH PLAIN" }).outcome).toBe(
      "transport_rejected",
    );
    expect(classifySmtpFailure({ code: "ECONNECTION", command: "CONN" }).outcome).toBe(
      "transport_rejected",
    );
  });
  it("keeps acceptance unknown when the message may have reached the server", () => {
    expect(classifySmtpFailure({ code: "ETIMEDOUT", command: "DATA" })).toEqual({
      outcome: "transport_acceptance_unknown",
      command: "DATA",
      responseCode: null,
      status: null,
    });
    expect(classifySmtpFailure({ code: "ESOCKET" }).outcome).toBe("transport_acceptance_unknown");
    expect(classifySmtpFailure(new Error("other")).outcome).toBe("transport_acceptance_unknown");
    expect(classifySmtpFailure({ responseCode: 250 }).outcome).toBe("transport_acceptance_unknown");
  });
});
