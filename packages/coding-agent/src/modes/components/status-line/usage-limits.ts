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
