import { ipcMain, shell } from 'electron'
import { z } from 'zod'
import { auditDir } from './audit'
import { clientConfig, regenerate, setEnabled, setOptions, status, tokenValue } from '.'

/**
 * The five-and-a-bit channels the Settings pane uses.
 *
 * Their own file rather than lines in `registerIpc()`: they are the ONE part of
 * the MCP feature the renderer talks to, and none of them belongs in the
 * registry — the registry is the agent-reachable surface, and an agent being
 * able to turn its own permission level up would defeat the point of having one.
 */

const optionsSchema = z.object({
  // 1024 and up: binding a privileged port would need the app to be root, and
  // asking for one is a misconfiguration worth naming rather than an EACCES.
  port: z.number().int().min(1024).max(65_535).optional(),
  bindLan: z.boolean().optional(),
  allowWrite: z.boolean().optional(),
  allowDestructive: z.boolean().optional()
})

const variantSchema = z.enum(['claude', 'vscode', 'stdio'])

export function registerMcpIpc(): void {
  ipcMain.handle('mcp:status', () => status())
  ipcMain.handle('mcp:setEnabled', (_e, enabled: unknown) =>
    setEnabled(z.boolean().parse(enabled))
  )
  ipcMain.handle('mcp:setOptions', (_e, options: unknown) => setOptions(optionsSchema.parse(options)))
  ipcMain.handle('mcp:token', () => tokenValue())
  ipcMain.handle('mcp:regenerateToken', () => regenerate())
  ipcMain.handle('mcp:clientConfig', (_e, variant: unknown) =>
    clientConfig(variantSchema.parse(variant))
  )
  ipcMain.handle('mcp:openAuditDir', async () => {
    await shell.openPath(auditDir())
  })
}
