# Dynamic Footer Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the omp status-line usage segment show live limits for the selected model and its active OAuth subscription account, with correct invalidation on model or credential changes.

**Architecture:** Add a pure provider-independent projection module that converts normalized `UsageReport` values into compact footer limits for one provider/model/account selection. `StatusLineComponent` owns the selection-keyed asynchronous cache; `segments.ts` only formats the projected list. Existing account matching, usage-fraction normalization, fetch timeout, and late-response behavior remain authoritative.

**Tech Stack:** TypeScript 6, Bun test, `@oh-my-pi/pi-ai` normalized usage types, private class fields, existing pi-tui status-line renderer.

## Global Constraints

- Show limits only for the selected model's provider.
- Show limits only for the session-sticky OAuth account currently serving requests.
- Include account-wide/provider-wide limits and limits scoped to the selected model.
- Do not aggregate multiple accounts or show usage for API-key credentials.
- Support arbitrary normalized window labels; do not hard-code Claude/Codex/Gemini provider branches.
- Clear stale limits immediately when provider, model, or active account changes.
- Preserve the zero-delay deferred fetch, two-second timeout signal, late-success handling, five-minute TTL, and disposal guards.
- Do not change built-in preset membership, `/usage`, provider fetchers, credential rotation, or legacy `FooterComponent`.
- Production changes follow red-green-refactor: each implementation step starts only after its named test fails for the expected missing behavior.

---

### Task 1: Project selected subscription reports into generic footer limits

**Files:**
- Create: `packages/coding-agent/src/modes/components/status-line/usage-limits.ts`
- Modify: `packages/coding-agent/src/modes/components/status-line/types.ts:44-89`
- Modify: `packages/coding-agent/src/modes/components/status-line/segments.ts:525-575`
- Create: `packages/coding-agent/test/status-line-usage-limits.test.ts`

**Interfaces:**
- Consumes: `UsageReport`, `resolveUsedFraction`, `OAuthAccountIdentity`, and `limitMatchesActiveAccount(report, limit, identity)`.
- Produces: `UsageSelection`, `StatusLineUsageLimit`, `usageSelectionKey(selection)`, and `projectUsageLimits(reports, selection)` from `usage-limits.ts`.
- Produces: `SegmentContext.usage: readonly StatusLineUsageLimit[]`.

- [ ] **Step 1: Write failing projection tests**

Create `packages/coding-agent/test/status-line-usage-limits.test.ts` with fixtures that mix providers, accounts, model scopes, window names, duplicate IDs, and amount encodings:

```ts
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
```

Add the renderer contract to the same file:

```ts
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
```

- [ ] **Step 2: Run projection tests and verify RED**

Run:

```sh
bun test packages/coding-agent/test/status-line-usage-limits.test.ts
```

Expected: FAIL because `status-line/usage-limits` does not exist and `SegmentContext.usage` still has the fixed `fiveHour`/`sevenDay` shape.

- [ ] **Step 3: Implement the pure projection module**

Create `usage-limits.ts` with these exact public contracts and behavior:

```ts
import { resolveUsedFraction, type UsageReport } from "@oh-my-pi/pi-ai";
import type { OAuthAccountIdentity } from "../../../session/auth-storage";
import { limitMatchesActiveAccount } from "../../../slash-commands/helpers/active-oauth-account";

export interface UsageSelection {
	provider: string;
	modelId: string;
	identity: OAuthAccountIdentity;
}

export interface StatusLineUsageLimit {
	id: string;
	label: string;
	usedFraction: number;
	resetsAt?: number;
	tier?: string;
	modelId?: string;
}

function normalized(value: string | undefined): string {
	return value?.trim().toLowerCase() ?? "";
}

export function usageSelectionKey(selection: UsageSelection): string {
	const { identity } = selection;
	return [
		normalized(selection.provider),
		normalized(selection.modelId),
		normalized(identity.accountId),
		normalized(identity.email),
		normalized(identity.projectId),
	].join("\u0000");
}

export function projectUsageLimits(
	reports: readonly UsageReport[] | null | undefined,
	selection: UsageSelection,
): StatusLineUsageLimit[] {
	const projected: StatusLineUsageLimit[] = [];
	const seen = new Set<string>();
	for (const report of reports ?? []) {
		if (report.provider !== selection.provider) continue;
		for (const limit of report.limits) {
			if (seen.has(limit.id)) continue;
			if (!limitMatchesActiveAccount(report, limit, selection.identity)) continue;
			if (limit.scope.modelId && limit.scope.modelId !== selection.modelId) continue;
			const usedFraction = resolveUsedFraction(limit);
			if (usedFraction === undefined || !Number.isFinite(usedFraction)) continue;
			seen.add(limit.id);
			projected.push({
				id: limit.id,
				label: limit.window?.label || limit.label,
				usedFraction,
				resetsAt: limit.window?.resetsAt,
				tier: limit.scope.tier,
				modelId: limit.scope.modelId,
			});
		}
	}
	// Disambiguate duplicate labels with tier first, then model ID, without
	// changing provider order or the stable IDs used for deduplication.
	const counts = new Map<string, number>();
	for (const item of projected) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
	return projected.map(item => {
		if ((counts.get(item.label) ?? 0) < 2) return item;
		const qualifier = item.tier ?? item.modelId;
		return qualifier ? { ...item, label: `${item.label} (${qualifier})` } : item;
	});
}
```

Update `SegmentContext.usage` to `readonly StatusLineUsageLimit[]`, importing the type from `./usage-limits`.

Replace the fixed `5h`/`7d` renderer with an ordered list renderer. Compute raw percent as `usedFraction * 100`, clamp the displayed value to `0..100`, use raw percent for `pickUsageColor`, and calculate a compact reset countdown from `resetsAt - Date.now()` using minutes below one day and days/hours at or above one day.

- [ ] **Step 4: Run projection tests and verify GREEN**

Run:

```sh
bun test packages/coding-agent/test/status-line-usage-limits.test.ts
```

Expected: PASS for provider/account/model filtering, arbitrary windows, deduplication, normalized fractions, selection keys, and rendering.

- [ ] **Step 5: Commit the projection and renderer**

```sh
git add packages/coding-agent/src/modes/components/status-line/usage-limits.ts \
  packages/coding-agent/src/modes/components/status-line/types.ts \
  packages/coding-agent/src/modes/components/status-line/segments.ts \
  packages/coding-agent/test/status-line-usage-limits.test.ts
git commit -m "feat(tui): project subscription limits for active model"
```

---

### Task 2: Key the asynchronous footer cache by model and active account

**Files:**
- Modify: `packages/coding-agent/src/modes/components/status-line/component.ts:3-5,210-217,347-374,534-643,702-769`
- Modify: `packages/coding-agent/test/status-line-usage-refresh.test.ts:13-156`

**Interfaces:**
- Consumes: `AgentSession.sessionId`, `AgentSession.modelRegistry`, `AuthStorage.getOAuthAccountIdentity(provider, sessionId)`, `usageSelectionKey`, and `projectUsageLimits`.
- Produces: selection-keyed `StatusLineComponent` refresh behavior; no public constructor or method signature changes.

- [ ] **Step 1: Strengthen the session fixture and write failing transition tests**

Update `makeSession` so tests can mutate the selected model and active account while satisfying the real selection path:

```ts
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
		get model() { return state.model; },
		sessionId: "status-line-test",
		modelRegistry: {
			isUsingOAuth: () => identity !== undefined,
			authStorage: { getOAuthAccountIdentity: () => identity },
		},
		isStreaming: false,
		sessionManager: {
			getUsageStatistics: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 }),
			getSessionName: () => "test",
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		getContextUsage: () => undefined,
		contextUsageRevision: 0,
	} as unknown as AgentSession;
	return {
		session,
		setModel(provider, id) { state.model = { provider, id, contextWindow: 200_000 }; },
		setIdentity(next) { identity = next; },
	};
}
```

Replace the old fixed Anthropic fixture with a provider/account-aware report helper:

```ts
function usageReport(
	provider: string,
	accountId: string,
	label: string,
	percent: number,
): UsageReport[] {
	return [{
		provider,
		fetchedAt: Date.now(),
		metadata: { accountId },
		limits: [{
			id: `${provider}:${accountId}:${label}`,
			label,
			scope: { provider, accountId, windowId: label },
			window: { id: label, label, resetsAt: Date.now() + 60_000 },
			amount: { unit: "percent", usedFraction: percent / 100 },
		}],
	}];
}
```

Update existing constructor calls to pass `makeSession(fetcher).session`, then add these transition tests:

```ts
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
```

Keep the existing non-blocking, timeout-signal, hanging-fetch backoff, and same-key late-result tests.

- [ ] **Step 2: Run refresh tests and verify RED**

Run:

```sh
bun test packages/coding-agent/test/status-line-usage-refresh.test.ts
```

Expected: FAIL because the component still keeps one provider-agnostic cache and fixed-window normalizer.

- [ ] **Step 3: Implement selection-keyed cache ownership**

In `component.ts`:

1. Import `UsageReport`, `UsageSelection`, `StatusLineUsageLimit`, `projectUsageLimits`, and `usageSelectionKey`.
2. Replace `#cachedUsage` with `readonly StatusLineUsageLimit[]` and replace the boolean in-flight flag with `#usageInFlightKey: string | null`.
3. Add `#usageSelectionKey: string | null` for the cache currently displayed.
4. Add a side-effect-free `#resolveUsageSelection()` that reads the current model, rejects non-OAuth models, resolves identity via `getOAuthAccountIdentity(model.provider, session.sessionId)`, and returns `{ provider, modelId: model.id, identity }`.
5. Add `#syncUsageSelection()` that clears the timer, cached limits, timestamp, and in-flight ownership whenever the key changes. It returns the current selection and key.
6. Capture `{ session, selection, key }` when scheduling and running a fetch. Apply success, failure timestamps, late results, and `finally` cleanup only when both the session and current selection key still match the captured target.
7. Project typed `UsageReport[] | null` with `projectUsageLimits`; delete `#normalizeUsageReports` entirely.
8. Pass the cached array through `#buildSegmentContext`.
9. Reset all usage key fields in `#invalidateSessionCaches()` and `dispose()` without attempting to cancel an already-started provider promise.

Use this target contract so stale asynchronous work cannot mutate current cache state:

```ts
interface UsageRefreshTarget {
	session: AgentSession;
	selection: UsageSelection;
	key: string;
}
```

Every completion path must call a shared current-target predicate equivalent to:

```ts
#isCurrentUsageTarget(target: UsageRefreshTarget): boolean {
	if (this.#disposed || this.session !== target.session) return false;
	const current = this.#resolveUsageSelection();
	return current !== undefined && usageSelectionKey(current) === target.key;
}
```

- [ ] **Step 4: Run focused refresh and projection tests**

Run:

```sh
bun test packages/coding-agent/test/status-line-usage-refresh.test.ts \
  packages/coding-agent/test/status-line-usage-limits.test.ts
```

Expected: PASS with no unhandled promise errors. The model/account transition assertions prove stale limits clear before the next fetch resolves.

- [ ] **Step 5: Run the status-line regression set**

Run:

```sh
bun test packages/coding-agent/test/status-line-*.test.ts
```

Expected: PASS. This covers exported `SegmentContext` fixtures, settings, overflow, context caching, async disposal, model rendering, transparency, generic usage rendering, and refresh lifecycle.

- [ ] **Step 6: Commit the cache integration**

```sh
git add packages/coding-agent/src/modes/components/status-line/component.ts \
  packages/coding-agent/test/status-line-usage-refresh.test.ts
git commit -m "fix(tui): refresh limits on model and account changes"
```
