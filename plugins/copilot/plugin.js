(function () {
  const KEYCHAIN_SERVICE = "OpenUsage-copilot";
  const GH_KEYCHAIN_SERVICE = "gh:github.com";
  const USAGE_URL = "https://api.github.com/copilot_internal/user";
  const VIEWER_URL = "https://api.github.com/user";
  const USER_BUDGETS_URL = "https://api.github.com/users/{username}/settings/billing/budgets";
  const API_VERSION = "2022-11-28";
  const USER_AGENT = "GitHubCopilotChat/0.26.7";
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const DEFAULT_COPILOT_BUDGET_USD = 40;
  const COPILOT_BUDGET_SETTING_KEY = "copilotBudgetUsd";
  const COST_PER_ADDITIONAL_PREMIUM_REQUEST_USD = 0.04;

  function readJson(ctx, path) {
    try {
      if (!ctx.host.fs.exists(path)) return null;
      const text = ctx.host.fs.readText(path);
      return ctx.util.tryParseJson(text);
    } catch (e) {
      ctx.host.log.warn("readJson failed for " + path + ": " + String(e));
      return null;
    }
  }

  function writeJson(ctx, path, value) {
    try {
      ctx.host.fs.writeText(path, JSON.stringify(value));
    } catch (e) {
      ctx.host.log.warn("writeJson failed for " + path + ": " + String(e));
    }
  }

  function saveToken(ctx, token) {
    try {
      ctx.host.keychain.writeGenericPassword(
        KEYCHAIN_SERVICE,
        JSON.stringify({ token: token }),
      );
    } catch (e) {
      ctx.host.log.warn("keychain write failed: " + String(e));
    }
    writeJson(ctx, ctx.app.pluginDataDir + "/auth.json", { token: token });
  }

  function clearCachedToken(ctx) {
    try {
      ctx.host.keychain.deleteGenericPassword(KEYCHAIN_SERVICE);
    } catch (e) {
      ctx.host.log.info("keychain delete failed: " + String(e));
    }
    writeJson(ctx, ctx.app.pluginDataDir + "/auth.json", null);
  }

  function loadTokenFromKeychain(ctx) {
    try {
      const raw = ctx.host.keychain.readGenericPassword(KEYCHAIN_SERVICE);
      if (raw) {
        const parsed = ctx.util.tryParseJson(raw);
        if (parsed && parsed.token) {
          ctx.host.log.info("token loaded from OpenUsage keychain");
          return { token: parsed.token, source: "keychain" };
        }
      }
    } catch (e) {
      ctx.host.log.info("OpenUsage keychain read failed: " + String(e));
    }
    return null;
  }

  function loadTokenFromGhCli(ctx) {
    try {
      const raw = ctx.host.keychain.readGenericPassword(GH_KEYCHAIN_SERVICE);
      if (raw) {
        let token = raw;
        if (
          typeof token === "string" &&
          token.indexOf("go-keyring-base64:") === 0
        ) {
          token = ctx.base64.decode(token.slice("go-keyring-base64:".length));
        }
        if (token) {
          ctx.host.log.info("token loaded from gh CLI keychain");
          return { token: token, source: "gh-cli" };
        }
      }
    } catch (e) {
      ctx.host.log.info("gh CLI keychain read failed: " + String(e));
    }
    return null;
  }

  function loadTokenFromStateFile(ctx) {
    const data = readJson(ctx, ctx.app.pluginDataDir + "/auth.json");
    if (data && data.token) {
      ctx.host.log.info("token loaded from state file");
      return { token: data.token, source: "state" };
    }
    return null;
  }

  function loadToken(ctx) {
    return (
      loadTokenFromKeychain(ctx) ||
      loadTokenFromGhCli(ctx) ||
      loadTokenFromStateFile(ctx)
    );
  }

  function makeGithubHeaders(token) {
    return {
      Authorization: "token " + token,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      "X-Github-Api-Version": API_VERSION,
    };
  }

  function fetchUsage(ctx, token) {
    return ctx.util.request({
      method: "GET",
      url: USAGE_URL,
      headers: {
        ...makeGithubHeaders(token),
        "Editor-Version": "vscode/1.96.2",
        "Editor-Plugin-Version": "copilot-chat/0.26.7",
      },
      timeoutMs: 10000,
    });
  }

  function fetchViewer(ctx, token) {
    return ctx.util.request({
      method: "GET",
      url: VIEWER_URL,
      headers: makeGithubHeaders(token),
      timeoutMs: 10000,
    });
  }

  function fetchUserBudgets(ctx, token, username) {
    return ctx.util.request({
      method: "GET",
      url: USER_BUDGETS_URL.replace("{username}", encodeURIComponent(username)),
      headers: makeGithubHeaders(token),
      timeoutMs: 10000,
    });
  }

  function toFiniteNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function loadCopilotBudgetLimitUsd(ctx) {
    const settingsPath = ctx.app.appDataDir + "/settings.json";
    const settings = readJson(ctx, settingsPath);
    const value = toFiniteNumber(settings && settings[COPILOT_BUDGET_SETTING_KEY]);
    if (value !== null && value > 0) return value;
    return DEFAULT_COPILOT_BUDGET_USD;
  }

  function hasText(value, fragment) {
    return String(value || "").toLowerCase().indexOf(fragment) >= 0;
  }

  function budgetPriority(entry) {
    let score = 0;

    if (hasText(entry && entry.name, "premium request")) score = Math.max(score, 60);
    if (hasText(entry && entry.name, "copilot")) score = Math.max(score, 50);

    const items = Array.isArray(entry && entry.budget_items) ? entry.budget_items : [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const type = String(item && item.type || "").toLowerCase();
      const target = String(item && item.target || "").toLowerCase();

      if (target.indexOf("premium request") >= 0 && type === "sku") {
        score = Math.max(score, 100);
      } else if (target.indexOf("copilot") >= 0 && type === "product") {
        score = Math.max(score, 90);
      } else if (target.indexOf("premium request") >= 0 || target.indexOf("copilot") >= 0) {
        score = Math.max(score, 80);
      }
    }

    return score;
  }

  function pickCopilotBudgetSummary(payload) {
    const list = Array.isArray(payload) ? payload : [];
    let best = null;

    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      const limit = toFiniteNumber(entry && entry.budget_limit);
      const used = toFiniteNumber(entry && entry.current_budget);
      if (limit === null || used === null || limit <= 0) continue;

      const score = budgetPriority(entry);
      if (score <= 0) continue;

      if (
        best === null ||
        score > best.score ||
        (score === best.score && limit > best.limit)
      ) {
        best = { score: score, used: used, limit: limit };
      }
    }

    return best;
  }

  function viewerLoginFromUsagePayload(data) {
    if (!data || typeof data !== "object") return null;
    const direct = data.login || data.user_login || data.username;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    if (data.user && typeof data.user.login === "string" && data.user.login.trim()) {
      return data.user.login.trim();
    }
    return null;
  }

  function fetchCopilotBudgetSummary(ctx, token, usageData) {
    let login = viewerLoginFromUsagePayload(usageData);

    if (!login) {
      const viewerResp = fetchViewer(ctx, token);
      if (viewerResp.status >= 200 && viewerResp.status < 300) {
        const viewer = ctx.util.tryParseJson(viewerResp.bodyText);
        if (viewer && typeof viewer.login === "string" && viewer.login.trim()) {
          login = viewer.login.trim();
        }
      } else {
        ctx.host.log.warn("viewer request failed for budget lookup: status=" + viewerResp.status);
      }
    }

    if (!login) return null;

    const budgetsResp = fetchUserBudgets(ctx, token, login);
    if (budgetsResp.status < 200 || budgetsResp.status >= 300) {
      ctx.host.log.warn("budget request failed: status=" + budgetsResp.status);
      return null;
    }

    const budgets = ctx.util.tryParseJson(budgetsResp.bodyText);
    if (budgets === null) {
      ctx.host.log.warn("budget response invalid json");
      return null;
    }

    return pickCopilotBudgetSummary(budgets);
  }

  function deriveBudgetSummaryFromPremiumOverage(ctx, usageData) {
    const limit = loadCopilotBudgetLimitUsd(ctx);
    const snapshots = usageData && usageData.quota_snapshots;
    const premium = snapshots && snapshots.premium_interactions;
    const remaining = toFiniteNumber(premium && premium.remaining);
    const overageRequests = remaining !== null ? Math.max(0, -remaining) : 0;
    const used = Math.round(overageRequests * COST_PER_ADDITIONAL_PREMIUM_REQUEST_USD * 100) / 100;
    return { used: used, limit: limit };
  }

  function makeProgressLine(ctx, label, snapshot, resetDate) {
    if (!snapshot || typeof snapshot.percent_remaining !== "number")
      return null;
    const usedPercent = Math.min(100, Math.max(0, 100 - snapshot.percent_remaining));
    return ctx.line.progress({
      label: label,
      used: usedPercent,
      limit: 100,
      format: { kind: "percent" },
      resetsAt: ctx.util.toIso(resetDate),
      periodDurationMs: THIRTY_DAYS_MS,
    });
  }

  function makeLimitedProgressLine(ctx, label, remaining, total, resetDate) {
    if (typeof remaining !== "number" || typeof total !== "number" || total <= 0)
      return null;
    const used = total - remaining;
    const usedPercent = Math.min(100, Math.max(0, Math.round((used / total) * 100)));
    return ctx.line.progress({
      label: label,
      used: usedPercent,
      limit: 100,
      format: { kind: "percent" },
      resetsAt: ctx.util.toIso(resetDate),
      periodDurationMs: THIRTY_DAYS_MS,
    });
  }

  function makeBudgetLine(ctx, budgetSummary, resetDate) {
    if (!budgetSummary) return null;

    const limit = toFiniteNumber(budgetSummary.limit);
    const used = toFiniteNumber(budgetSummary.used);
    if (limit === null || used === null || limit <= 0) return null;

    return ctx.line.progress({
      label: "Budget",
      used: Math.max(0, used),
      limit: limit,
      format: { kind: "dollars" },
      resetsAt: ctx.util.toIso(resetDate),
      periodDurationMs: THIRTY_DAYS_MS,
    });
  }

  function probe(ctx) {
    const cred = loadToken(ctx);
    if (!cred) {
      throw "Not logged in. Run `gh auth login` first.";
    }

    let token = cred.token;
    let source = cred.source;

    let resp;
    try {
      resp = fetchUsage(ctx, token);
    } catch (e) {
      ctx.host.log.error("usage request exception: " + String(e));
      throw "Usage request failed. Check your connection.";
    }

    if (resp.status === 401 || resp.status === 403) {
      // If cached token is stale, clear it and try fallback sources
      if (source === "keychain") {
        ctx.host.log.info("cached token invalid, trying fallback sources");
        clearCachedToken(ctx);
        const fallback = loadTokenFromGhCli(ctx);
        if (fallback) {
          try {
            resp = fetchUsage(ctx, fallback.token);
          } catch (e) {
            ctx.host.log.error("fallback usage request exception: " + String(e));
            throw "Usage request failed. Check your connection.";
          }
          if (resp.status >= 200 && resp.status < 300) {
            // Fallback worked, persist the new token
            saveToken(ctx, fallback.token);
            token = fallback.token;
            source = fallback.source;
          }
        }
      }
      // Still failing after retry
      if (resp.status === 401 || resp.status === 403) {
        throw "Token invalid. Run `gh auth login` to re-authenticate.";
      }
    }

    if (resp.status < 200 || resp.status >= 300) {
      ctx.host.log.error("usage returned error: status=" + resp.status);
      throw (
        "Usage request failed (HTTP " +
        String(resp.status) +
        "). Try again later."
      );
    }

    // Persist gh-cli token to OpenUsage keychain for future use
    if (source === "gh-cli") {
      saveToken(ctx, token);
    }

    const data = ctx.util.tryParseJson(resp.bodyText);
    if (data === null) {
      throw "Usage response invalid. Try again later.";
    }

    ctx.host.log.info("usage fetch succeeded");

    const lines = [];
    let plan = null;
    if (data.copilot_plan) {
      plan = ctx.fmt.planLabel(data.copilot_plan);
    }

    // Paid tier: quota_snapshots
    const snapshots = data.quota_snapshots;
    if (snapshots) {
      let budgetSummary = null;
      try {
        budgetSummary = fetchCopilotBudgetSummary(ctx, token, data);
      } catch (e) {
        ctx.host.log.warn("budget lookup failed: " + String(e));
      }
      if (!budgetSummary) {
        budgetSummary = deriveBudgetSummaryFromPremiumOverage(ctx, data);
      }

      const premiumLine = makeProgressLine(
        ctx,
        "Premium",
        snapshots.premium_interactions,
        data.quota_reset_date,
      );
      if (premiumLine) lines.push(premiumLine);

      const budgetLine = makeBudgetLine(ctx, budgetSummary, data.quota_reset_date);
      if (budgetLine) lines.push(budgetLine);
    }

    // Free tier: limited_user_quotas
    if (data.limited_user_quotas && data.monthly_quotas) {
      const lq = data.limited_user_quotas;
      const mq = data.monthly_quotas;
      const resetDate = data.limited_user_reset_date;

      const chatLine = makeLimitedProgressLine(ctx, "Chat", lq.chat, mq.chat, resetDate);
      if (chatLine) lines.push(chatLine);

      const completionsLine = makeLimitedProgressLine(ctx, "Completions", lq.completions, mq.completions, resetDate);
      if (completionsLine) lines.push(completionsLine);
    }

    if (lines.length === 0) {
      lines.push(
        ctx.line.badge({
          label: "Status",
          text: "No usage data",
          color: "#a3a3a3",
        }),
      );
    }

    return { plan: plan, lines: lines };
  }

  globalThis.__openusage_plugin = { id: "copilot", probe };
})();
