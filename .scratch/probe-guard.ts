// Live probe for the guard's fallback paths.
//
// Two things smoke.mjs cannot reach: (1) that a *blocked* read is genuinely allowed
// through when the summarizer fails, which is decided by pi's own runner, and (2) that
// the block reason survives into the tool result the model sees.
//
// The summarizer is forced to fail by pointing summary.model at a provider that has no
// credentials, since the guard resolves its model the same way the tool does.
export default function (pi) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read") return;
		const note = `probe: read input=${JSON.stringify(event.input)} hasUI=${ctx.hasUI} mode=${ctx.mode}`;
		try {
			ctx.ui.notify(note, "info");
		} catch {}
		try {
			const { writeFileSync } = await import("node:fs");
			writeFileSync("probe-guard.out", `${note}\n`);
		} catch {}
	});
}
