// Shapes of the stock-list audit report, shared by server and page.
import type { FindingGroup, SupplierPrice } from './savings'
import type { BaseUnit } from './units'

export interface ReportItem {
  id: string
  raw_name: string
  product_id: string | null
  product_name: string | null
  base_unit: BaseUnit | null
  group: FindingGroup
  annual_saving: number | null
  weekly_quantity: number | null
  current: SupplierPrice | null
  cheapest: SupplierPrice | null
  pct_cheaper: number | null
  creep_pct: number | null
  /** Price comparison in the current supplier's pack, for display and emails. */
  pack_label: string | null
  your_pack_price: number | null
  best_pack_price: number | null
  used_stock_price: boolean
  used_stock_quantity: boolean
}

export interface AuditReport {
  upload_id: string
  file_name: string | null
  total_annual_saving: number
  items_with_saving: number
  suppliers_with_saving: number
  item_count: number
  groups: Array<{ group: FindingGroup; items: Array<ReportItem> }>
}
