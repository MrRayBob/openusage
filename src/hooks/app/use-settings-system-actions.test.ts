import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  getEnabledPluginIdsMock,
  invokeMock,
  saveAutoUpdateIntervalMock,
  saveCopilotBudgetUsdMock,
  saveGlobalShortcutMock,
  saveStartOnLoginMock,
  trackMock,
} = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getEnabledPluginIdsMock: vi.fn(),
  saveAutoUpdateIntervalMock: vi.fn(),
  saveCopilotBudgetUsdMock: vi.fn(),
  saveGlobalShortcutMock: vi.fn(),
  saveStartOnLoginMock: vi.fn(),
  invokeMock: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

vi.mock("@/lib/analytics", () => ({
  track: trackMock,
}))

vi.mock("@/lib/settings", () => ({
  getEnabledPluginIds: getEnabledPluginIdsMock,
  saveAutoUpdateInterval: saveAutoUpdateIntervalMock,
  saveCopilotBudgetUsd: saveCopilotBudgetUsdMock,
  saveGlobalShortcut: saveGlobalShortcutMock,
  saveStartOnLogin: saveStartOnLoginMock,
}))

import { useSettingsSystemActions } from "@/hooks/app/use-settings-system-actions"

describe("useSettingsSystemActions", () => {
  beforeEach(() => {
    trackMock.mockReset()
    getEnabledPluginIdsMock.mockReset()
    saveAutoUpdateIntervalMock.mockReset()
    saveCopilotBudgetUsdMock.mockReset()
    saveGlobalShortcutMock.mockReset()
    saveStartOnLoginMock.mockReset()
    invokeMock.mockReset()

    getEnabledPluginIdsMock.mockImplementation((settings: { order: string[]; disabled: string[] }) =>
      settings.order.filter((id) => !settings.disabled.includes(id))
    )
    saveAutoUpdateIntervalMock.mockResolvedValue(undefined)
    saveCopilotBudgetUsdMock.mockResolvedValue(undefined)
    saveGlobalShortcutMock.mockResolvedValue(undefined)
    saveStartOnLoginMock.mockResolvedValue(undefined)
    invokeMock.mockResolvedValue(undefined)
  })

  it("updates auto refresh schedule when at least one plugin is enabled", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000)
    const setAutoUpdateInterval = vi.fn()
    const setAutoUpdateNextAt = vi.fn()

    const { result } = renderHook(() =>
      useSettingsSystemActions({
        pluginSettings: { order: ["codex"], disabled: [] },
        setAutoUpdateInterval,
        setAutoUpdateNextAt,
        setCopilotBudgetUsd: vi.fn(),
        setGlobalShortcut: vi.fn(),
        setStartOnLogin: vi.fn(),
        applyStartOnLogin: vi.fn().mockResolvedValue(undefined),
      })
    )

    act(() => {
      result.current.handleAutoUpdateIntervalChange(15)
    })

    expect(trackMock).toHaveBeenCalledWith("setting_changed", { setting: "auto_refresh", value: "15" })
    expect(setAutoUpdateInterval).toHaveBeenCalledWith(15)
    expect(setAutoUpdateNextAt).toHaveBeenCalledWith(910_000)
    expect(saveAutoUpdateIntervalMock).toHaveBeenCalledWith(15)
    nowSpy.mockRestore()
  })

  it("clears next refresh when no enabled plugins remain", () => {
    const setAutoUpdateNextAt = vi.fn()

    const { result } = renderHook(() =>
      useSettingsSystemActions({
        pluginSettings: { order: ["codex"], disabled: ["codex"] },
        setAutoUpdateInterval: vi.fn(),
        setAutoUpdateNextAt,
        setCopilotBudgetUsd: vi.fn(),
        setGlobalShortcut: vi.fn(),
        setStartOnLogin: vi.fn(),
        applyStartOnLogin: vi.fn().mockResolvedValue(undefined),
      })
    )

    act(() => {
      result.current.handleAutoUpdateIntervalChange(30)
    })

    expect(setAutoUpdateNextAt).toHaveBeenCalledWith(null)
  })

  it("updates shortcut and start-on-login settings", () => {
    const setGlobalShortcut = vi.fn()
    const setStartOnLogin = vi.fn()
    const setCopilotBudgetUsd = vi.fn()
    const applyStartOnLogin = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useSettingsSystemActions({
        pluginSettings: null,
        setAutoUpdateInterval: vi.fn(),
        setAutoUpdateNextAt: vi.fn(),
        setCopilotBudgetUsd,
        setGlobalShortcut,
        setStartOnLogin,
        applyStartOnLogin,
      })
    )

    act(() => {
      result.current.handleGlobalShortcutChange("CommandOrControl+Shift+O")
      result.current.handleStartOnLoginChange(true)
      result.current.handleCopilotBudgetUsdChange(55)
    })

    expect(trackMock).toHaveBeenCalledWith("setting_changed", {
      setting: "global_shortcut",
      value: "CommandOrControl+Shift+O",
    })
    expect(trackMock).toHaveBeenCalledWith("setting_changed", {
      setting: "start_on_login",
      value: "true",
    })
    expect(trackMock).toHaveBeenCalledWith("setting_changed", {
      setting: "copilot_budget_usd",
      value: "55",
    })

    expect(setGlobalShortcut).toHaveBeenCalledWith("CommandOrControl+Shift+O")
    expect(saveGlobalShortcutMock).toHaveBeenCalledWith("CommandOrControl+Shift+O")
    expect(invokeMock).toHaveBeenCalledWith("update_global_shortcut", {
      shortcut: "CommandOrControl+Shift+O",
    })

    expect(setStartOnLogin).toHaveBeenCalledWith(true)
    expect(saveStartOnLoginMock).toHaveBeenCalledWith(true)
    expect(applyStartOnLogin).toHaveBeenCalledWith(true)

    expect(setCopilotBudgetUsd).toHaveBeenCalledWith(55)
    expect(saveCopilotBudgetUsdMock).toHaveBeenCalledWith(55)
  })

  it("logs persistence/update failures", async () => {
    const autoError = new Error("auto save failed")
    const shortcutSaveError = new Error("shortcut save failed")
    const shortcutInvokeError = new Error("shortcut invoke failed")
    const startOnLoginSaveError = new Error("start on login save failed")
    const startOnLoginApplyError = new Error("start on login apply failed")
    const copilotBudgetSaveError = new Error("copilot budget save failed")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    saveAutoUpdateIntervalMock.mockRejectedValueOnce(autoError)
    saveGlobalShortcutMock.mockRejectedValueOnce(shortcutSaveError)
    invokeMock.mockRejectedValueOnce(shortcutInvokeError)
    saveStartOnLoginMock.mockRejectedValueOnce(startOnLoginSaveError)
    saveCopilotBudgetUsdMock.mockRejectedValueOnce(copilotBudgetSaveError)
    const applyStartOnLogin = vi.fn().mockRejectedValueOnce(startOnLoginApplyError)

    const { result } = renderHook(() =>
      useSettingsSystemActions({
        pluginSettings: null,
        setAutoUpdateInterval: vi.fn(),
        setAutoUpdateNextAt: vi.fn(),
        setCopilotBudgetUsd: vi.fn(),
        setGlobalShortcut: vi.fn(),
        setStartOnLogin: vi.fn(),
        applyStartOnLogin,
      })
    )

    act(() => {
      result.current.handleAutoUpdateIntervalChange(5)
      result.current.handleGlobalShortcutChange(null)
      result.current.handleStartOnLoginChange(false)
      result.current.handleCopilotBudgetUsdChange(40)
    })

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith("Failed to save auto-update interval:", autoError)
      expect(errorSpy).toHaveBeenCalledWith("Failed to save global shortcut:", shortcutSaveError)
      expect(errorSpy).toHaveBeenCalledWith("Failed to update global shortcut:", shortcutInvokeError)
      expect(errorSpy).toHaveBeenCalledWith("Failed to save start on login:", startOnLoginSaveError)
      expect(errorSpy).toHaveBeenCalledWith("Failed to update start on login:", startOnLoginApplyError)
      expect(errorSpy).toHaveBeenCalledWith("Failed to save copilot budget:", copilotBudgetSaveError)
    })

    errorSpy.mockRestore()
  })
})
