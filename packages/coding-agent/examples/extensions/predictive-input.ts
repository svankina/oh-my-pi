/**
 * Predictive Input Extension
 *
 * Claude Code-style prediction of your NEXT message. When the agent settles,
 * a cheap model is asked what you are most likely to type next, and the answer
 * is painted as dim ghost text in the empty prompt:
 *
 *   › now run the test suite
 *     ^^^^^^^^^^^^^^^^^^^^^^ dim, not in the buffer
 *
 * Tab accepts it into the editor (it is not submitted — you still press Enter).
 * Typing keeps the ghost only while what you typed is still a prefix of the
 * prediction, so it behaves like a normal inline completion rather than a
 * banner that lingers over unrelated text.
 *
 * Why it is built this way (all three are real constraints of the host, not
 * preference):
 *
 * - `AutocompleteProvider.getInlineHint()` is the only inline-ghost surface an
 *   extension has, and it is SYNCHRONOUS. The model call therefore cannot
 *   happen inside it: prediction is generated asynchronously on `agent_end`,
 *   cached, and merely handed over when the editor next renders.
 * - The editor renders the hint only when the cursor sits at the end of its
 *   visual line and clamps it to the remaining width, so predictions are
 *   forced to a single short line. Multi-line suggestions would be silently
 *   truncated.
 * - The core editor treats the inline hint as display-only — its Tab path runs
 *   slash/file completion and never accepts the hint. Acceptance is therefore
 *   implemented here by consuming Tab through `ctx.ui.onTerminalInput()`, which
 *   the TUI dispatches before the focused component. To guarantee it can never
 *   shadow real completion, the ghost (and thus the Tab steal) is suppressed
 *   whenever the buffer contains `/` or `@`, the two triggers for slash-command
 *   and file/@-mention completion.
 *
 * Escape clears the prediction (without consuming the key, so Escape keeps its
 * normal meaning). A new turn, a submitted message, or a session switch
 * discards it too, and any in-flight request is aborted.
 *
 * Model: the `@smol` role, falling back to the session model. One request per
 * settle, ~64 output tokens, reasoning disabled, aborted on the next turn — so
 * it costs about as much as automatic session titling.
 *
 * Usage:
 *   omp --extension examples/extensions/predictive-input.ts
 *   # or: cp predictive-input.ts ~/.omp/agent/extensions/
 *
 *   /predict          toggle on/off for this session
 *   /predict status   show state and the current prediction
 *   OMP_PREDICT_INPUT=0   start disabled
 */
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type AutocompleteItem, type AutocompleteProvider, matchesKey } from "@oh-my-pi/pi-tui";

/** Conversation turns handed to the predictor. Older context adds tokens without changing the guess. */
const HISTORY_MESSAGES = 8;
/** Per-message character cap. A long agent reply predicts no better than its opening. */
const MESSAGE_CHARS = 900;
/** Output ceiling. The task is one short line; the ceiling only guards a backend that ignores disableReasoning. */
const MAX_TOKENS = 96;
/** Longest prediction we will show. Beyond this the ghost is truncated by the editor anyway. */
const PREDICTION_CHARS = 110;
/** Settle-to-request delay. Swallows the burst of events around the end of a turn. */
const DEBOUNCE_MS = 300;
/** Sentinel the model returns when nothing is worth predicting. */
const DECLINE = "NONE";

const SYSTEM_PROMPT = [
	"You predict the next message a developer will type to their coding agent.",
	"",
	"You are given the recent conversation. Output the single most likely next user message and nothing else:",
	"no quotes, no preamble, no explanation, no markdown.",
	"",
	"Rules:",
	"- One line, at most 100 characters, phrased exactly as the user would type it (imperative, lowercase is fine).",
	"- Predict the obvious next step: run/verify what was just built, fix a problem the agent just reported,",
	"  commit finished work, or ask about the specific thing left unresolved.",
	"- Reference concrete names from the conversation (files, commands, symbols) when they make the guess sharper.",
	`- If the conversation gives no confident next step, output exactly ${DECLINE}.`,
].join("\n");

interface SessionEntryLike {
	type: string;
	message?: { role?: unknown; content?: unknown };
}

interface HistoryTurn {
	role: "user" | "assistant";
	text: string;
}

export default function (pi: ExtensionAPI): void {
	let enabled = process.env.OMP_PREDICT_INPUT !== "0";
	let prediction: string | null = null;
	let inflight: AbortController | null = null;
	let debounce: ReturnType<typeof setTimeout> | undefined;
	/** Bumped by every invalidation so a late response cannot resurrect a stale prediction. */
	let epoch = 0;
	let wired = false;

	// ---------------------------------------------------------------- lifecycle

	function invalidate(ctx?: ExtensionContext): void {
		epoch++;
		if (debounce) {
			clearTimeout(debounce);
			debounce = undefined;
		}
		inflight?.abort();
		inflight = null;
		if (prediction !== null) {
			prediction = null;
			requestRepaint(ctx);
		}
	}

	/**
	 * Force a repaint so a prediction that arrived between renders becomes
	 * visible immediately. Extensions get no direct `requestRender()`, and
	 * `setStatus` is the cheapest hook that calls it; writing `undefined` under
	 * a private key repaints without occupying a footer slot.
	 */
	function requestRepaint(ctx?: ExtensionContext): void {
		ctx?.ui.setStatus("predictive-input:repaint", undefined);
	}

	// ------------------------------------------------------------------ history

	function readHistory(ctx: ExtensionContext): HistoryTurn[] {
		const entries = ctx.sessionManager.getBranch() as unknown as SessionEntryLike[];
		const turns: HistoryTurn[] = [];
		for (const entry of entries) {
			if (entry.type !== "message" || !entry.message) continue;
			const role = entry.message.role;
			if (role !== "user" && role !== "assistant") continue;
			const text = extractText(entry.message.content).trim();
			if (!text) continue;
			turns.push({ role, text });
		}
		return turns.slice(-HISTORY_MESSAGES);
	}

	/** Text blocks only. Thinking and tool calls are dropped: the user never saw them. */
	function extractText(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		const parts: string[] = [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const candidate = block as { type?: unknown; text?: unknown };
			if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text);
		}
		return parts.join("\n");
	}

	function renderHistory(turns: HistoryTurn[]): string {
		const lines: string[] = [];
		for (const turn of turns) {
			const label = turn.role === "user" ? "USER" : "AGENT";
			const text = turn.text.length > MESSAGE_CHARS ? `${turn.text.slice(0, MESSAGE_CHARS)}…` : turn.text;
			lines.push(`${label}: ${text}`);
		}
		lines.push("", "Predict the next USER message.");
		return lines.join("\n\n");
	}

	// ---------------------------------------------------------------- predictor

	/**
	 * Reduce a model reply to one showable line, or null. Models wrap the answer
	 * in quotes, prefix it with a label, or answer in prose despite the prompt;
	 * anything that survives this is safe to paint as ghost text.
	 */
	function normalize(raw: string): string | null {
		let text = raw.trim();
		if (!text) return null;
		text = text.split("\n").find(line => line.trim().length > 0) ?? "";
		text = text.trim().replace(/^(?:next\s+message|prediction|user)\s*:\s*/i, "");
		text = text
			.replace(/^["'`]+/, "")
			.replace(/["'`]+$/, "")
			.trim();
		if (!text || text.toUpperCase() === DECLINE) return null;
		// A refusal or a meta-answer is worse than no ghost at all.
		if (/^(?:i\b|sorry\b|as an\b)/i.test(text)) return null;
		if (text.length > PREDICTION_CHARS) return null;
		return text;
	}

	async function predict(ctx: ExtensionContext): Promise<void> {
		const turns = readHistory(ctx);
		// Nothing the agent said yet means nothing to follow up on.
		if (!turns.some(turn => turn.role === "assistant")) return;

		const model = ctx.models.resolve("@smol") ?? ctx.models.current();
		if (!model) return;

		const sessionId = ctx.sessionManager.getSessionId();
		const apiKey = await ctx.modelRegistry.getApiKey(model, sessionId);
		if (!apiKey) return;

		const controller = new AbortController();
		inflight = controller;
		const requestEpoch = epoch;

		try {
			const response = await completeSimple(
				model,
				{
					systemPrompt: [SYSTEM_PROMPT],
					messages: [{ role: "user", content: renderHistory(turns), timestamp: Date.now() }],
				},
				{
					apiKey: ctx.modelRegistry.resolver(model, sessionId),
					maxTokens: MAX_TOKENS,
					disableReasoning: true,
					signal: controller.signal,
				},
			);
			if (requestEpoch !== epoch || controller.signal.aborted) return;
			if (response.stopReason === "error") return;

			const text = normalize(response.content.map(block => (block.type === "text" ? block.text : "")).join(""));
			if (!text) return;
			prediction = text;
			requestRepaint(ctx);
		} catch {
			// A failed or aborted prediction is a non-event: no ghost, no message.
		} finally {
			if (inflight === controller) inflight = null;
		}
	}

	function schedule(ctx: ExtensionContext): void {
		if (!enabled) return;
		invalidate(ctx);
		const scheduledEpoch = epoch;
		debounce = setTimeout(() => {
			debounce = undefined;
			if (!enabled || scheduledEpoch !== epoch) return;
			void predict(ctx);
		}, DEBOUNCE_MS);
	}

	// -------------------------------------------------------------------- ghost

	/**
	 * The ghost tail for the current buffer, or null when no ghost should show.
	 *
	 * Suppressed on multi-line buffers (the editor can only draw a hint on the
	 * cursor's own line) and on any buffer containing `/` or `@`, so Tab always
	 * belongs to slash-command and file completion there.
	 */
	function ghostFor(lines: string[], cursorLine: number, cursorCol: number): string | null {
		if (!enabled || !prediction) return null;
		if (lines.length !== 1) return null;
		const line = lines[0] ?? "";
		if (cursorLine !== 0 || cursorCol !== line.length) return null;
		if (line.trim().length === 0) return prediction;
		if (line.includes("/") || line.includes("@")) return null;
		if (line.length >= prediction.length) return null;
		if (!prediction.toLowerCase().startsWith(line.toLowerCase())) return null;
		return prediction.slice(line.length);
	}

	/**
	 * Delegate every member explicitly. The base provider is a class instance,
	 * so spreading it would drop its prototype methods, and the editor
	 * feature-detects the optional ones — they must stay absent when the base
	 * lacks them.
	 */
	function wrapProvider(current: AutocompleteProvider): AutocompleteProvider {
		const wrapped: AutocompleteProvider = {
			getSuggestions: (lines, cursorLine, cursorCol) => current.getSuggestions(lines, cursorLine, cursorCol),
			applyCompletion: (
				lines: string[],
				cursorLine: number,
				cursorCol: number,
				item: AutocompleteItem,
				prefix: string,
			) => current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
			// A real completion hint (slash argument usage, etc.) outranks a prediction.
			getInlineHint: (lines, cursorLine, cursorCol) =>
				current.getInlineHint?.(lines, cursorLine, cursorCol) ?? ghostFor(lines, cursorLine, cursorCol),
		};
		if (current.trySyncSlashCompletion) {
			wrapped.trySyncSlashCompletion = text => current.trySyncSlashCompletion?.(text) ?? null;
		}
		if (current.trySyncInlineReplace) {
			wrapped.trySyncInlineReplace = text => current.trySyncInlineReplace?.(text) ?? null;
		}
		if (current.getForceFileSuggestions) {
			wrapped.getForceFileSuggestions = (lines, cursorLine, cursorCol) =>
				current.getForceFileSuggestions?.(lines, cursorLine, cursorCol) ?? Promise.resolve(null);
		}
		if (current.shouldTriggerFileCompletion) {
			wrapped.shouldTriggerFileCompletion = (lines, cursorLine, cursorCol) =>
				current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
		}
		return wrapped;
	}

	// ------------------------------------------------------------------- wiring

	function wire(ctx: ExtensionContext): void {
		if (wired || !ctx.hasUI) return;
		wired = true;

		ctx.ui.addAutocompleteProvider(wrapProvider);

		ctx.ui.onTerminalInput(data => {
			if (!enabled || !prediction) return undefined;
			if (matchesKey(data, "escape")) {
				// Clear but do not consume: Escape keeps its normal meaning.
				invalidate(ctx);
				return undefined;
			}
			if (!matchesKey(data, "tab")) return undefined;
			const text = ctx.ui.getEditorText();
			// Mirror the render guard exactly, so Tab is only stolen while a
			// ghost is actually on screen.
			const lines = text.split("\n");
			if (ghostFor(lines, 0, lines[0]?.length ?? 0) === null) return undefined;
			const accepted = prediction;
			invalidate(ctx);
			ctx.ui.setEditorText(accepted);
			return { consume: true };
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		wire(ctx);
		invalidate(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => invalidate(ctx));
	pi.on("before_agent_start", async (_event, ctx) => invalidate(ctx));
	pi.on("input", async (_event, ctx) => invalidate(ctx));

	pi.on("agent_end", async (event, ctx) => {
		// `willContinue` marks an auto-retry/continuation, not a user-visible settle.
		if (event.willContinue) return;
		schedule(ctx);
	});

	pi.on("session_shutdown", async () => invalidate());

	pi.registerCommand("predict", {
		description: "Toggle predictive next-message ghost text",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "status") {
				ctx.ui.notify(
					`predictive input ${enabled ? "on" : "off"}${prediction ? ` · “${prediction}”` : " · no prediction"}`,
					"info",
				);
				return;
			}
			if (arg === "on") enabled = true;
			else if (arg === "off") enabled = false;
			else enabled = !enabled;
			invalidate(ctx);
			ctx.ui.notify(`predictive input ${enabled ? "on" : "off"}`, "info");
		},
	});
}
