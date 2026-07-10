import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

interface MutableUsageSession {
	session: AgentSession;
	setModel(provider: string, id: string): void;
	setIdentity(identity: { accountId?: string; email?: string; projectId?: string } | undefined): void;
}

function makeSession(fetchUsageReports: (signal?: AbortSignal) => Promise<UsageReport[] | null>): MutableUsageSession {
	const messages: unknown[] = [];
	const state: { messages: unknown[]; model: { provider: string; id: string; contextWindow: number } } = {
		messages,
		model: { provider: "anthropic", id: "claude-opus", contextWindow: 200_000 },
	};
	let identity: { accountId?: string; email?: string; projectId?: string } | undefined = {
		accountId: "anthropic-a",
	};
	const session = {
		fetchUsageReports,
		messages,
		state,
		get model() {
			return state.model;
		},
		sessionId: "status-line-test",
		modelRegistry: {
			isUsingOAuth: () => identity !== undefined,
			authStorage: { getOAuthAccountIdentity: () => identity },
		},
		isStreaming: false,
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => "test",
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		getContextUsage: () => undefined,
		contextUsageRevision: 0,
	} as unknown as AgentSession;
	return {
		session,
		setModel(provider, id) {
			state.model = { provider, id, contextWindow: 200_000 };
		},
		setIdentity(next) {
			identity = next;
		},
	};
}

function usageReport(provider: string, accountId: string, label: string, percent: number): UsageReport[] {
	return [
		{
			provider,
			fetchedAt: Date.now(),
			metadata: { accountId },
			limits: [
				{
					id: `${provider}:${accountId}:${label}`,
					label,
					scope: { provider, accountId, windowId: label },
					window: { id: label, label, resetsAt: Date.now() + 60_000 },
					amount: { unit: "percent", usedFraction: percent / 100 },
				},
			],
		},
	];
}

function plain(text: string): string {
	return stripVTControlCharacters(text);
}

describe("StatusLineComponent usage refresh", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		resetSettingsForTest();
	});

	it("does not invoke usage fetching synchronously on the render path", async () => {
		let calls = 0;
		const component = new StatusLineComponent(
			makeSession(async () => {
				calls++;
				return [];
			}).session,
		);

		component.refreshUsageInBackground();
		expect(calls).toBe(0);

		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(calls).toBe(1);
	});

	it("passes a startup timeout signal to the background usage fetch", async () => {
		let signal: AbortSignal | undefined;
		const component = new StatusLineComponent(
			makeSession(async nextSignal => {
				signal = nextSignal;
				return [];
			}).session,
		);

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(signal).toBeInstanceOf(AbortSignal);
	});

	it("backs off after the startup timeout when usage fetching hangs", async () => {
		let calls = 0;
		const component = new StatusLineComponent(
			makeSession(() => {
				calls++;
				return Promise.withResolvers<UsageReport[] | null>().promise;
			}).session,
		);

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		component.refreshUsageInBackground();
		expect(calls).toBe(1);

		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(calls).toBe(1);
	});

	it("applies late usage reports that resolve after the startup timeout", async () => {
		const late = Promise.withResolvers<UsageReport[] | null>();
		const component = new StatusLineComponent(makeSession(() => late.promise).session);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();

		expect(plain(component.getTopBorder(80).content)).not.toContain("5h");

		late.resolve(usageReport("anthropic", "anthropic-a", "5h", 42));
		await flushMicrotasks();

		expect(plain(component.getTopBorder(80).content)).toContain("5h 42%");
	});

	it("clears and refreshes limits when the selected model changes", async () => {
		let calls = 0;
		const harness = makeSession(async () => {
			calls++;
			return calls === 1
				? usageReport("anthropic", "anthropic-a", "5h", 42)
				: usageReport("openai-codex", "codex-a", "Weekly", 17);
		});
		const component = new StatusLineComponent(harness.session);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(plain(component.getTopBorder(80).content)).toContain("5h 42%");

		harness.setModel("openai-codex", "gpt-5.6");
		harness.setIdentity({ accountId: "codex-a" });
		expect(plain(component.getTopBorder(80).content)).not.toContain("5h 42%");

		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(2);
		expect(plain(component.getTopBorder(80).content)).toContain("Weekly 17%");
	});

	it("discards a late result after the active subscription account changes", async () => {
		const accountA = Promise.withResolvers<UsageReport[] | null>();
		const accountB = Promise.withResolvers<UsageReport[] | null>();
		let calls = 0;
		const harness = makeSession(() => (++calls === 1 ? accountA.promise : accountB.promise));
		const component = new StatusLineComponent(harness.session);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		harness.setIdentity({ accountId: "anthropic-b" });
		expect(plain(component.getTopBorder(80).content)).not.toContain("Account A");
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(2);

		accountB.resolve(usageReport("anthropic", "anthropic-b", "Account B", 22));
		await flushMicrotasks();
		expect(plain(component.getTopBorder(80).content)).toContain("Account B 22%");

		accountA.resolve(usageReport("anthropic", "anthropic-a", "Account A", 88));
		await flushMicrotasks();
		const text = plain(component.getTopBorder(80).content);
		expect(text).toContain("Account B 22%");
		expect(text).not.toContain("Account A");
	});

	it("does not fetch or render limits without an active OAuth identity", async () => {
		let calls = 0;
		const harness = makeSession(async () => {
			calls++;
			return usageReport("anthropic", "anthropic-a", "5h", 42);
		});
		harness.setIdentity(undefined);
		const component = new StatusLineComponent(harness.session);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(0);
		expect(plain(component.getTopBorder(80).content)).not.toContain("%");
	});
});
