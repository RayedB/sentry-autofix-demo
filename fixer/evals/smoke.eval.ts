import { defineEval } from "@grok/agent-sdk/evals";

const HEAD = "ddb25ec0c39385ce9e51dd3550f3c21fe0459084";

export default defineEval({
  tags: ["smoke"],
  description: "A LAUNCH_FIX message calls launch_fix once and does not call cloud__launch.",
  async test(t) {
    await t.send(
      [
        "LAUNCH_FIX",
        "prNumber: 7",
        "attempt: 1",
        `headSha: ${HEAD}`,
        "",
        "Call launch_fix once with those three fields. Stop after it returns.",
      ].join("\n"),
    );
    t.succeeded();
    t.calledTool("launch_fix", {
      input: { prNumber: 7, attempt: 1, headSha: HEAD },
      output: { launched: false, reason: "eval" },
    });
    t.notCalledTool("cloud__launch");
  },
});
