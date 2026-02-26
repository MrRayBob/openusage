import type { PluginMeta, PluginOutput } from "@/lib/plugin-types"
import type { PluginSettings } from "@/lib/settings"
import { DEFAULT_DISPLAY_MODE, type DisplayMode } from "@/lib/settings"
import { clamp01 } from "@/lib/utils"

type PluginState = {
  data: PluginOutput | null
  loading: boolean
  error: string | null
}

export type TrayPrimaryBar = {
  id: string
  fraction?: number
}

type ProgressLine = Extract<
  PluginOutput["lines"][number],
  { type: "progress"; label: string; used: number; limit: number }
>

function isProgressLine(line: PluginOutput["lines"][number]): line is ProgressLine {
  return line.type === "progress"
}

function findProgressLine(data: PluginOutput, label: string): ProgressLine | undefined {
  return data.lines.find(
    (line): line is ProgressLine =>
      isProgressLine(line) && line.label === label
  )
}

function getFractionFromProgressLine(line: ProgressLine, displayMode: DisplayMode): number | undefined {
  if (line.limit <= 0) return undefined
  const shownAmount =
    displayMode === "used"
      ? line.used
      : line.limit - line.used
  return clamp01(shownAmount / line.limit)
}

export function getTrayPrimaryBars(args: {
  pluginsMeta: PluginMeta[]
  pluginSettings: PluginSettings | null
  pluginStates: Record<string, PluginState | undefined>
  maxBars?: number
  displayMode?: DisplayMode
  pluginId?: string
}): TrayPrimaryBar[] {
  const {
    pluginsMeta,
    pluginSettings,
    pluginStates,
    maxBars = 4,
    displayMode = DEFAULT_DISPLAY_MODE,
    pluginId,
  } = args
  if (!pluginSettings) return []

  const metaById = new Map(pluginsMeta.map((p) => [p.id, p]))
  const disabled = new Set(pluginSettings.disabled)
  const orderedIds = pluginId
    ? [pluginId]
    : pluginSettings.order

  const out: TrayPrimaryBar[] = []
  for (const id of orderedIds) {
    if (disabled.has(id)) continue
    const meta = metaById.get(id)
    if (!meta) continue
    
    // Skip if no primary candidates defined
    if (!meta.primaryCandidates || meta.primaryCandidates.length === 0) continue

    const state = pluginStates[id]
    const data = state?.data ?? null

    let fraction: number | undefined
    if (data) {
      // Find first candidate that exists in runtime data
      const primaryLabel = meta.primaryCandidates.find((label) =>
        data.lines.some((line) => isProgressLine(line) && line.label === label)
      )
      if (primaryLabel) {
        const primaryLine = findProgressLine(data, primaryLabel)
        if (primaryLine) {
          const shouldUseCopilotBudgetFallback =
            id === "copilot" &&
            primaryLine.label === "Premium" &&
            primaryLine.used >= primaryLine.limit

          if (shouldUseCopilotBudgetFallback) {
            const budgetLine = findProgressLine(data, "Budget")
            if (budgetLine && budgetLine.limit > 0) {
              // Keep tray bars consistent with the global display mode when premium is exhausted.
              fraction = getFractionFromProgressLine(budgetLine, displayMode)
            } else {
              fraction = getFractionFromProgressLine(primaryLine, displayMode)
            }
          } else {
            fraction = getFractionFromProgressLine(primaryLine, displayMode)
          }
        }
      }
    }

    out.push({ id, fraction })
    if (out.length >= maxBars) break
  }

  return out
}
