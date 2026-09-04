import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Array, Cause, Context, Data, Effect, Encoding, Exit, FileSystem, Inspectable, Layer, Option, Order, Path, Schedule, Schema, String, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApi, HttpApiClient, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
//#region ../../tooling/shared/src/run.ts
function causeMessage(cause) {
	if (Cause.hasInterruptsOnly(cause)) return "Operation aborted";
	if (Cause.hasDies(cause)) return Cause.pretty(cause);
	return cause.reasons.filter(Cause.isFailReason).map(({ error }) => {
		if (error instanceof Error) return error.message || error.name;
		return typeof error === "string" ? error : Inspectable.toStringUnknown(error);
	}).join("\n");
}
async function runHandler(effect, options) {
	const exit = await Effect.runPromiseExit(effect);
	if (Exit.isSuccess(exit)) return exit.value;
	if (options?.onError) return options.onError(causeMessage(exit.cause));
	const die = exit.cause.reasons.find(Cause.isDieReason);
	if (die !== void 0) throw die.defect;
}
//#endregion
//#region ../../tooling/shared/src/config.ts
const loadExtensionConfig = Effect.fnUntraced(function* (_ctx, schema, name, _defaults) {
	const fs = yield* FileSystem.FileSystem;
	const file = (yield* Path.Path).join(getAgentDir(), "extensions", `${name}.json`);
	const contents = yield* fs.readFileString(file);
	return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(contents);
}, (load, ctx, _schema, name, defaults) => runHandler(load.pipe(Effect.catchIf((error) => error._tag === "PlatformError" && error.reason._tag === "NotFound", () => Effect.succeed(defaults)), Effect.provide(NodeServices.layer)), { onError: (message) => {
	if (ctx.hasUI) ctx.ui.notify(`Ignoring invalid ${name} config: ${message}`, "warning");
	return defaults;
} }));
//#endregion
//#region ../../tooling/shared/src/statusline.ts
const WIDGET_KEY = "pi-plugins:statusline";
const REGISTRY_KEY = Symbol.for("@pi-plugins/statusline-registry");
const HOOKED_KEY = Symbol.for("@pi-plugins/editor-border-hooked");
function side(segments, align) {
	return pipe(Array.fromIterable(segments), Array.filter(([, segment]) => segment.align === align), Array.sortBy(Order.mapInput(Order.String, ([key]) => key)), Array.map(([, segment]) => segment.text), Array.join(" ── "));
}
function stripAnsi(str) {
	return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}
function textWidth(text) {
	return Array.fromIterable(stripAnsi(text)).length;
}
function findCustomEditor() {
	const req = createRequire(import.meta.url);
	if (typeof process !== "undefined" && process.argv?.[1]) try {
		const cliDir = path.dirname(process.argv[1]);
		const mod = req(path.join(cliDir, "index.js"));
		if (mod.CustomEditor) return mod.CustomEditor;
	} catch {}
	try {
		const mod = req(req.resolve("@earendil-works/pi-coding-agent"));
		if (mod.CustomEditor) return mod.CustomEditor;
	} catch {}
	try {
		const mod = req("/home/user/.local/share/pnpm/global/v11/b1fd2-1a06d456c3a/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js");
		if (mod.CustomEditor) return mod.CustomEditor;
	} catch {}
}
function ensureBorderHooked() {
	const store = globalThis;
	if (store[HOOKED_KEY]) return true;
	const CustomEditor = findCustomEditor();
	if (!CustomEditor?.prototype?.renderTopBorder) return false;
	const origRenderTopBorder = CustomEditor.prototype.renderTopBorder;
	CustomEditor.prototype.renderTopBorder = function(width, hiddenLineCount) {
		const segments = globalThis[REGISTRY_KEY];
		if (!segments || segments.size === 0 || width <= 0) return origRenderTopBorder.call(this, width, hiddenLineCount);
		const leftText = side(segments, "left");
		const rightText = side(segments, "right");
		if (!leftText && !rightText) return origRenderTopBorder.call(this, width, hiddenLineCount);
		const color = this.borderColor ?? ((t) => t);
		const dimColor = this.theme?.fg ? (t) => this.theme.fg("dim", t) : (t) => `\x1B[2m${t}\x1B[0m`;
		const isWorking = Boolean(this.embedWorkingStatus && this.workingStatusIndicator);
		let status = "";
		let statusWidth = 0;
		if (isWorking && this.workingStatusIndicator) {
			status = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 5));
			statusWidth = textWidth(status);
		}
		const rightPartWidth = rightText ? textWidth(rightText) + 4 : 0;
		const rightPart = rightText ? color(" ") + dimColor(rightText) + color(" ──") : "";
		const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : void 0;
		const overflowWidth = overflowLabel ? textWidth(overflowLabel) : 0;
		if (isWorking && statusWidth > 0) {
			const leftPart = color("── ") + status + color(" ");
			const leftPartWidth = 3 + statusWidth + 1;
			if (rightText && width >= leftPartWidth + rightPartWidth + 2) {
				const middleSpace = width - leftPartWidth - rightPartWidth;
				let middle = "";
				if (overflowLabel && middleSpace >= overflowWidth + 2) {
					const rem = middleSpace - overflowWidth;
					const d1 = Math.floor(rem / 2);
					const d2 = rem - d1;
					middle = color("─".repeat(d1)) + overflowLabel + color("─".repeat(d2));
				} else middle = color("─".repeat(middleSpace));
				return leftPart + middle + rightPart;
			}
			return origRenderTopBorder.call(this, width, hiddenLineCount);
		}
		const leftPartWidth = leftText ? textWidth(leftText) + 4 : 0;
		const leftPart = leftText ? color("── ") + dimColor(leftText) + color(" ") : "";
		if (width >= leftPartWidth + rightPartWidth + 2) {
			const middleSpace = width - leftPartWidth - rightPartWidth;
			let middle = "";
			if (overflowLabel && middleSpace >= overflowWidth + 2) {
				const rem = middleSpace - overflowWidth;
				const d1 = Math.floor(rem / 2);
				const d2 = rem - d1;
				middle = color("─".repeat(d1)) + overflowLabel + color("─".repeat(d2));
			} else middle = color("─".repeat(middleSpace));
			return leftPart + middle + rightPart;
		}
		return origRenderTopBorder.call(this, width, hiddenLineCount);
	};
	store[HOOKED_KEY] = true;
	return true;
}
function setStatuslineSegment(ctx, key, segment) {
	const store = globalThis;
	store[REGISTRY_KEY] ??= /* @__PURE__ */ new Map();
	const segments = store[REGISTRY_KEY];
	if (segment === void 0) segments.delete(key);
	else segments.set(key, segment);
	if (!ctx.hasUI) return;
	if (ensureBorderHooked()) {
		ctx.ui.setWidget(WIDGET_KEY, void 0);
		ctx.ui.setStatus("pi-plugins:statusline-render", void 0);
		return;
	}
	if (segments.size === 0) {
		ctx.ui.setWidget(WIDGET_KEY, void 0);
		return;
	}
	ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
		invalidate: () => {},
		render: (width) => {
			const left = side(segments, "left");
			const right = side(segments, "right");
			const margin = Math.min(width, 1);
			const inner = width - margin;
			const gap = inner - textWidth(left) - textWidth(right);
			const minGap = String.isNonEmpty(left) && String.isNonEmpty(right) ? 2 : 0;
			const line = String.isNonEmpty(right) && gap >= minGap ? `${left}${" ".repeat(gap)}${right}` : pipe([left, right], Array.filter(String.isNonEmpty), Array.join(" ── "), Array.fromIterable, Array.take(Math.max(inner, 0)), Array.join(""));
			return [" ".repeat(margin) + theme.fg("dim", line)];
		}
	}));
}
//#endregion
//#region src/reset.ts
function parseResetsAt(value) {
	if (typeof value === "number") return /* @__PURE__ */ new Date(value * 1e3);
	if (typeof value === "string") {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date;
	}
	return null;
}
function codexResetsAt(window, now) {
	if (typeof window.reset_after_seconds === "number") return new Date(now.getTime() + window.reset_after_seconds * 1e3);
	if (typeof window.reset_at === "number") return /* @__PURE__ */ new Date(window.reset_at * 1e3);
	return null;
}
function formatDuration(ms) {
	const minutes = Math.max(Math.ceil(ms / 6e4), 0);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
function formatCompactDuration(ms) {
	const minutes = Math.floor(ms / 6e4);
	if (minutes < 60) return `${Math.max(minutes, 1)}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
//#endregion
//#region src/render.ts
const MIN_LABEL_WIDTH = 22;
const BAR_WIDTH$1 = 10;
function formatRow(row, now, labelWidth) {
	const parts = [`  ${row.label.padEnd(labelWidth)}`];
	if (typeof row.percent === "number") {
		const clamped = Math.min(Math.max(row.percent, 0), 100);
		const filled = Math.round(clamped / 100 * BAR_WIDTH$1);
		const suffix = row.percentSuffix ?? " remaining";
		const pctStr = `${Math.round(row.percent)}%${suffix}`;
		parts.push(`[${"█".repeat(filled)}${"░".repeat(BAR_WIDTH$1 - filled)}]`, suffix ? pctStr.padStart(14) : pctStr.padStart(4));
	}
	if (row.resetsAt) {
		const delta = row.resetsAt.getTime() - now.getTime();
		parts.push(delta > 0 ? `· resets in ${formatDuration(delta)}` : "· resets soon");
	}
	if (row.note) parts.push(parts.length > 1 ? `· ${row.note}` : row.note);
	return parts.join(" ");
}
function renderSections(sections, now) {
	const labelWidth = Math.max(MIN_LABEL_WIDTH, ...sections.flatMap((section) => "rows" in section ? section.rows.map((row) => row.label.length) : []));
	return sections.map((section) => {
		if ("error" in section) return `${section.title}\n  ${section.error}`;
		if (section.rows.length === 0) return `${section.title}\n  (no usage data reported)`;
		return [section.title, ...section.rows.map((row) => formatRow(row, now, labelWidth))].join("\n");
	});
}
function formatMinorAmount(amount, decimalPlaces, currency) {
	const value = amount / 10 ** decimalPlaces;
	if (currency) try {
		return new Intl.NumberFormat("en-US", {
			style: "currency",
			currency
		}).format(value);
	} catch {}
	return value.toFixed(decimalPlaces);
}
function unifiedLimitLabel(limit) {
	switch (limit.kind) {
		case "session": return "Session (5h)";
		case "weekly_all": return "Week (all models)";
		case "weekly_scoped": {
			const model = limit.scope?.model;
			return `Week (${model?.display_name ?? model?.id ?? "scoped"})`;
		}
		default: return limit.kind;
	}
}
function claudeSection(usage) {
	const rows = [];
	const limits = usage.limits ?? [];
	if (limits.length > 0) for (const limit of limits) rows.push({
		label: unifiedLimitLabel(limit),
		percent: typeof limit.percent === "number" ? Math.max(0, Math.min(100, 100 - limit.percent)) : limit.percent,
		resetsAt: parseResetsAt(limit.resets_at)
	});
	else {
		const flatWindows = [
			["Session (5h)", usage.five_hour],
			["Week (all models)", usage.seven_day],
			["Week (Opus)", usage.seven_day_opus],
			["Week (Sonnet)", usage.seven_day_sonnet]
		];
		for (const [label, window] of flatWindows) if (window && typeof window.utilization === "number") rows.push({
			label,
			percent: Math.max(0, Math.min(100, 100 - window.utilization)),
			resetsAt: parseResetsAt(window.resets_at)
		});
	}
	const extra = usage.extra_usage;
	if (extra) {
		const decimals = extra.decimal_places ?? 2;
		const used = typeof extra.used_credits === "number" ? formatMinorAmount(extra.used_credits, decimals, extra.currency) : null;
		const limit = typeof extra.monthly_limit === "number" ? formatMinorAmount(extra.monthly_limit, decimals, extra.currency) : null;
		if (used !== null) rows.push({
			label: "Extra usage",
			percent: extra.utilization,
			percentSuffix: "",
			note: limit ? `${used} of ${limit}` : used
		});
		if (extra.is_enabled === false) {
			const reason = extra.disabled_reason?.split("_").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
			rows.push({
				label: "Extra usage",
				note: reason ? `disabled — ${reason}` : "disabled"
			});
		}
	}
	return {
		title: "Claude",
		rows
	};
}
function codexWindowName(seconds) {
	if (typeof seconds !== "number" || seconds <= 0) return "Window";
	if (seconds >= 604800 * .9) return "Week";
	if (seconds >= 86400) return `${Math.round(seconds / 86400)}d`;
	return `${Math.round(seconds / 3600)}h`;
}
function codexWindowRows(details, now, labelFor) {
	const rows = [];
	for (const window of [details?.primary_window, details?.secondary_window]) {
		if (!window) continue;
		const remaining = Math.max(0, Math.min(100, 100 - window.used_percent));
		rows.push({
			label: labelFor(codexWindowName(window.limit_window_seconds)),
			percent: remaining,
			resetsAt: codexResetsAt(window, now)
		});
	}
	return rows;
}
function codexSection(usage, now) {
	const rows = codexWindowRows(usage.rate_limit, now, (name) => name === "Week" ? "Week limit" : `${name} limit`);
	for (const additional of usage.additional_rate_limits ?? []) rows.push(...codexWindowRows(additional.rate_limit, now, (name) => `${additional.limit_name} (${name})`));
	const credits = usage.credits;
	if (credits && (credits.unlimited || credits.has_credits && credits.balance != null)) rows.push({
		label: "Credits",
		note: credits.unlimited ? "unlimited" : `balance ${credits.balance}`
	});
	const resetCredits = usage.rate_limit_reset_credits;
	if (resetCredits && resetCredits.available_count > 0) rows.push({
		label: "Rate-limit resets",
		note: `${resetCredits.available_count} available`
	});
	return {
		title: usage.plan_type ? `OpenAI Codex (${usage.plan_type})` : "OpenAI Codex",
		rows
	};
}
//#endregion
//#region src/provider/anthropic.ts
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
const UsageWindow = Schema.Struct({
	utilization: Schema.optional(Schema.NullOr(Schema.Number)),
	resets_at: Schema.optional(Schema.NullOr(Schema.String))
});
const ExtraUsage = Schema.Struct({
	is_enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
	monthly_limit: Schema.optional(Schema.NullOr(Schema.Number)),
	used_credits: Schema.optional(Schema.NullOr(Schema.Number)),
	utilization: Schema.optional(Schema.NullOr(Schema.Number)),
	currency: Schema.optional(Schema.NullOr(Schema.String)),
	decimal_places: Schema.optional(Schema.NullOr(Schema.Number)),
	disabled_reason: Schema.optional(Schema.NullOr(Schema.String))
});
const UnifiedLimit = Schema.Struct({
	kind: Schema.String,
	percent: Schema.optional(Schema.NullOr(Schema.Number)),
	resets_at: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
	scope: Schema.optional(Schema.NullOr(Schema.Struct({ model: Schema.optional(Schema.NullOr(Schema.Struct({
		id: Schema.optional(Schema.NullOr(Schema.String)),
		display_name: Schema.optional(Schema.NullOr(Schema.String))
	}))) }))),
	is_active: Schema.optional(Schema.NullOr(Schema.Boolean))
});
const ClaudeUsage = Schema.Struct({
	five_hour: Schema.optional(Schema.NullOr(UsageWindow)),
	seven_day: Schema.optional(Schema.NullOr(UsageWindow)),
	seven_day_opus: Schema.optional(Schema.NullOr(UsageWindow)),
	seven_day_sonnet: Schema.optional(Schema.NullOr(UsageWindow)),
	seven_day_oauth_apps: Schema.optional(Schema.NullOr(UsageWindow)),
	extra_usage: Schema.optional(Schema.NullOr(ExtraUsage)),
	limits: Schema.optional(Schema.NullOr(Schema.Array(UnifiedLimit)))
});
const ClaudeUsageApi = HttpApi.make("ClaudeUsage").add(HttpApiGroup.make("oauth", { topLevel: true }).add(HttpApiEndpoint.get("usage", "/api/oauth/usage", { success: ClaudeUsage })));
//#endregion
//#region src/provider/openai.ts
const CHATGPT_BASE_URL = "https://chatgpt.com";
const RateLimitWindow = Schema.Struct({
	used_percent: Schema.Number,
	limit_window_seconds: Schema.optional(Schema.NullOr(Schema.Number)),
	reset_after_seconds: Schema.optional(Schema.NullOr(Schema.Number)),
	reset_at: Schema.optional(Schema.NullOr(Schema.Number))
});
const RateLimitDetails = Schema.Struct({
	allowed: Schema.optional(Schema.NullOr(Schema.Boolean)),
	limit_reached: Schema.optional(Schema.NullOr(Schema.Boolean)),
	primary_window: Schema.optional(Schema.NullOr(RateLimitWindow)),
	secondary_window: Schema.optional(Schema.NullOr(RateLimitWindow))
});
const CreditStatus = Schema.Struct({
	has_credits: Schema.optional(Schema.NullOr(Schema.Boolean)),
	unlimited: Schema.optional(Schema.NullOr(Schema.Boolean)),
	balance: Schema.optional(Schema.NullOr(Schema.String))
});
const AdditionalRateLimit = Schema.Struct({
	limit_name: Schema.String,
	rate_limit: Schema.optional(Schema.NullOr(RateLimitDetails))
});
const CodexUsage = Schema.Struct({
	plan_type: Schema.optional(Schema.NullOr(Schema.String)),
	rate_limit: Schema.optional(Schema.NullOr(RateLimitDetails)),
	credits: Schema.optional(Schema.NullOr(CreditStatus)),
	additional_rate_limits: Schema.optional(Schema.NullOr(Schema.Array(AdditionalRateLimit))),
	rate_limit_reset_credits: Schema.optional(Schema.NullOr(Schema.Struct({ available_count: Schema.Number })))
});
const CodexUsageApi = HttpApi.make("CodexUsage").add(HttpApiGroup.make("wham", { topLevel: true }).add(HttpApiEndpoint.get("usage", "/backend-api/wham/usage", { success: CodexUsage })));
//#endregion
//#region src/service.ts
const REQUEST_TIMEOUT = "10 seconds";
const LOGIN_HINT = "run /login to (re-)authenticate";
var UsageServiceError = class extends Schema.TaggedErrorClass()("@pi-plugins/usage/UsageServiceError", {
	kind: Schema.Literals([
		"CredentialsMissing",
		"TokenRefreshFailed",
		"AccountIdMissing",
		"RequestFailed"
	]),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect())
}) {};
const requestFailed = (cause) => new UsageServiceError({
	kind: "RequestFailed",
	message: Cause.isTimeoutError(cause) ? "usage API request timed out" : cause instanceof Error && typeof cause.message === "string" && cause.message.length > 0 ? cause.message : "usage API request failed",
	cause
});
const UsageProvider = Data.taggedEnum();
const UsageCredentials = Data.taggedEnum();
const accountIdFromToken = Effect.fnUntraced(function* (accessToken) {
	const payload = yield* Effect.fromResult(Encoding.decodeBase64UrlString(pipe(accessToken, String.split("."), Array.get(1), Option.getOrElse(() => ""))));
	return (yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ "https://api.openai.com/auth": Schema.Struct({ chatgpt_account_id: Schema.String }) })))(payload))["https://api.openai.com/auth"].chatgpt_account_id;
});
var UsageService = class extends Context.Service()("@pi-plugins/usage/UsageService", { make: Effect.fnUntraced(function* (registry) {
	const http = (yield* HttpClient.HttpClient).pipe(HttpClient.mapRequest(HttpClientRequest.acceptJson), HttpClient.filterStatusOk, HttpClient.retryTransient({
		times: 3,
		schedule: Schedule.jittered(Schedule.exponential("1 second"))
	}));
	const credentials = Effect.fnUntraced(function* (provider) {
		const providerId = UsageProvider.$match(provider, {
			Anthropic: () => "anthropic",
			OpenAI: () => "openai-codex"
		});
		if (readStoredCredential(providerId)?.type !== "oauth") return yield* new UsageServiceError({
			kind: "CredentialsMissing",
			message: `no subscription (OAuth) credentials found — ${LOGIN_HINT}`
		});
		const accessToken = yield* Effect.tryPromise({
			try: () => registry.getApiKeyForProvider(providerId),
			catch: (cause) => new UsageServiceError({
				kind: "TokenRefreshFailed",
				message: `token refresh failed — ${LOGIN_HINT}`,
				cause
			})
		});
		if (!accessToken) return yield* new UsageServiceError({
			kind: "TokenRefreshFailed",
			message: `token refresh failed — ${LOGIN_HINT}`
		});
		return yield* UsageProvider.$match(provider, {
			Anthropic: () => Effect.succeed(UsageCredentials.Anthropic({ accessToken })),
			OpenAI: Effect.fnUntraced(function* () {
				const credential = readStoredCredential(providerId);
				const accountId = (credential?.type === "oauth" && typeof credential["accountId"] === "string" ? credential["accountId"] : void 0) ?? (yield* accountIdFromToken(accessToken).pipe(Effect.orElseSucceed(() => void 0)));
				if (!accountId) return yield* new UsageServiceError({
					kind: "AccountIdMissing",
					message: `missing ChatGPT account id — ${LOGIN_HINT}`
				});
				return UsageCredentials.OpenAI({
					accessToken,
					accountId
				});
			})
		});
	});
	return {
		claude: Effect.fn("UsageService.claude")(function* () {
			const { accessToken } = yield* credentials(UsageProvider.Anthropic());
			return yield* (yield* HttpApiClient.makeWith(ClaudeUsageApi, {
				baseUrl: ANTHROPIC_BASE_URL,
				httpClient: http.pipe(HttpClient.mapRequest(HttpClientRequest.setHeaders({
					Authorization: `Bearer ${accessToken}`,
					"anthropic-beta": ANTHROPIC_OAUTH_BETA
				})))
			})).usage().pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(requestFailed));
		}),
		codex: Effect.fn("UsageService.codex")(function* () {
			const { accessToken, accountId } = yield* credentials(UsageProvider.OpenAI());
			return yield* (yield* HttpApiClient.makeWith(CodexUsageApi, {
				baseUrl: CHATGPT_BASE_URL,
				httpClient: http.pipe(HttpClient.mapRequest(HttpClientRequest.setHeaders({
					Authorization: `Bearer ${accessToken}`,
					"ChatGPT-Account-Id": accountId
				})))
			})).usage().pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(requestFailed));
		})
	};
}) }) {
	static layer = (registry) => Layer.effect(this, this.make(registry)).pipe(Layer.provide(FetchHttpClient.layer));
};
//#endregion
//#region src/widget.ts
const BAR_WIDTH = 5;
function widgetText(limits, now) {
	if (limits === void 0 || limits.length === 0) return;
	return limits.map((limit) => {
		const clamped = Math.min(Math.max(limit.percent, 0), 100);
		const filled = Math.round(clamped / 100 * BAR_WIDTH);
		const bar = `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
		const text = `${limit.label} ${bar} ${Math.round(limit.percent)}%`;
		if (!limit.resetsAt) return text;
		const delta = limit.resetsAt.getTime() - now.getTime();
		return `${text} (${delta > 0 ? formatCompactDuration(delta) : "now"})`;
	}).join(" ── ");
}
function claudeWidgetLimits(usage) {
	const limits = usage.limits ?? [];
	if (limits.length > 0) return limits.flatMap((limit) => {
		const label = limit.kind === "session" ? "5h" : limit.kind === "weekly_all" ? "wk" : void 0;
		return label !== void 0 && typeof limit.percent === "number" ? [{
			label,
			percent: Math.max(0, Math.min(100, 100 - limit.percent)),
			resetsAt: parseResetsAt(limit.resets_at)
		}] : [];
	});
	return [["5h", usage.five_hour], ["wk", usage.seven_day]].flatMap(([label, window]) => typeof window?.utilization === "number" ? [{
		label,
		percent: Math.max(0, Math.min(100, 100 - window.utilization)),
		resetsAt: parseResetsAt(window.resets_at)
	}] : []);
}
function codexWindowLabel(seconds) {
	if (typeof seconds !== "number" || seconds <= 0) return "?";
	if (seconds >= 604800 * .9) return "wk";
	if (seconds >= 86400) return `${Math.round(seconds / 86400)}d`;
	return `${Math.round(seconds / 3600)}h`;
}
function codexWidgetLimits(usage, now) {
	const details = usage.rate_limit;
	return [details?.primary_window, details?.secondary_window].flatMap((window) => window ? [{
		label: codexWindowLabel(window.limit_window_seconds),
		percent: Math.max(0, Math.min(100, 100 - window.used_percent)),
		resetsAt: codexResetsAt(window, now)
	}] : []);
}
//#endregion
//#region src/index.ts
const EXTENSION_ID = "usage";
const WIDGET_REFRESH_MS = 3e4;
const UsageConfig = Schema.Struct({ showWidget: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))) });
function widgetProvider(model) {
	switch (model?.provider) {
		case "anthropic": return "claude";
		case "openai-codex": return "codex";
		default: return;
	}
}
function saveExtensionConfig(conf) {
	try {
		const dir = path.join(getAgentDir(), "extensions");
		fs.mkdirSync(dir, { recursive: true });
		const configFile = path.join(dir, `${EXTENSION_ID}.json`);
		fs.writeFileSync(configFile, JSON.stringify(conf, null, 2));
	} catch {}
}
function section(title, fetch, toSection) {
	return fetch.pipe(Effect.map(toSection), Effect.catch((error) => Effect.succeed({
		title,
		error: error.message
	})));
}
function usage(pi) {
	let config = Schema.decodeUnknownSync(UsageConfig)({});
	const limitsCache = /* @__PURE__ */ new Map();
	const fetchedAt = /* @__PURE__ */ new Map();
	const inFlight = /* @__PURE__ */ new Set();
	function recordLimits(provider, limits) {
		limitsCache.set(provider, limits);
		fetchedAt.set(provider, Date.now());
	}
	function renderWidget(ctx) {
		if (!ctx.hasUI) return;
		const provider = config.showWidget ? widgetProvider(ctx.model) : void 0;
		const text = provider === void 0 ? void 0 : widgetText(limitsCache.get(provider), /* @__PURE__ */ new Date());
		setStatuslineSegment(ctx, EXTENSION_ID, text === void 0 ? void 0 : {
			text,
			align: "right"
		});
	}
	async function refreshWidget(ctx) {
		renderWidget(ctx);
		if (!ctx.hasUI || !config.showWidget) return;
		const provider = widgetProvider(ctx.model);
		if (provider === void 0 || inFlight.has(provider)) return;
		const last = fetchedAt.get(provider);
		if (last !== void 0 && Date.now() - last < WIDGET_REFRESH_MS) return;
		inFlight.add(provider);
		const program = Effect.gen(function* () {
			const service = yield* UsageService;
			return provider === "claude" ? claudeWidgetLimits(yield* service.claude()) : codexWidgetLimits(yield* service.codex(), /* @__PURE__ */ new Date());
		}).pipe(Effect.provide(UsageService.layer(ctx.modelRegistry)));
		let limits;
		try {
			limits = await runHandler(program);
		} finally {
			inFlight.delete(provider);
			fetchedAt.set(provider, Date.now());
		}
		if (limits !== void 0) {
			limitsCache.set(provider, limits);
			renderWidget(ctx);
		}
	}
	pi.on("session_start", async (_event, ctx) => {
		config = await loadExtensionConfig(ctx, UsageConfig, EXTENSION_ID, config);
		await refreshWidget(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		await refreshWidget(ctx);
	});
	pi.on("agent_settled", async (_event, ctx) => {
		await refreshWidget(ctx);
	});
	async function toggleWidget(ctx, targetState) {
		const next = targetState !== void 0 ? targetState : !config.showWidget;
		config = {
			...config,
			showWidget: next
		};
		saveExtensionConfig(config);
		renderWidget(ctx);
		if (config.showWidget) {
			fetchedAt.delete("claude");
			fetchedAt.delete("codex");
			await refreshWidget(ctx);
		}
		if (ctx.hasUI) ctx.ui.notify(`Usage widget ${config.showWidget ? "enabled" : "disabled"}`, "info");
	}
	const toggleHandler = async (args, ctx) => {
		const trimmed = args.trim().toLowerCase();
		if (trimmed === "on" || trimmed === "show") await toggleWidget(ctx, true);
		else if (trimmed === "off" || trimmed === "hide") await toggleWidget(ctx, false);
		else await toggleWidget(ctx);
	};
	pi.registerCommand("usage-toggle", {
		description: "Toggle the usage statusline widget on or off",
		handler: toggleHandler
	});
	pi.registerCommand("usage", {
		description: "Show subscription usage/rate limits for Claude and OpenAI Codex plans (or \"/usage toggle\")",
		getArgumentCompletions: (prefix) => {
			return [
				{
					value: "toggle",
					label: "toggle",
					description: "Toggle the statusline widget on or off"
				},
				{
					value: "show",
					label: "show",
					description: "Show the statusline widget"
				},
				{
					value: "hide",
					label: "hide",
					description: "Hide the statusline widget"
				}
			].filter((o) => o.value.startsWith(prefix.trim().toLowerCase()));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();
			if ([
				"toggle",
				"on",
				"off",
				"show",
				"hide",
				"widget"
			].includes(trimmed)) {
				await toggleHandler(trimmed === "widget" ? "toggle" : trimmed, ctx);
				return;
			}
			const now = /* @__PURE__ */ new Date();
			const messages = await runHandler(Effect.gen(function* () {
				const service = yield* UsageService;
				const sectionsToFetch = [];
				if (readStoredCredential("anthropic")?.type === "oauth") sectionsToFetch.push(section("Claude", service.claude().pipe(Effect.tap((data) => Effect.sync(() => recordLimits("claude", claudeWidgetLimits(data))))), claudeSection));
				sectionsToFetch.push(section("OpenAI Codex", service.codex().pipe(Effect.tap((data) => Effect.sync(() => recordLimits("codex", codexWidgetLimits(data, now))))), (data) => codexSection(data, now)));
				const sections = yield* Effect.all(sectionsToFetch, { concurrency: "unbounded" });
				const rendered = renderSections(sections, now);
				const grouped = {
					info: [],
					warning: []
				};
				sections.forEach((usageSection, index) => {
					if ("error" in usageSection) {
						if (usageSection.title !== "Claude") grouped.warning.push(rendered[index] ?? "");
					} else grouped.info.push(rendered[index] ?? "");
				});
				return ["info", "warning"].filter((severity) => grouped[severity].length > 0).map((severity) => ({
					report: grouped[severity].join("\n\n"),
					severity
				}));
			}).pipe(Effect.provide(UsageService.layer(ctx.modelRegistry))), { onError: (message) => {
				ctx.ui.notify(`Failed to fetch usage: ${message}`, "error");
				return [];
			} });
			for (const { report, severity } of messages) ctx.ui.notify(report, severity);
			renderWidget(ctx);
		}
	});
}
//#endregion
export { usage as default };

//# sourceMappingURL=index.mjs.map