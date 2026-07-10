import { beforeAll, describe, expect, it } from "bun:test";
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
			report("openai-codex", "account-b", [limit("other-account", "5h", 0.82)]),
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
});

beforeAll(async () => {
	await initTheme();
});

it("renders arbitrary normalized windows and reset countdowns", () => {
	const ctx = {
		usage: [
			{ id: "daily", label: "Daily", usedFraction: 0.18, resetsAt: Date.now() + 60 * 60_000 },
			{ id: "monthly", label: "Monthly", usedFraction: 0.54 },
			{ id: "burst", label: "Burst", usedFraction: 1.2 },
		],
	} as unknown as SegmentContext;

	const text = stripVTControlCharacters(renderSegment("usage", ctx).content);
	expect(text).toContain("Daily 18% (1h)");
	expect(text).toContain("Monthly 54%");
	expect(text).toContain("Burst 100%");
	expect(text).not.toContain("5h");
	expect(text).not.toContain("7d");
});
