import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

function makeComponent(reports: UsageReport[]): StatusLineComponent {
	const model = { id: "gpt-5.3-codex-spark", contextWindow: 1000, provider: "openai-codex" };
	const component = new StatusLineComponent({
		state: { messages: [], model },
		model,
		sessionId: "status-line-usage-test",
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		fetchUsageReports: async () => reports,
		modelRegistry: {
			authStorage: {
				getSessionOAuthAccountIdentity: (provider: string, sessionId: string) =>
					provider === "openai-codex" && sessionId === "status-line-usage-test"
						? { accountId: "active-account" }
						: undefined,
			},
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		getContextUsage: () => undefined,
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0]);
	component.updateSettings({
		preset: "custom",
		leftSegments: [],
		rightSegments: ["usage"],
		sessionAccent: false,
	});
	return component;
}

async function flushUsageRefresh(): Promise<void> {
	vi.advanceTimersByTime(0);
	await Promise.resolve();
	await Promise.resolve();
}

describe("usage status-line segment", () => {
	it("renders generic five-hour and seven-day limits", () => {
		const now = Date.now();
		const result = renderSegment("usage", {
			usage: [
				{ id: "5h", label: "5h", usedFraction: 0.24, resetsAt: now + 30 * 60_000 },
				{ id: "7d", label: "7d", usedFraction: 0.08, resetsAt: now + 141 * 3_600_000 },
			],
		} as unknown as SegmentContext);
		const content = stripVTControlCharacters(result.content);

		expect(result.visible).toBe(true);
		expect(content).toContain("5h 24% (30m)");
		expect(content).toContain("7d 8% (5d 21h)");
	});

	it("renders one shared subscription tier label", () => {
		const result = renderSegment("usage", {
			usage: [
				{ id: "5h", label: "5h", usedFraction: 0.5, tier: "prolite" },
				{ id: "7d", label: "7d", usedFraction: 0.1, tier: "prolite" },
			],
		} as unknown as SegmentContext);
		const content = stripVTControlCharacters(result.content);

		expect(result.visible).toBe(true);
		expect(content.match(/prolite/g)).toHaveLength(1);
		expect(content).toContain("5h 50%");
		expect(content).toContain("7d 10%");
	});

	it("sanitizes a shared tier label before rendering", () => {
		const result = renderSegment("usage", {
			usage: [{ id: "5h", label: "5h", usedFraction: 0.5, tier: "\u001b[31mbad\t tier\nvalue\u001b[0m" }],
		} as unknown as SegmentContext);
		const content = stripVTControlCharacters(result.content);

		expect(content).toContain("bad tier value");
		expect(result.content).not.toContain("\u001b[31m");
		expect(result.content).not.toContain("\t");
		expect(result.content).not.toContain("\n");
	});

	it("renders only normalized limits for the routed account", async () => {
		vi.useFakeTimers();
		try {
			const reports: UsageReport[] = [
				{
					provider: "openai-codex",
					fetchedAt: Date.now(),
					metadata: { accountId: "other-account" },
					limits: [
						{
							id: "other:5h",
							label: "5h",
							scope: { provider: "openai-codex", accountId: "other-account", windowId: "5h" },
							amount: { unit: "percent", usedFraction: 0.99 },
						},
					],
				},
				{
					provider: "openai-codex",
					fetchedAt: Date.now(),
					metadata: { accountId: "active-account" },
					limits: [
						{
							id: "active:5h",
							label: "5h",
							scope: {
								provider: "openai-codex",
								accountId: "active-account",
								windowId: "5h",
								tier: "prolite",
							},
							window: { id: "5h", label: "5h" },
							amount: { unit: "percent", usedFraction: 0.24 },
						},
						{
							id: "active:7d",
							label: "7d",
							scope: {
								provider: "openai-codex",
								accountId: "active-account",
								windowId: "7d",
								tier: "prolite",
							},
							window: { id: "7d", label: "7d" },
							amount: { unit: "percent", usedFraction: 0.08 },
						},
					],
				},
			];
			const component = makeComponent(reports);

			component.refreshUsageInBackground();
			await flushUsageRefresh();
			const content = stripVTControlCharacters(component.getTopBorder(200).content);

			expect(content).toContain("prolite");
			expect(content).toContain("5h 24%");
			expect(content).toContain("7d 8%");
			expect(content).not.toContain("99%");
		} finally {
			vi.useRealTimers();
		}
	});

	it("hides an empty usage list", () => {
		const result = renderSegment("usage", { usage: [] } as unknown as SegmentContext);
		expect(result).toEqual({ content: "", visible: false });
	});

	it("renders one limit without inventing other windows", () => {
		const result = renderSegment("usage", {
			usage: [{ id: "5h", label: "5h", usedFraction: 0.8 }],
		} as unknown as SegmentContext);
		const content = stripVTControlCharacters(result.content);

		expect(result.visible).toBe(true);
		expect(content).toContain("5h 80%");
		expect(content).not.toContain("7d");
	});

	it("uses a distinct error color at the eighty-percent threshold", () => {
		const high = renderSegment("usage", {
			usage: [{ id: "high", label: "5h", usedFraction: 0.8 }],
		} as unknown as SegmentContext);
		const low = renderSegment("usage", {
			usage: [{ id: "low", label: "5h", usedFraction: 0.24 }],
		} as unknown as SegmentContext);
		const highWithoutValue = high.content.replace("80%", "PCT");
		const lowWithoutValue = low.content.replace("24%", "PCT");

		expect(stripVTControlCharacters(highWithoutValue)).toBe(stripVTControlCharacters(lowWithoutValue));
		expect(highWithoutValue).not.toBe(lowWithoutValue);
	});
});
