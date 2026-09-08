import { monthlyTrends } from '../../../metrics/monthly'

export default defineEventHandler(async () => monthlyTrends(useAppDatabase()))
