import { ofetch } from 'ofetch'
import type { EquipmentNode } from '../types/domain'

const apiBase = import.meta.env.NUXT_PUBLIC_API_BASE_URL as string | undefined
const client = ofetch.create({ baseURL: apiBase || '/api', timeout: 5000 })

export async function loadEquipmentSnapshot(fallback: EquipmentNode[]): Promise<EquipmentNode[]> {
  if (!apiBase) return fallback
  try { return await client<EquipmentNode[]>('/acceptance/equipment') } catch { return fallback }
}

export async function validateEvidencePackage(payload: unknown) {
  if (!apiBase) return { accepted: true, packageId: `LOCAL-${Date.now()}` }
  return client('/acceptance/validate-package', { method: 'POST', body: payload as Record<string, unknown> })
}
