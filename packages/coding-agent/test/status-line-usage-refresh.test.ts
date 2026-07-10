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
	readonly identityLookups: Array<readonly [provider: string, sessionId: string | undefined]>;
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
	const identityLookups: Array<readonly [provider: string, sessionId: string | undefined]> = [];
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
			authStorage: {
				getOAuthAccountIdentity: (provider: string, sessionId?: string) => {
					identityLookups.push([provider, sessionId]);
					return identity;
				},
			},
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
		identityLookups,
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
function installUsageClock(): { advanceBy(ms: number): void } {
	let now = Date.now();
	vi.spyOn(Date, "now").mockImplementation(() => now);
	return {
		advanceBy(ms: number) {
			now += ms;
		},
	};
}


describe("StatusLineComponent usage refresh", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.restoreAllMocks();
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
	it("looks up the active identity with the selected provider and session ID", async () => {
		const harness = makeSession(async () => []);
		harness.setModel("openai-codex", "gpt-5.6");
		harness.setIdentity({ accountId: "codex-a" });
		const component = new StatusLineComponent(harness.session);

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(harness.identityLookups.length).toBeGreaterThan(0);
		expect(
			harness.identityLookups.every(
				([provider, sessionId]) => provider === "openai-codex" && sessionId === "status-line-test",
			),
		).toBe(true);
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

	it("clears and refreshes limits when the model changes for the same provider and account", async () => {
		let calls = 0;
		const harness = makeSession(async () => {
			calls++;
			return calls === 1
				? usageReport("anthropic", "anthropic-a", "Model A", 42)
				: usageReport("anthropic", "anthropic-a", "Model B", 17);
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
		expect(plain(component.getTopBorder(80).content)).toContain("Model A 42%");

		harness.setModel("anthropic", "claude-sonnet");
		expect(plain(component.getTopBorder(80).content)).not.toContain("Model A 42%");

		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(2);
		expect(plain(component.getTopBorder(80).content)).toContain("Model B 17%");
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
	it("keeps A2 ownership when A1 settles after an A to B to A transition", async () => {
		const clock = installUsageClock();
		const requests = Array.from({ length: 4 }, () => Promise.withResolvers<UsageReport[] | null>());
		let calls = 0;
		const harness = makeSession(() => requests[calls++]!.promise);
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
		component.getTopBorder(80);
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		harness.setIdentity({ accountId: "anthropic-a" });
		component.getTopBorder(80);
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(3);

		requests[0]!.resolve(usageReport("anthropic", "anthropic-a", "Stale A1", 88));
		await flushMicrotasks();
		expect(plain(component.getTopBorder(80).content)).not.toContain("Stale A1");

		clock.advanceBy(5 * 60_000 + 1);
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(3);

		requests[2]!.resolve(usageReport("anthropic", "anthropic-a", "Current A2", 22));
		requests[1]!.resolve(usageReport("anthropic", "anthropic-b", "Stale B1", 44));
		requests[3]!.resolve([]);
		await flushMicrotasks();
		expect(plain(component.getTopBorder(80).content)).toContain("Current A2 22%");
	});

	it("keeps A2 cache and TTL when A1 settles after A2 succeeds", async () => {
		const clock = installUsageClock();
		const requests = Array.from({ length: 4 }, () => Promise.withResolvers<UsageReport[] | null>());
		let calls = 0;
		const harness = makeSession(() => requests[calls++]!.promise);
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
		component.getTopBorder(80);
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		harness.setIdentity({ accountId: "anthropic-a" });
		component.getTopBorder(80);
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(3);

		requests[2]!.resolve(usageReport("anthropic", "anthropic-a", "Current A2", 22));
		await flushMicrotasks();
		expect(plain(component.getTopBorder(80).content)).toContain("Current A2 22%");

		clock.advanceBy(4 * 60_000);
		requests[0]!.resolve(usageReport("anthropic", "anthropic-a", "Stale A1", 88));
		await flushMicrotasks();
		const afterA1 = plain(component.getTopBorder(80).content);
		expect(afterA1).toContain("Current A2 22%");
		expect(afterA1).not.toContain("Stale A1");

		clock.advanceBy(60_001);
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(4);

		requests[1]!.resolve(usageReport("anthropic", "anthropic-b", "Stale B1", 44));
		requests[3]!.resolve([]);
		await flushMicrotasks();
	});

	it("discards timed-out A1 after a newer same-key A2 refresh", async () => {
		const clock = installUsageClock();
		const requests = Array.from({ length: 3 }, () => Promise.withResolvers<UsageReport[] | null>());
		let calls = 0;
		const harness = makeSession(() => requests[calls++]!.promise);
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
		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();

		clock.advanceBy(5 * 60_000 + 1);
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(2);

		requests[1]!.resolve(usageReport("anthropic", "anthropic-a", "Current A2", 22));
		await flushMicrotasks();
		expect(plain(component.getTopBorder(80).content)).toContain("Current A2 22%");

		clock.advanceBy(4 * 60_000);
		requests[0]!.resolve(usageReport("anthropic", "anthropic-a", "Timed-out A1", 88));
		await flushMicrotasks();
		const afterA1 = plain(component.getTopBorder(80).content);
		expect(afterA1).toContain("Current A2 22%");
		expect(afterA1).not.toContain("Timed-out A1");

		clock.advanceBy(60_001);
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(3);

		requests[2]!.resolve([]);
		await flushMicrotasks();
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
