import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUsageAmount(value: unknown): value is UsageLimit["amount"] {
	if (!isRecord(value) || typeof value.unit !== "string") return false;
	for (const field of ["used", "limit", "remaining", "usedFraction", "remainingFraction"] as const) {
		const amount = value[field];
		if (amount !== undefined && (typeof amount !== "number" || !Number.isFinite(amount))) return false;
	}
	return true;
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
	if (!Array.isArray(reports)) return [];
	const projected: StatusLineUsageLimit[] = [];
	const seen = new Set<string>();
	for (const reportValue of reports as readonly unknown[]) {
		if (
			!isRecord(reportValue) ||
			typeof reportValue.provider !== "string" ||
			!reportValue.provider.trim() ||
			!Array.isArray(reportValue.limits) ||
			reportValue.provider !== selection.provider
		) {
			continue;
		}
		const report = reportValue as unknown as UsageReport;
		for (const limitValue of reportValue.limits as readonly unknown[]) {
			if (!isRecord(limitValue) || typeof limitValue.id !== "string" || !limitValue.id.trim()) continue;
			if (!isRecord(limitValue.scope) || !isUsageAmount(limitValue.amount)) continue;
			const scope = limitValue.scope;
			if (typeof scope.provider !== "string" || !scope.provider.trim()) continue;
			let validScope = true;
			for (const field of ["accountId", "projectId", "orgId", "modelId", "tier", "windowId"] as const) {
				if (scope[field] !== undefined && typeof scope[field] !== "string") {
					validScope = false;
					break;
				}
			}
			if (!validScope || (scope.shared !== undefined && typeof scope.shared !== "boolean")) continue;

			const window = isRecord(limitValue.window) ? limitValue.window : undefined;
			const windowLabel =
				typeof window?.label === "string" && window.label.trim().length > 0 ? window.label : undefined;
			const limitLabel =
				typeof limitValue.label === "string" && limitValue.label.trim().length > 0 ? limitValue.label : undefined;
			const label = windowLabel ?? limitLabel;
			if (!label) continue;

			const limit = limitValue as unknown as UsageLimit;
			if (seen.has(limit.id)) continue;
			if (!limitMatchesActiveAccount(report, limit, selection.identity)) continue;
			if (limit.scope.modelId && normalized(limit.scope.modelId) !== normalized(selection.modelId)) continue;
			const usedFraction = resolveUsedFraction(limit);
			if (usedFraction === undefined || !Number.isFinite(usedFraction)) continue;
			seen.add(limit.id);
			const item: StatusLineUsageLimit = {
				id: limit.id,
				label,
				usedFraction,
				tier: limit.scope.tier,
				modelId: limit.scope.modelId,
			};
			if (typeof window?.resetsAt === "number" && Number.isFinite(window.resetsAt)) {
				item.resetsAt = window.resetsAt;
			}
			projected.push(item);
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
