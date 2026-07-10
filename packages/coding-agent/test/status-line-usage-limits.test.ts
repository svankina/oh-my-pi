import { beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import {
	projectUsageLimits,
	usageSelectionKey,
} from "@oh-my-pi/pi-coding-agent/modes/components/status-line/usage-limits";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { stripVTControlCharacters } from "node:util";

const IDENTITY = { accountId: "account-a", email: "a@example.com" };
const SELECTION = { provider: "openai-codex", modelId: "gpt-5.6", identity: IDENTITY };

function limit(
	id: string,
	label: string,
	usedFraction: number,
	overrides: Partial<UsageLimit> = {},
): UsageLimit {
	return {
		id,
		label,
		scope: { provider: "openai-codex", accountId: "account-a" },
		window: { id, label, resetsAt: Date.now() + 3_600_000 },
		amount: { unit: "percent", usedFraction },
		...overrides,
	};
}

function report(provider: string, accountId: string, limits: UsageLimit[]): UsageReport {
	return { provider, fetchedAt: Date.now(), metadata: { accountId }, limits };
}

describe("projectUsageLimits", () => {
	it("keeps only the selected provider, active account, and applicable model scopes", () => {
		const reports = [
			report("anthropic", "account-a", [limit("claude-5h", "5h", 0.91)]),
			report("openai-codex", "account-b", [
				limit("other-account", "5h", 0.82, {
					scope: { provider: "openai-codex", accountId: "account-b" },
				}),
			]),
			report("openai-codex", "account-a", [
				limit("shared", "5h", 0.42),
				limit("selected-model", "Daily", 0.18, {
					scope: { provider: "openai-codex", accountId: "account-a", modelId: "gpt-5.6" },
				}),
				limit("other-model", "Monthly", 0.77, {
					scope: { provider: "openai-codex", accountId: "account-a", modelId: "gpt-5.5" },
				}),
			]),
		];

		expect(projectUsageLimits(reports, SELECTION).map(item => [item.id, item.usedFraction])).toEqual([
			["shared", 0.42],
			["selected-model", 0.18],
		]);
	});

	it("keeps limits whose scope matches the active account when report metadata differs", () => {
		const reports = [
			report("openai-codex", "account-a", [
				limit("merged-account-b", "Daily", 0.31, {
					scope: { provider: "openai-codex", accountId: "account-b" },
				}),
			]),
		];
		const selection = { ...SELECTION, identity: { accountId: "account-b" } };

		expect(projectUsageLimits(reports, selection).map(item => item.id)).toEqual(["merged-account-b"]);
	});

	it("deduplicates stable IDs and resolves non-explicit fractions", () => {
		const tokenLimit = limit("monthly", "Monthly", 0, {
			amount: { unit: "tokens", used: 250, limit: 1000 },
		});
		const reports = [report("openai-codex", "account-a", [tokenLimit, tokenLimit])];
		expect(projectUsageLimits(reports, SELECTION)).toEqual([
			expect.objectContaining({ id: "monthly", label: "Monthly", usedFraction: 0.25 }),
		]);
	});

	it("disambiguates duplicate labels with tier qualifiers", () => {
		const reports = [report("openai-codex", "account-a", [
			limit("pro", "Requests", 0.72, {
				scope: { provider: "openai-codex", accountId: "account-a", tier: "Pro" },
			}),
			limit("standard", "Requests", 0.14, {
				scope: { provider: "openai-codex", accountId: "account-a", tier: "Standard" },
			}),
		])];
		expect(projectUsageLimits(reports, SELECTION).map(item => item.label)).toEqual([
			"Requests (Pro)",
			"Requests (Standard)",
		]);
	});

	it("returns no limits for unverifiable account data", () => {
		const unscoped = limit("5h", "5h", 0.4, { scope: { provider: "openai-codex" } });
		const reports = [{ provider: "openai-codex", fetchedAt: Date.now(), limits: [unscoped] }];
		expect(projectUsageLimits(reports, SELECTION)).toEqual([]);
	});

	it("keys provider, model, and normalized identity", () => {
		expect(usageSelectionKey(SELECTION)).not.toBe(
			usageSelectionKey({ ...SELECTION, identity: { accountId: "account-b" } }),
		);
		expect(usageSelectionKey(SELECTION)).toBe(
			usageSelectionKey({ ...SELECTION, identity: { accountId: " ACCOUNT-A ", email: "A@EXAMPLE.COM" } }),
		);
	});

	it("matches real Codex Spark model scope casing", () => {
		const selection = { ...SELECTION, modelId: "gpt-5.3-codex-spark" };
		const reports = [
			report("openai-codex", "account-a", [
				limit("spark", "Spark", 0.37, {
					scope: {
						provider: "openai-codex",
						accountId: "account-a",
						modelId: "GPT-5.3-Codex-Spark",
					},
				}),
			]),
		];

		expect(projectUsageLimits(reports, selection).map(item => item.id)).toEqual(["spark"]);
	});

	it("skips malformed runtime entries and continues projecting later valid limits", () => {
		const reports = [
			null,
			{ provider: "openai-codex" },
			{ provider: 42, limits: [] },
			{
				provider: "openai-codex",
				fetchedAt: Date.now(),
				metadata: { accountId: "account-a" },
				limits: [
					null,
					{
						id: 42,
						label: "Bad ID",
						scope: { provider: "openai-codex", accountId: "account-a" },
						amount: { unit: "percent", usedFraction: 0.1 },
					},
					{
						id: "bad-label",
						label: 42,
						scope: { provider: "openai-codex", accountId: "account-a" },
						amount: { unit: "percent", usedFraction: 0.2 },
					},
					{
						id: "bad-scope",
						label: "Bad scope",
						scope: null,
						amount: { unit: "percent", usedFraction: 0.3 },
					},
					{
						id: "bad-amount",
						label: "Bad amount",
						scope: { provider: "openai-codex", accountId: "account-a" },
						amount: null,
					},
					{
						id: "non-finite-fraction",
						label: "Non-finite",
						scope: { provider: "openai-codex", accountId: "account-a" },
						amount: { unit: "percent", usedFraction: Number.POSITIVE_INFINITY },
					},
					{
						id: "bad-reset",
						label: "Fallback label",
						scope: { provider: "openai-codex", accountId: "account-a" },
						window: {
							id: "bad-reset",
							label: "Window label",
							resetsAt: Number.POSITIVE_INFINITY,
						},
						amount: { unit: "percent", usedFraction: 0.4 },
					},
					limit("valid", "Valid", 0.5),
				],
			},
		] as unknown as UsageReport[];

		expect(projectUsageLimits(reports, SELECTION)).toEqual([
			{
				id: "bad-reset",
				label: "Window label",
				usedFraction: 0.4,
				tier: undefined,
				modelId: undefined,
			},
			expect.objectContaining({ id: "valid", label: "Valid", usedFraction: 0.5 }),
		]);
	});

});

beforeAll(async () => {
	await initTheme();
});

it("renders arbitrary normalized windows and clamps over-limit usage", () => {
	const ctx = {
		usage: [
			{ id: "daily", label: "Daily", usedFraction: 0.18 },
			{ id: "monthly", label: "Monthly", usedFraction: 0.54 },
			{ id: "burst", label: "Burst", usedFraction: 1.2 },
		],
	} as unknown as SegmentContext;

	const text = stripVTControlCharacters(renderSegment("usage", ctx).content);
	expect(text).toContain("Daily 18%");
	expect(text).toContain("Monthly 54%");
	expect(text).toContain("Burst 100%");
	expect(text).not.toContain("5h");
	expect(text).not.toContain("7d");
});

it("formats reset countdowns below an hour and at day/hour boundaries", () => {
	const now = new Date("2026-01-02T03:04:05.000Z");
	setSystemTime(now);
	try {
		const ctx = {
			usage: [
				{ id: "short", label: "Short", usedFraction: 0.18, resetsAt: now.getTime() + 45 * 60_000 },
				{ id: "one-day", label: "One day", usedFraction: 0.54, resetsAt: now.getTime() + 24 * 3_600_000 },
				{
					id: "multi-day",
					label: "Multi-day",
					usedFraction: 0.72,
					resetsAt: now.getTime() + 51 * 3_600_000,
				},
			],
		} as unknown as SegmentContext;

		const text = stripVTControlCharacters(renderSegment("usage", ctx).content);
		expect(text).toContain("Short 18% (45m)");
		expect(text).toContain("One day 54% (1d)");
		expect(text).toContain("Multi-day 72% (2d 3h)");
	} finally {
		setSystemTime();
	}
});

it("sanitizes ANSI and control characters in usage labels", () => {
	const ctx = {
		usage: [{ id: "unsafe", label: "\u001b[31mDanger\u001b[0m\nNext\u0007", usedFraction: 0.42 }],
	} as unknown as SegmentContext;

	const text = stripVTControlCharacters(renderSegment("usage", ctx).content);
	expect(text).toContain("Danger Next 42%");
	expect(text).not.toContain("\n");
	expect(text).not.toContain("\u0007");
});
