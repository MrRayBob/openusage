# Changelog

## 0.6.5 - 2026-02-18

### Copilot Budget Tracking
- Replaced paid Copilot `Chat` usage line with a `Budget` line.
- Added fallback budget math when billing APIs are unavailable:
  - `spent = max(0, -premium_remaining) * 0.04`
- Budget line now reflects dollar spend/limit in the same progress UI.

### Settings
- Added a new app setting: `Copilot Budget` (USD).
- Default Copilot budget is `$40`.
- Fallback budget line reads this setting to compute remaining budget.

### Reliability
- Updated Copilot GitHub API version header to the supported value (`2022-11-28`) to avoid request failures on newer unsupported versions.
